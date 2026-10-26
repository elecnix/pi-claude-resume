/**
 * Parse a Claude Code session (JSONL) into a normalized, tool-agnostic transcript.
 *
 * Tolerates unknown entry types and malformed lines; never throws on bad input (DP11).
 */
import type { ClaudeTranscript } from "../types.ts";

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

/** Parse the raw file contents of one Claude Code session. */
export function parseClaudeSession(raw: string, options: ParseOptions): ParseResult {
	throw new Error("not implemented: parseClaudeSession");
}
