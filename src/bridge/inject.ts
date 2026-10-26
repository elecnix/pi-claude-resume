/**
 * Bridge orchestration: locate -> parse -> render -> boundary -> inject (DP1, DP10, DP11).
 *
 * This is the module `src/index.ts` hands pi's runtime to. It is the only place that knows the
 * order of the steps and the only place allowed to talk to the host; every decision it makes is
 * delegated to a pure module under `src/claude/`, which keeps it testable with a fake host and no
 * model, terminal, or Claude installation (DP3).
 *
 * The side effects are exactly four: one `readFile` of the located session file (DP4: read-only),
 * two host `sendCustomMessage` calls, and one host `notify`. Nothing here imports the pi API, so
 * the module itself stays pi-free; pi-shaped behaviour arrives through `BridgeHost`.
 *
 * Failure model (DP11): every outcome is a `BridgeResult` and nothing is thrown. A failure returns
 * `ok: false` with a code and one-line message, notifies once at `error`, and sends no transcript
 * message — a session that cannot be located, read, parsed or rendered is left untouched rather
 * than half-resumed.
 */
import { readFile } from "node:fs/promises";

import { buildBoundaryMessage } from "../claude/boundary.ts";
import { locateClaudeSession } from "../claude/locate.ts";
import { parseClaudeSession } from "../claude/parse.ts";
import { renderTranscript } from "../claude/render.ts";
import { mapToolCall } from "../claude/toolmap.ts";
import { describeParseLoss } from "../shared/diagnostics.ts";
import {
	BOUNDARY_CUSTOM_TYPE,
	TRANSCRIPT_CUSTOM_TYPE,
	type BridgeHost,
	type BridgeOptions,
	type BridgeResult,
	type ClaudeSessionMeta,
	type ClaudeTranscript,
	type ClaudeTurn,
	type LocateResult,
	type RenderResult,
} from "../types.ts";

/** The message shape the host accepts, kept in sync with `BridgeHost` instead of restated. */
type HostMessage = Parameters<BridgeHost["sendCustomMessage"]>[0];

/** A located session, narrowed out of the `LocateResult` union. */
type LocatedSession = Extract<LocateResult, { ok: true }>;

/**
 * A failure with a code, raised inside the orchestration and turned into a `BridgeResult` by
 * `resumeClaudeSession`. `messagesSent` records how much of the injection had already happened.
 */
class BridgeError extends Error {
	readonly code: string;
	readonly messagesSent: number;

	constructor(code: string, message: string, messagesSent = 0) {
		super(message);
		this.name = "BridgeError";
		this.code = code;
		this.messagesSent = messagesSent;
	}
}

/**
 * Import a Claude Code session into the current pi session.
 *
 * Resolves the `--claude` spec, skips when this pi session already carries the transcript (DP10),
 * then injects the rendered history followed by the boundary notice (DP8). Never rejects.
 */
export async function resumeClaudeSession(
	host: BridgeHost,
	options: BridgeOptions,
): Promise<BridgeResult> {
	try {
		return await runBridge(host, options);
	} catch (error) {
		const failure = toFailure(error);
		notifySafely(host, `${failure.code}: ${failure.message}`, "error");
		return {
			ok: false,
			messagesSent: failure.messagesSent,
			error: { code: failure.code, message: failure.message },
		};
	}
}

/** The happy path and the failures that are part of it; the outer wrapper turns throws into results. */
async function runBridge(host: BridgeHost, options: BridgeOptions): Promise<BridgeResult> {
	// 1. Validate before anything touches the filesystem, so a bare `--claude` cannot fail with a
	//    confusing not-found (DP5).
	const spec = readSpec(options);

	// 2. Resolve `--claude` to exactly one session, or fail loudly with the candidates (DP5).
	const located = locateClaudeSession({
		spec,
		cwd: host.cwd,
		homeDir: host.homeDir,
		projectsRoot: host.projectsRoot,
	});
	if (!located.ok) {
		throw new BridgeError(located.code, located.message);
	}

	// 3. Idempotency: a pi session that already imported this id is left alone (DP10). Nothing is
	//    read, sent or notified — re-running pi must be indistinguishable from a no-op.
	if (!options.force && host.hasInjected(located.sessionId)) {
		return {
			ok: true,
			sessionId: located.sessionId,
			sessionPath: located.path,
			messagesSent: 0,
			truncated: false,
		};
	}

	// 4. One read-only read of the one file (DP4), then a parse that never throws on bad input.
	const raw = await readSessionFile(located.path);
	const transcript = parseSession(raw, located);

	// 5. Render the bounded transcript (DP9) and the boundary notice (DP8).
	const meta = normalizeMeta(transcript.meta, located);
	const rendered = renderTranscript(transcript, {
		maxChars: options.maxChars,
		mapTool: mapToolCall,
	});
	const boundary = buildBoundaryMessage({
		meta,
		piTools: host.piTools,
		claudeTools: claudeToolNames(transcript.turns),
		rendered,
	});

	// 6. Transcript first, boundary second: the notice must be the last thing the model reads.
	await sendMessage(
		host,
		{
			customType: TRANSCRIPT_CUSTOM_TYPE,
			content: rendered.text,
			// The imported history is context, not something the user typed: keep the UI quiet and
			// let the boundary notice be the visible marker of the import (DR3).
			display: false,
			details: {
				sessionId: meta.sessionId,
				sessionPath: meta.path,
				chars: rendered.chars,
				truncated: rendered.truncated,
				droppedTurns: rendered.droppedTurns,
				// The parse counters travel with the transcript so a later reader can audit what the
				// import dropped instead of trusting a summary (DP9: never silent).
				parseStats: transcript.stats,
			},
		},
		0,
	);
	await sendMessage(
		host,
		{
			customType: BOUNDARY_CUSTOM_TYPE,
			content: boundary,
			display: true,
		},
		1,
	);

	// 7. Exactly one success notification, after the session is actually complete.
	notifySafely(host, summaryMessage(meta, transcript, rendered), "info");

	return {
		ok: true,
		sessionId: meta.sessionId,
		sessionPath: meta.path,
		sourceCwd: meta.cwd,
		title: meta.title,
		turns: transcript.turns.length,
		chars: rendered.chars,
		estimatedTokens: rendered.estimatedTokens,
		truncated: rendered.truncated,
		parseStats: transcript.stats,
		messagesSent: 2,
	};
}

/** Trimmed, non-empty `--claude` value, or `invalid-spec`. */
function readSpec(options: BridgeOptions): string {
	const spec = typeof options.spec === "string" ? options.spec.trim() : "";
	if (spec.length === 0) {
		throw new BridgeError(
			"invalid-spec",
			'no Claude Code session given: expected a session id, an absolute path, or "latest"',
		);
	}
	return spec;
}

/** Read the located file as UTF-8; any failure is `unreadable`. */
async function readSessionFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		throw new BridgeError(
			"unreadable",
			`could not read the Claude Code session file ${path}: ${describeError(error)}`,
		);
	}
}

/** Parse the raw file, treating a session with no conversation as a failure rather than an import. */
function parseSession(raw: string, located: LocatedSession): ClaudeTranscript {
	const transcript = parseClaudeSession(raw, {
		path: located.path,
		sessionId: located.sessionId,
	}).transcript;
	if (!Array.isArray(transcript?.turns) || transcript.turns.length === 0) {
		throw new BridgeError(
			"empty-session",
			"the Claude Code session file has no conversation to resume",
		);
	}
	return transcript;
}

/**
 * Fill the identity fields the parser could not read from the file itself. Nothing is invented:
 * the fallbacks come from the located file, which is where the id and path came from.
 */
function normalizeMeta(meta: ClaudeSessionMeta, located: LocatedSession): ClaudeSessionMeta {
	return {
		...meta,
		sessionId: nonEmpty(meta.sessionId) ?? located.sessionId,
		path: nonEmpty(meta.path) ?? located.path,
	};
}

/** Claude tool names in first-appearance order, for the boundary notice (DP8). */
function claudeToolNames(turns: readonly ClaudeTurn[]): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const turn of turns) {
		if (turn.kind !== "assistant") {
			continue;
		}
		for (const call of turn.tools) {
			if (seen.has(call.claudeName)) {
				continue;
			}
			seen.add(call.claudeName);
			names.push(call.claudeName);
		}
	}
	return names;
}

/** Send one custom message, tagging a host rejection with how much was already injected. */
async function sendMessage(
	host: BridgeHost,
	message: HostMessage,
	sentBefore: number,
): Promise<void> {
	try {
		await host.sendCustomMessage(message);
	} catch (error) {
		throw new BridgeError(
			"internal",
			`could not inject the ${message.customType} message: ${describeError(error)}`,
			sentBefore,
		);
	}
}

/** The one-line success summary: what was resumed and how much of it was injected. */
function summaryMessage(
	meta: ClaudeSessionMeta,
	transcript: ClaudeTranscript,
	rendered: RenderResult,
): string {
	const turns = transcript.turns.length;
	const words = [
		`resumed Claude Code session ${meta.sessionId}`,
		`${turns} turn${turns === 1 ? "" : "s"}`,
		`${rendered.chars} chars (~${rendered.estimatedTokens} tokens)`,
		describeTruncation(rendered),
	];
	// A half-parsed file must not be announced as a clean import (DP9, DP11).
	words.push(...describeParseLoss(transcript.stats));
	return words.join(" · ");
}

/** Truncation is reported, never silent (DP9). */
function describeTruncation(rendered: RenderResult): string {
	if (!rendered.truncated) {
		return "complete";
	}
	return rendered.droppedTurns > 0
		? `truncated, ${rendered.droppedTurns} turns dropped`
		: "truncated";
}

/** Normalise any thrown value into the result's error branch. */
function toFailure(error: unknown): { code: string; message: string; messagesSent: number } {
	if (error instanceof BridgeError) {
		return { code: error.code, message: error.message, messagesSent: error.messagesSent };
	}
	return { code: "internal", message: describeError(error), messagesSent: 0 };
}

/** A message for an unknown thrown value, including the `throw "string"` case. */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		return message.length > 0 ? message : error.name;
	}
	if (typeof error === "string" && error.trim().length > 0) {
		return error.trim();
	}
	return "unknown error";
}

/** Notify the user, without letting a broken notifier turn a finished import into a failure. */
function notifySafely(host: BridgeHost, message: string, level: "info" | "error"): void {
	try {
		host.notify(message, level);
	} catch {
		// A notification is a courtesy, not part of the resume. Swallowing it keeps `ok` honest
		// about what reached the session (DP11 keeps "imported" and "failed" disjoint).
	}
}

/** Trimmed string, or undefined when absent/blank. */
function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
