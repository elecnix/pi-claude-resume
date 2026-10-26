/**
 * Render a normalized transcript into bounded text for injection (DP6, DP9).
 */
import type { ClaudeTranscript, RenderOptions, RenderResult } from "../types.ts";

/** Render the transcript. Deterministic: no clock, no randomness. */
export function renderTranscript(transcript: ClaudeTranscript, options?: RenderOptions): RenderResult {
	throw new Error("not implemented: renderTranscript");
}
