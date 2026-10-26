/**
 * Flag registration and value parsing for `--claude*` (DP5).
 */
import type { ClaudeFlagValues } from "../types.ts";

/** Register `--claude`, `--claude-max-chars` and `--claude-force` on pi. */
export function registerClaudeFlags(registerFlag: (name: string, options: Record<string, unknown>) => void): void {
	throw new Error("not implemented: registerClaudeFlags");
}

/** Read the three flag values from a getter, validating the numeric one. */
export function readClaudeFlags(getFlag: (name: string) => boolean | string | undefined): ClaudeFlagValues {
	throw new Error("not implemented: readClaudeFlags");
}

/** Parse and validate `--claude-max-chars`. Returns undefined for absent or invalid input. */
export function parseMaxChars(raw: boolean | string | undefined): number | undefined {
	throw new Error("not implemented: parseMaxChars");
}
