/**
 * Words for the counted losses of a parse (DP9, DP11).
 *
 * The parser drops entries it cannot use and counts every bucket (DP6). Counting is not the same
 * as reporting: a session that lost half its lines must not be announced as a clean import, so
 * these phrases turn the counters into something a user can act on ("3 lines could not be
 * parsed, 12 bookkeeping entries skipped"). Plain data in, plain strings out: no clock, no I/O,
 * no pi imports (DP3), so the wording is deterministic and unit-testable (DP13).
 */
import type { ParseStats } from "../types.ts";

/** `1 line` / `3 lines` without a plural-rule dependency. */
function count(quantity: number, singular: string, plural: string = `${singular}s`): string {
	return `${quantity} ${quantity === 1 ? singular : plural}`;
}

/**
 * One sentence fragment per non-empty drop bucket, in a fixed order; `[]` when nothing was
 * dropped at all.
 *
 * Every bucket that removes something from the source is named, including the deliberate
 * filters (sidechains, meta injections, API-error placeholders, bookkeeping entries) — a skip is
 * either a filtering decision (DP6) or a half-parsed file, and only the counts let a reader tell
 * which. `rawLines` and `parsedEntries` are absent: they measure what was read and imported, not
 * what was lost.
 */
export function describeParseLoss(stats: ParseStats): string[] {
	const parts: string[] = [];
	if (stats.malformedLines > 0) {
		parts.push(`${count(stats.malformedLines, "line")} could not be parsed`);
	}
	if (stats.skippedEntries > 0) {
		parts.push(`${count(stats.skippedEntries, "bookkeeping entry", "bookkeeping entries")} skipped`);
	}
	if (stats.droppedSidechains > 0) {
		parts.push(`${count(stats.droppedSidechains, "sub-agent entry", "sub-agent entries")} skipped`);
	}
	if (stats.droppedMeta > 0) {
		parts.push(`${count(stats.droppedMeta, "meta injection")} skipped`);
	}
	if (stats.droppedApiErrors > 0) {
		parts.push(`${count(stats.droppedApiErrors, "API-error placeholder")} skipped`);
	}
	return parts;
}
