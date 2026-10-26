/**
 * Locate one Claude Code session file by id, path or `latest` (DP5).
 *
 * Pure with respect to the pi runtime: filesystem access only, no network, no writes (DP3).
 */
import type { LocateOptions, LocateResult } from "../types.ts";

/** Claude Code's project directory name for a working directory: `/a/b` -> `-a-b`. */
export function claudeProjectSlug(cwd: string): string {
	throw new Error("not implemented: claudeProjectSlug");
}

/** Resolve `--claude` to exactly one readable session file, or fail with a reason. */
export function locateClaudeSession(options: LocateOptions): LocateResult {
	throw new Error("not implemented: locateClaudeSession");
}
