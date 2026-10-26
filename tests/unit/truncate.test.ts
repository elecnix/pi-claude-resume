/**
 * Specification for the bounded-injection helpers (DP9, DP13).
 *
 * Every fixture here is synthetic: short hand-written strings, no captured session data (DP12).
 */
import { describe, expect, it } from "vitest";
import {
	normalizeBudget,
	truncateMiddle,
	truncatePayload,
} from "../../src/shared/truncate.ts";

/** True when `text` contains a half of a surrogate pair without its partner. */
function hasLoneSurrogate(text: string): boolean {
	const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
	const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (isHigh(code)) {
			if (!isLow(text.charCodeAt(i + 1))) return true;
			i += 1;
		} else if (isLow(code)) {
			return true;
		}
	}
	return false;
}

describe("normalizeBudget", () => {
	it("uses the fallback when the value is absent", () => {
		expect(normalizeBudget(undefined, 500)).toBe(500);
	});

	it("uses the fallback when the value is NaN", () => {
		expect(normalizeBudget(Number.NaN, 500)).toBe(500);
	});

	it("uses the fallback when the value is negative", () => {
		expect(normalizeBudget(-12, 500)).toBe(500);
	});

	it("uses the fallback when the value is zero", () => {
		expect(normalizeBudget(0, 500)).toBe(500);
	});

	it("uses the fallback when the value is infinite", () => {
		expect(normalizeBudget(Number.POSITIVE_INFINITY, 500)).toBe(500);
		expect(normalizeBudget(Number.NEGATIVE_INFINITY, 500)).toBe(500);
	});

	it("floors a fractional budget", () => {
		expect(normalizeBudget(42.9, 500)).toBe(42);
	});

	it("clamps a budget below one up to one", () => {
		expect(normalizeBudget(0.5, 500)).toBe(1);
	});

	it("clamps a non-finite fallback to one instead of returning nonsense", () => {
		expect(normalizeBudget(undefined, Number.NaN)).toBe(1);
		expect(normalizeBudget(undefined, 0)).toBe(1);
	});
});

describe("truncateMiddle", () => {
	it("returns short text unchanged", () => {
		const result = truncateMiddle("abcdef", 10);
		expect(result).toEqual({ text: "abcdef", truncated: false, droppedChars: 0 });
	});

	it("returns text of exactly the budget unchanged", () => {
		const result = truncateMiddle("abcdef", 6);
		expect(result).toEqual({ text: "abcdef", truncated: false, droppedChars: 0 });
	});

	it("drops exactly one character when the text exceeds the budget by one", () => {
		// head = floor(0.4 * 9) = 3, tail = 6.
		const result = truncateMiddle("abcdefghij", 9);
		expect(result.truncated).toBe(true);
		expect(result.droppedChars).toBe(1);
		expect(result.text).toBe("abc[... 1 characters omitted ...]efghij");
	});

	it("keeps the requested head share and gives the rest of the budget to the tail", () => {
		const result = truncateMiddle("ABCDEFGHIJKLMNOPQRST", 10, 0.4);
		// head 4 = "ABCD", tail 6 = "OPQRST", dropped 20 - 10 = 10.
		expect(result.text).toBe("ABCD[... 10 characters omitted ...]OPQRST");
		expect(result.droppedChars).toBe(10);
	});

	it("keeps no head when headRatio is zero", () => {
		const result = truncateMiddle("abcdefghij", 4, 0);
		expect(result.text).toBe("[... 6 characters omitted ...]ghij");
		expect(result.droppedChars).toBe(6);
	});

	it("keeps no tail when headRatio is one", () => {
		const result = truncateMiddle("abcdefghij", 4, 1);
		expect(result.text).toBe("abcd[... 6 characters omitted ...]");
		expect(result.droppedChars).toBe(6);
	});

	it("clamps an out-of-range head ratio instead of producing a negative budget", () => {
		expect(truncateMiddle("abcdefghij", 4, 2).text).toBe(truncateMiddle("abcdefghij", 4, 1).text);
		expect(truncateMiddle("abcdefghij", 4, -3).text).toBe(truncateMiddle("abcdefghij", 4, 0).text);
	});

	it("falls back to the default head ratio for a non-finite ratio", () => {
		expect(truncateMiddle("abcdefghij", 4, Number.NaN).text).toBe(
			truncateMiddle("abcdefghij", 4, 0.4).text,
		);
	});

	it("reports the exact marker text and dropped count", () => {
		const text = "x".repeat(1000);
		const result = truncateMiddle(text, 400, 0.4);
		expect(result.text).toContain("[... 600 characters omitted ...]");
		expect(result.droppedChars).toBe(600);
		// The marker's number is the truth: head + tail are exactly the budget.
		expect(result.text.length).toBe(400 + "[... 600 characters omitted ...]".length);
	});

	it("drops everything and leaves only the marker when the budget is zero", () => {
		const result = truncateMiddle("abcdef", 0);
		expect(result).toEqual({
			text: "[... 6 characters omitted ...]",
			truncated: true,
			droppedChars: 6,
		});
	});

	it("never splits a surrogate pair at the head boundary", () => {
		// Four astral characters, two code units each. A head budget of one code unit would cut
		// the first character in half, so the head backs off to zero.
		const text = "\u{1F600}\u{1F600}\u{1F600}\u{1F600}";
		const result = truncateMiddle(text, 3, 0.5);
		expect(hasLoneSurrogate(result.text)).toBe(false);
		expect(result.text.startsWith("[... 6 characters omitted ...]")).toBe(true);
		expect(result.text.endsWith("\u{1F600}")).toBe(true);
		expect(result.droppedChars).toBe(6);
	});

	it("never splits a surrogate pair at the tail boundary", () => {
		// "a" + astral char + "b"; a tail budget of two code units would start on the low half
		// of the pair, so the tail start moves past it.
		const text = `a\u{1F600}b`;
		const result = truncateMiddle(text, 2, 0);
		expect(hasLoneSurrogate(result.text)).toBe(false);
		expect(result.text).toBe("[... 3 characters omitted ...]b");
		expect(result.droppedChars).toBe(3);
	});

	it("is deterministic across two calls", () => {
		const text = "lorem ipsum dolor sit amet ".repeat(20);
		expect(truncateMiddle(text, 77, 0.25)).toEqual(truncateMiddle(text, 77, 0.25));
	});
});

describe("truncatePayload", () => {
	it("returns a short payload unchanged", () => {
		expect(truncatePayload("short payload", 50)).toBe("short payload");
	});

	it("marks the cut with the payload wording and the exact count", () => {
		const payload = "0123456789";
		const result = truncatePayload(payload, 4);
		expect(result).toBe("01[... 6 characters truncated ...]89");
	});

	it("keeps the head and the tail of a long payload", () => {
		const payload = `${"head ".repeat(10)}${"tail ".repeat(10)}`;
		const result = truncatePayload(payload, 40);
		expect(result.startsWith("head ")).toBe(true);
		expect(result.endsWith("tail ")).toBe(true);
		expect(result).toContain("characters truncated");
	});

	it("never splits a surrogate pair in a payload", () => {
		const result = truncatePayload("\u{1F600}\u{1F600}\u{1F600}", 3);
		expect.hasAssertions();
		expect(hasLoneSurrogate(result)).toBe(false);
	});
});
