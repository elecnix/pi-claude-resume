/**
 * Character budgets shared by the renderer (DP9).
 *
 * Truncation keeps the head and the tail and states what it dropped; it is never silent.
 */

export interface TruncateResult {
	text: string;
	truncated: boolean;
	droppedChars: number;
}

/** Clamp a raw budget into a sane positive integer. */
export function normalizeBudget(value: number | undefined, fallback: number): number {
	throw new Error("not implemented: normalizeBudget");
}

/** Truncate `text` to `maxChars`, keeping `headRatio` of the budget from the front. */
export function truncateMiddle(text: string, maxChars: number, headRatio?: number): TruncateResult {
	throw new Error("not implemented: truncateMiddle");
}

/** Truncate a single tool payload, keeping its head and marking the cut. */
export function truncatePayload(text: string, maxChars: number): string {
	throw new Error("not implemented: truncatePayload");
}
