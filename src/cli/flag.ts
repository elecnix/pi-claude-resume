/**
 * Flag registration and value parsing for `--claude*` (DP5).
 *
 * This module never imports the pi extension types: it takes the narrowest structural shape it
 * needs (`registerFlag` / `getFlag` callables) so the parsing rules are testable without a pi
 * runtime (DP3, DP13).
 */
import {
	FLAG_CLAUDE,
	FLAG_CLAUDE_FORCE,
	FLAG_CLAUDE_MAX_CHARS,
	type ClaudeFlagValues,
} from "../types.ts";

/**
 * Structural mirror of pi's `registerFlag` option union.
 *
 * Declared locally rather than imported from `@earendil-works/pi-coding-agent` so `src/cli`
 * stays pi-free (DP3); the shape is identical, so `pi.registerFlag` is assignable to it.
 */
export type ClaudeFlagOptions =
	| { description?: string; type: "boolean"; default?: boolean }
	| { description?: string; type: "string"; default?: string };

/** The slice of the pi extension API this module needs. */
export type RegisterFlag = (name: string, options: ClaudeFlagOptions) => void;

/** The slice of the pi extension API this module needs for reading values back. */
export type GetFlag = (name: string) => boolean | string | undefined;

/** Register `--claude`, `--claude-max-chars` and `--claude-force` on pi. */
export function registerClaudeFlags(registerFlag: RegisterFlag): void {
	registerFlag(FLAG_CLAUDE, {
		type: "string",
		description: "Resume a Claude Code session: --claude <session-id|path|latest>",
	});
	registerFlag(FLAG_CLAUDE_MAX_CHARS, {
		type: "string",
		description: "Character budget for the imported transcript (default 120000)",
	});
	registerFlag(FLAG_CLAUDE_FORCE, {
		type: "boolean",
		description: "Re-import even if this pi session already imported that Claude session",
	});
}

/** Read the three flag values from a getter, validating the numeric one. */
export function readClaudeFlags(getFlag: GetFlag): ClaudeFlagValues {
	return {
		spec: readSpec(getFlag(FLAG_CLAUDE)),
		maxChars: parseMaxChars(getFlag(FLAG_CLAUDE_MAX_CHARS)),
		force: parseForce(getFlag(FLAG_CLAUDE_FORCE)),
	};
}

/**
 * Parse and validate `--claude-max-chars`. Returns undefined for absent or invalid input.
 *
 * Invalid input is never an error: a bad budget must not stop a resume, it just leaves DP9's
 * default in place. `undefined` therefore means "no usable budget was supplied".
 */
export function parseMaxChars(raw: boolean | string | undefined): number | undefined {
	// `undefined` (absent), `false`/`true` (pi hands back a boolean for a valueless flag) and
	// the empty string are all "not supplied".
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	// Positive decimal integer only: rejects "12abc", "1.5", "-3", "1e6", "+12", "0".
	if (!/^[0-9]+$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

/** The `--claude` value, trimmed; undefined when absent, empty, or not a string. */
function readSpec(raw: boolean | string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/** `--claude-force` is true only for a literal boolean true or the string `"true"`. */
function parseForce(raw: boolean | string | undefined): boolean {
	return raw === true || raw === "true";
}
