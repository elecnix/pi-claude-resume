/**
 * Bridge orchestration: locate -> parse -> render -> boundary -> inject (DP1, DP10, DP11).
 *
 * The only side effects are the three host callbacks; everything else is pure.
 */
import type { BridgeHost, BridgeOptions, BridgeResult } from "../types.ts";

/** Import a Claude Code session into the current pi session. */
export async function resumeClaudeSession(
	host: BridgeHost,
	options: BridgeOptions,
): Promise<BridgeResult> {
	throw new Error("not implemented: resumeClaudeSession");
}
