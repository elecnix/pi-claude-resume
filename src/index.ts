/**
 * pi extension entry point.
 *
 * The only module that touches the pi extension API: register the flags, on `session_start`
 * hand the runtime to the bridge, and report the outcome (DP3, DP8, DP11).
 *
 * No business logic lives here (DP3): locating, parsing, rendering and idempotency all belong to
 * `src/bridge/inject.ts`. This module only adapts pi's runtime to the `BridgeHost` contract and
 * turns a `BridgeResult` into a notification (or, in a non-interactive mode, one stderr line and
 * an immediate exit with status 1).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeClaudeSession } from "./bridge/inject.ts";
import { claudeProjectsRoot } from "./cli/env.ts";
import { readClaudeFlags, registerClaudeFlags } from "./cli/flag.ts";
import { describeParseLoss } from "./shared/diagnostics.ts";
import { TRANSCRIPT_CUSTOM_TYPE, type BridgeHost, type BridgeResult } from "./types.ts";

/** Key used for the footer status line set on a successful import. */
const STATUS_KEY = "claude-resume";

export default function piClaudeResume(pi: ExtensionAPI): void {
	registerClaudeFlags((name, options) => pi.registerFlag(name, options));

	pi.on("session_start", async (_event, ctx) => {
		const { spec, maxChars, force } = readClaudeFlags((name) => pi.getFlag(name));
		// Without `--claude` this extension does nothing at all: no I/O, no notification (DP1).
		if (spec === undefined) return;

		const host: BridgeHost = {
			cwd: ctx.cwd,
			// Claude Code's own config root, when it has been relocated with CLAUDE_CONFIG_DIR;
			// undefined leaves locate() on its `<home>/.claude/projects` default (DP4).
			projectsRoot: claudeProjectsRoot(),
			piTools: pi.getActiveTools(),
			hasInjected: (sessionId) => hasInjectedTranscript(ctx, sessionId),
			sendCustomMessage: async (message) => {
				await pi.sendMessage(message);
			},
		};

		let result: BridgeResult;
		try {
			result = await resumeClaudeSession(host, { spec, maxChars, force });
		} catch (error) {
			// The bridge reports failures in its result; a throw means something escaped it. It is
			// still a failed resume, so it must be visible rather than swallowed (DP11).
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Claude resume failed: ${message}`, "error");
			if (isNonInteractive(ctx)) failRun(`pi-claude-resume: bridge-error: ${message}`);
			return;
		}

		if (!result.ok) {
			const code = result.error?.code ?? "unknown";
			const message = result.error?.message ?? "resume failed without a diagnostic";
			ctx.ui.notify(`Claude resume failed: ${message}`, "error");
			// DP11: in `pi -p` / `--mode json` the run must stop before the model is called, instead
			// of answering without the history and exiting 0.
			if (isNonInteractive(ctx)) failRun(`pi-claude-resume: ${code}: ${message}`);
			return;
		}

		if (result.messagesSent === 0) {
			// DP10: already imported in this pi session — say so once and stay quiet.
			ctx.ui.notify(`Claude session ${result.sessionId ?? spec} already imported`, "info");
			return;
		}

		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, summarize(result));
		ctx.ui.notify(describeImported(result), "info");
	});
}

/** True in the modes where pi has no interactive UI and a failure must fail the process (DP11). */
function isNonInteractive(ctx: ExtensionContext): boolean {
	return ctx.mode === "print" || ctx.mode === "json";
}

/**
 * Fail a non-interactive run: one diagnostic line on stderr, then exit with status 1 (DP11).
 *
 * Throwing is not enough. pi dispatches `session_start` through the extension runner, which
 * reports a thrown handler error through its `onError` callback ("Extension error (…): …") and
 * then carries on with the prompt, so `pi -p` would answer without the history and exit 0 — the
 * exact half-resume DP11 forbids. Setting `process.exitCode` does not stop the prompt either.
 * Only ending the process does, and it has to happen here, before the first model call.
 *
 * The line is written before exiting because nothing after `process.exit` runs: a failure a user
 * cannot read is a silent failure. The throw that follows is unreachable in a real run (and
 * keeps the `never` return type honest for callers and stubbed exits alike).
 */
function failRun(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
	throw new Error(message);
}

/** One-line footer summary, kept short because it competes for space with pi's own status. */
function summarize(result: BridgeResult): string {
	const messages = `${result.messagesSent} message${result.messagesSent === 1 ? "" : "s"}`;
	const truncated = result.truncated ? ", truncated" : "";
	return `resumed ${result.sessionId ?? "Claude session"} (${messages}${truncated})`;
}

/** Info notification for a successful import (DP8, DP9: truncation and parse loss are never silent). */
function describeImported(result: BridgeResult): string {
	const parts = [`Imported ${summarize(result)}`];
	if (typeof result.turns === "number") parts.push(`${result.turns} turns`);
	if (typeof result.chars === "number") parts.push(`${result.chars} chars`);
	if (result.truncated) parts.push(describeTruncation(result));
	// Counted parse losses are named in the same breath as the success, so a half-parsed file is
	// never reported as a clean import (DP9). Nothing is added when the parse was lossless.
	if (result.parseStats !== undefined) parts.push(...describeParseLoss(result.parseStats));
	return parts.join("; ");
}

/** Truncation is reported, never silent (DP9). */
function describeTruncation(result: BridgeResult): string {
	const budget = "transcript truncated to fit the budget";
	const turns = result.droppedTurns ?? 0;
	return turns > 0
		? `${budget}: ${turns} turn${turns === 1 ? "" : "s"} dropped`
		: budget;
}

/**
 * True when this pi session already carries the transcript for `sessionId` (DP10).
 *
 * pi records `sendMessage()` as a `CustomMessageEntry` (`type: "custom_message"`); a custom
 * message can also surface as a `message` entry whose message has `role: "custom"`. Both are
 * checked, and every field is guarded: session files are user-authored data, so a shape this
 * function does not recognise must read as "not imported", never throw (DP11).
 */
function hasInjectedTranscript(ctx: ExtensionContext, sessionId: string): boolean {
	let entries: unknown;
	try {
		entries = ctx.sessionManager.getEntries();
	} catch {
		return false;
	}
	if (!Array.isArray(entries)) return false;
	return entries.some((entry) => isTranscriptEntryFor(entry, sessionId));
}

function isTranscriptEntryFor(entry: unknown, sessionId: string): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const record = entry as Record<string, unknown>;

	if (record.type === "custom_message") {
		return record.customType === TRANSCRIPT_CUSTOM_TYPE && readDetailsSessionId(record.details) === sessionId;
	}

	if (record.type === "message") {
		const message = record.message;
		if (typeof message !== "object" || message === null) return false;
		const inner = message as Record<string, unknown>;
		return (
			inner.role === "custom" &&
			inner.customType === TRANSCRIPT_CUSTOM_TYPE &&
			readDetailsSessionId(inner.details) === sessionId
		);
	}

	return false;
}

/** The Claude session id the bridge stored in `details`, when it is a non-empty string. */
function readDetailsSessionId(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const value = (details as Record<string, unknown>).sessionId;
	return typeof value === "string" && value !== "" ? value : undefined;
}
