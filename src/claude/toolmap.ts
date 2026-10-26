/**
 * Claude Code tool names and argument shapes -> pi tool names and argument shapes (DP7, DR4).
 *
 * The tables are data. An unmapped tool degrades to a declared placeholder, never to a
 * plausible-looking lie and never to an exception.
 */
import type { ToolMapper, ToolMapping } from "../types.ts";

/** Claude tool name -> pi tool name. */
export const CLAUDE_TO_PI_TOOL: Readonly<Record<string, string>> = {};

/** Claude tool name -> { claude argument key: pi argument key }. */
export const CLAUDE_ARG_KEY_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/** Argument keys that only make sense inside Claude Code, dropped on the way in. */
export const DROPPED_ARG_KEYS: ReadonlySet<string> = new Set<string>();

/** pi's built-in tool names, used when the runtime list is unavailable. */
export const PI_CORE_TOOLS: readonly string[] = [];

/** Tool name used when a Claude tool has no pi equivalent. */
export const PLACEHOLDER_TOOL = "bash";

/** Map one Claude tool call. Never throws. */
export const mapToolCall: ToolMapper = (claudeName: string, input: unknown): ToolMapping => {
	throw new Error("not implemented: mapToolCall");
};
