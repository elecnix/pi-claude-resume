/**
 * Character budgets shared by the renderer (DP9).
 *
 * Truncation keeps the head and the tail and states what it dropped; it is never silent.
 * Every function here is pure and deterministic: same input, same output, no clock, no
 * randomness (DP3). The marker counts are exact, so a test can assert them (DP13).
 */

export interface TruncateResult {
	text: string;
	truncated: boolean;
	droppedChars: number;
}

/** Share of the budget kept from the front by default, leaving the rest for the tail. */
const DEFAULT_HEAD_RATIO = 0.4;

/**
 * Share of a single tool payload kept from the front. Payloads are usually read from the top
 * (a command, the first lines of a file) but the tail often carries the outcome (an error, a
 * summary), so a payload keeps both halves of its budget.
 */
const PAYLOAD_HEAD_RATIO = 0.5;

/** Clamp a raw budget into a sane positive integer. */
export function normalizeBudget(value: number | undefined, fallback: number): number {
	const safeFallback = Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1;
	// An absent, non-numeric or infinite budget is not a budget: use the caller's default.
	if (value === undefined || !Number.isFinite(value)) return safeFallback;
	// Zero and negative values cannot bound anything either.
	if (value <= 0) return safeFallback;
	// `Math.floor` first, then clamp: a budget below one still lets one character through.
	return Math.max(1, Math.floor(value));
}

function isHighSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
	return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** True when `index` falls between the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) return false;
	return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

/**
 * Largest head length <= `wanted` that does not end inside a surrogate pair.
 *
 * Backing off one code unit is the only safe move: emitting half a pair would replace the
 * character with U+FFFD for every consumer downstream.
 */
function safeHeadLength(text: string, wanted: number): number {
	if (wanted <= 0) return 0;
	if (wanted >= text.length) return text.length;
	return splitsSurrogatePair(text, wanted) ? wanted - 1 : wanted;
}

/** Smallest tail start >= `wanted` that does not begin inside a surrogate pair. */
function safeTailStart(text: string, wanted: number): number {
	if (wanted <= 0) return 0;
	if (wanted >= text.length) return text.length;
	return splitsSurrogatePair(text, wanted) ? wanted + 1 : wanted;
}

function clampRatio(ratio: number | undefined): number {
	if (ratio === undefined || !Number.isFinite(ratio)) return DEFAULT_HEAD_RATIO;
	if (ratio <= 0) return 0;
	if (ratio >= 1) return 1;
	return ratio;
}

function truncateWithMarker(
	text: string,
	maxChars: number,
	headRatio: number | undefined,
	verb: "omitted" | "truncated",
): TruncateResult {
	const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
	if (text.length <= budget) return { text, truncated: false, droppedChars: 0 };

	const headBudget = Math.floor(budget * clampRatio(headRatio));
	const tailBudget = budget - headBudget;
	const headEnd = safeHeadLength(text, headBudget);
	const tailStart = safeTailStart(text, text.length - tailBudget);
	const droppedChars = tailStart - headEnd;

	// Both boundaries were moved so far inwards that nothing is left to drop: keep the input
	// rather than emit a marker that claims a drop of zero characters.
	if (droppedChars <= 0) return { text, truncated: false, droppedChars: 0 };

	const marker = `[... ${droppedChars} characters ${verb} ...]`;
	return {
		text: `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`,
		truncated: true,
		droppedChars,
	};
}

/** Truncate `text` to `maxChars`, keeping `headRatio` of the budget from the front. */
export function truncateMiddle(text: string, maxChars: number, headRatio?: number): TruncateResult {
	return truncateWithMarker(text, maxChars, headRatio, "omitted");
}

/**
 * Truncate a single tool payload, keeping its head and marking the cut.
 *
 * Same middle-out rule as `truncateMiddle`, with payload wording so the reader can tell a
 * per-payload cap from the whole-transcript budget (DP9). Short input is returned unchanged.
 */
export function truncatePayload(text: string, maxChars: number): string {
	return truncateWithMarker(text, maxChars, PAYLOAD_HEAD_RATIO, "truncated").text;
}
