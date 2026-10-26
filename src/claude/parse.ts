/**
 * Parse a Claude Code session (JSONL) into a normalized, tool-agnostic transcript.
 *
 * Pure and synchronous: no clock, no filesystem, no network, no pi imports (DP3). Every
 * filtering decision is a counter, never an exception — a session that only half-parses is
 * reported through `stats` and `warnings` so the caller can fail visibly (DP11) instead of
 * injecting a silently truncated history. Tool names are preserved exactly as Claude Code
 * recorded them; translation belongs to the mapping table, not to parsing (DP7, DR4).
 *
 * Each well-formed entry lands in exactly one statistics bucket, so
 * `parsedEntries + skippedEntries + droppedSidechains + droppedMeta + droppedApiErrors +
 * malformedLines === rawLines` holds for every input (DP6, DP13).
 */
import { basename } from "node:path";

import type {
	ClaudeRawEntry,
	ClaudeRawMessage,
	ClaudeSessionMeta,
	ClaudeToolCall,
	ClaudeTranscript,
	ClaudeTurn,
	ParseStats,
} from "../types.ts";

export interface ParseOptions {
	/** Absolute path of the source file; recorded in meta only. */
	path: string;
	/** Fallback session id when the entries do not carry one (the file name). */
	sessionId?: string;
}

export interface ParseResult {
	transcript: ClaudeTranscript;
	/** Non-fatal problems, surfaced to the user in verbose mode. */
	warnings: string[];
}

/**
 * Bookkeeping entry types Claude Code writes next to the conversation proper. They carry no
 * turn the model can continue from, so they are dropped and counted (DP6).
 */
const SKIPPED_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"attachment",
	"file-history-snapshot",
	"mode",
	"permission-mode",
	"ai-title",
	"atis-latch",
	"api-request",
	"api-request-blob",
	"api-request-shape",
	"last-prompt",
]);

/**
 * `<system-reminder>` injections (tool descriptions, todo nudges, environment notes) are pi's
 * own business, not conversation: they are stripped from user text rather than imported (DP6).
 * Case-insensitive and non-greedy, with `.` matching newlines, because a reminder may span lines
 * and may have been written in a different case.
 */
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asMessage(value: unknown): ClaudeRawMessage | undefined {
	return isRecord(value) ? (value as ClaudeRawMessage) : undefined;
}

/**
 * Keep a timestamp only when it parses. Meta's `first/lastTimestamp` compare raw strings, so a
 * value `Date.parse` rejects is not allowed through to skew the window.
 */
function timestampOf(value: unknown): string | undefined {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
		return undefined;
	}
	return value;
}

/** Remove every system-reminder segment, then the whitespace it leaves behind. */
function stripSystemReminders(text: string): string {
	return text.replace(SYSTEM_REMINDER_PATTERN, "").trim();
}

/**
 * Attach `timestamp` only when the source carried a valid one, so a turn is exactly the fields
 * it earned rather than a shape padded with `undefined` (DP6: nothing is invented).
 */
function withTimestamp<T extends object>(turn: T, timestamp: string | undefined): T & { timestamp?: string } {
	return timestamp === undefined ? turn : { ...turn, timestamp };
}

/** Concatenate the text blocks of a content array (blocks that are not text are ignored). */
function arrayText(content: readonly unknown[], separator: string): string {
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text") {
			const text = asString(block.text);
			if (text !== undefined && text.trim() !== "") {
				parts.push(text.trim());
			}
		}
	}
	return parts.join(separator);
}

/** Text of a `tool_result` payload, which is either a string or an array of text blocks. */
function toolResultText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return arrayText(content, "\n");
	}
	return "";
}

/** Text of a message content field, for the entries that use one as a payload. */
function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (Array.isArray(content)) {
		return arrayText(content, "\n");
	}
	return "";
}

/** User entries: text becomes a user turn, tool_result blocks become result turns. */
function userTurns(entry: ClaudeRawEntry, timestamp: string | undefined): ClaudeTurn[] {
	const message = asMessage(entry.message);
	if (message === undefined) {
		return [];
	}
	const turns: ClaudeTurn[] = [];
	const content = message.content;

	if (typeof content === "string") {
		const text = stripSystemReminders(content);
		if (text !== "") {
			turns.push(withTimestamp({ kind: "user" as const, text }, timestamp));
		}
		return turns;
	}

	if (!Array.isArray(content)) {
		return turns;
	}

	// Results are listed before the accompanying user text so a tool call and its result stay
	// adjacent in source order.
	for (const block of content) {
		if (!isRecord(block) || block.type !== "tool_result") {
			continue;
		}
		turns.push(
			withTimestamp(
				{
					kind: "tool_result" as const,
					toolUseId: asString(block.tool_use_id) ?? "",
					text: toolResultText(block.content),
					isError: block.is_error === true,
				},
				timestamp,
			),
		);
	}

	const text = stripSystemReminders(arrayText(content, "\n"));
	if (text !== "") {
		turns.push(withTimestamp({ kind: "user" as const, text }, timestamp));
	}
	return turns;
}

/**
 * Assistant entries: text is joined into one turn and tool_use blocks are collected verbatim.
 * Thinking and redacted_thinking blocks are dropped outright — their Anthropic signatures are
 * meaningless (and invalid) on another provider (DP6). Nothing is invented to replace them.
 */
function assistantTurns(entry: ClaudeRawEntry, timestamp: string | undefined): ClaudeTurn[] {
	const message = asMessage(entry.message);
	const content = message?.content;
	const tools: ClaudeToolCall[] = [];
	const texts: string[] = [];

	if (typeof content === "string") {
		texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block)) {
				continue;
			}
			if (block.type === "tool_use") {
				tools.push({
					id: asString(block.id) ?? "",
					claudeName: asString(block.name) ?? "",
					input: block.input,
				});
			} else if (block.type === "text") {
				const text = asString(block.text);
				if (text !== undefined && text.trim() !== "") {
					texts.push(text.trim());
				}
			}
			// `thinking` and `redacted_thinking` fall through and are dropped (DP6).
		}
	}

	const text = texts.join("\n\n").trim();
	if (text === "" && tools.length === 0) {
		return [];
	}
	const model = asString(message?.model);
	return [
		withTimestamp(
			{
				kind: "assistant" as const,
				text,
				tools,
				...(model === undefined ? {} : { model }),
			},
			timestamp,
		),
	];
}

/** Turns for one already-filtered entry. Anything unrecognized yields no turn (DP6). */
function turnsForEntry(entry: ClaudeRawEntry, timestamp: string | undefined): ClaudeTurn[] {
	switch (entry.type) {
		case "user":
			return userTurns(entry, timestamp);
		case "assistant":
			return assistantTurns(entry, timestamp);
		case "summary": {
			const text = asString(entry.summary)?.trim();
			return text === undefined || text === ""
				? []
				: [withTimestamp({ kind: "summary" as const, text }, timestamp)];
		}
		case "system": {
			if (entry.subtype !== "compact_boundary") {
				return [];
			}
			const text =
				contentText(entry.content) || contentText(asMessage(entry.message)?.content);
			return text === "" ? [] : [withTimestamp({ kind: "summary" as const, text }, timestamp)];
		}
		default:
			return [];
	}
}

/** Parse the raw file contents of one Claude Code session. */
export function parseClaudeSession(raw: string, options: ParseOptions): ParseResult {
	const stats: ParseStats = {
		rawLines: 0,
		parsedEntries: 0,
		malformedLines: 0,
		skippedEntries: 0,
		droppedSidechains: 0,
		droppedMeta: 0,
		droppedApiErrors: 0,
	};
	const turns: ClaudeTurn[] = [];

	let sessionIdFromEntry: string | undefined;
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let title: string | undefined;
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;
	const models: string[] = [];

	const lines = typeof raw === "string" ? raw.split("\n") : [];

	for (const line of lines) {
		const candidate = line.trim();
		if (candidate === "") {
			// Blank lines and the trailing newline are separators, not entries.
			continue;
		}
		stats.rawLines += 1;

		let decoded: unknown;
		try {
			decoded = JSON.parse(candidate);
		} catch {
			stats.malformedLines += 1;
			continue;
		}
		if (!isRecord(decoded)) {
			// Arrays, scalars and `null` are valid JSON but not entries.
			stats.malformedLines += 1;
			continue;
		}
		const entry = decoded as ClaudeRawEntry;

		// Meta is read from every well-formed entry, including entries whose *turn* is dropped:
		// Claude Code carries sessionId/cwd/gitBranch/timestamps on bookkeeping lines too, and an
		// ai-title entry is exactly where the title lives. The facts are in the source (DP6).
		if (sessionIdFromEntry === undefined) {
			sessionIdFromEntry = asString(entry.sessionId);
		}
		if (cwd === undefined) {
			cwd = asString(entry.cwd);
		}
		if (gitBranch === undefined) {
			gitBranch = asString(entry.gitBranch);
		}
		if (entry.type === "ai-title" && title === undefined) {
			const candidateTitle = asString(entry.aiTitle)?.trim();
			if (candidateTitle !== undefined && candidateTitle !== "") {
				title = candidateTitle;
			}
		}
		const timestamp = timestampOf(entry.timestamp);
		if (timestamp !== undefined) {
			if (firstTimestamp === undefined || timestamp < firstTimestamp) {
				firstTimestamp = timestamp;
			}
			if (lastTimestamp === undefined || timestamp > lastTimestamp) {
				lastTimestamp = timestamp;
			}
		}

		// Filters, in a fixed order so an entry is counted once (DP6).
		if (entry.isSidechain === true) {
			stats.droppedSidechains += 1;
			continue;
		}
		if (entry.isMeta === true) {
			stats.droppedMeta += 1;
			continue;
		}
		if (entry.isApiErrorMessage === true) {
			stats.droppedApiErrors += 1;
			continue;
		}
		const type = asString(entry.type) ?? "";
		if (SKIPPED_ENTRY_TYPES.has(type)) {
			stats.skippedEntries += 1;
			continue;
		}

		if (type === "assistant") {
			const model = asString(asMessage(entry.message)?.model);
			if (model !== undefined && model !== "" && !models.includes(model)) {
				models.push(model);
			}
		}

		const produced = turnsForEntry(entry, timestamp);
		if (produced.length === 0) {
			stats.skippedEntries += 1;
			continue;
		}
		turns.push(...produced);
		stats.parsedEntries += 1;
	}

	const meta: ClaudeSessionMeta = {
		sessionId: sessionIdFromEntry ?? options.sessionId ?? basename(options.path, ".jsonl"),
		path: options.path,
	};
	if (cwd !== undefined) {
		meta.cwd = cwd;
	}
	if (gitBranch !== undefined) {
		meta.gitBranch = gitBranch;
	}
	if (title !== undefined) {
		meta.title = title;
	}
	if (firstTimestamp !== undefined) {
		meta.firstTimestamp = firstTimestamp;
	}
	if (lastTimestamp !== undefined) {
		meta.lastTimestamp = lastTimestamp;
	}
	if (models.length > 0) {
		meta.models = models;
	}

	const warnings: string[] = [];
	if (stats.malformedLines > 0) {
		warnings.push(`${stats.malformedLines} malformed JSONL line(s) skipped`);
	}
	if (turns.length === 0) {
		warnings.push("session contained no importable turns");
	}

	return { transcript: { meta, turns, stats }, warnings };
}
