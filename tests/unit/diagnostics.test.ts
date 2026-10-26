/**
 * Tests for the parse-diagnostic wording (DP9, DP13).
 *
 * These phrases are what a user reads when the import was not whole, so their content and their
 * order are part of the contract. Everything here is synthetic (DP12): counters, no session.
 */
import { describe, expect, it } from "vitest";
import { describeParseLoss } from "../../src/shared/diagnostics.ts";
import type { ParseStats } from "../../src/types.ts";

/** A parse that lost nothing: every line was read and became an entry. */
const CLEAN: ParseStats = {
	rawLines: 5,
	parsedEntries: 5,
	malformedLines: 0,
	skippedEntries: 0,
	droppedSidechains: 0,
	droppedMeta: 0,
	droppedApiErrors: 0,
};

function lossy(overrides: Partial<ParseStats>): ParseStats {
	return { ...CLEAN, ...overrides };
}

describe("describeParseLoss", () => {
	it("says nothing about a lossless parse", () => {
		expect(describeParseLoss(CLEAN)).toEqual([]);
	});

	it("does not mention the counters that measure what was read, not what was lost", () => {
		const text = describeParseLoss(lossy({ malformedLines: 1, skippedEntries: 2 })).join(" ");
		expect(text).not.toContain("rawLines");
		expect(text).not.toContain("parsedEntries");
	});

	it("names every non-zero drop bucket", () => {
		expect(
			describeParseLoss(
				lossy({
					malformedLines: 3,
					skippedEntries: 12,
					droppedSidechains: 4,
					droppedMeta: 2,
					droppedApiErrors: 1,
				}),
			),
		).toEqual([
			"3 lines could not be parsed",
			"12 bookkeeping entries skipped",
			"4 sub-agent entries skipped",
			"2 meta injections skipped",
			"1 API-error placeholder skipped",
		]);
	});

	it("uses a singular noun for a count of one", () => {
		expect(describeParseLoss(lossy({ malformedLines: 1 }))).toEqual(["1 line could not be parsed"]);
		expect(describeParseLoss(lossy({ skippedEntries: 1 }))).toEqual(["1 bookkeeping entry skipped"]);
		expect(describeParseLoss(lossy({ droppedSidechains: 1 }))).toEqual(["1 sub-agent entry skipped"]);
		expect(describeParseLoss(lossy({ droppedMeta: 1 }))).toEqual(["1 meta injection skipped"]);
		expect(describeParseLoss(lossy({ droppedApiErrors: 1 }))).toEqual([
			"1 API-error placeholder skipped",
		]);
	});

	it("keeps a fixed order so two runs describe the same file the same way", () => {
		const a = describeParseLoss(lossy({ malformedLines: 1, droppedApiErrors: 1 }));
		const b = describeParseLoss(lossy({ droppedApiErrors: 1, malformedLines: 1 }));
		expect(a).toEqual(b);
		expect(a).toEqual(["1 line could not be parsed", "1 API-error placeholder skipped"]);
	});
});
