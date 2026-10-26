/**
 * Specification for `parseClaudeSession` (DP13).
 *
 * Every filtering decision, every turn shape and every meta fallback has a case here. Fixtures
 * under `tests/fixtures/claude/` are hand-written: synthetic names, synthetic paths, nothing
 * captured from a real machine (DP12).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseClaudeSession } from "../../src/claude/parse.ts";
import type { ParseOptions } from "../../src/claude/parse.ts";
import type { ClaudeTranscript, ClaudeTurn, ParseStats } from "../../src/types.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH = `/home/ada/.claude/projects/-repo/${SESSION_ID}.jsonl`;
const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/claude/", import.meta.url));
const TS = "2024-05-01T10:00:00.000Z";
const TS_LATER = "2024-05-01T10:30:00.000Z";

function readFixture(name: string): string {
	return readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), "utf8");
}

/** Build JSONL from entries; a string argument is used verbatim so malformed lines can be tested. */
function jsonl(...entries: unknown[]): string {
	const lines = entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
	return `${lines.join("\n")}\n`;
}

function parse(raw: string, options: Partial<ParseOptions> = {}) {
	return parseClaudeSession(raw, { path: SESSION_PATH, ...options });
}

type Extra = Record<string, unknown>;

function userEntry(content: unknown, extra: Extra = {}): Extra {
	return { type: "user", timestamp: TS, message: { role: "user", content }, ...extra };
}

function assistantEntry(content: unknown, extra: Extra = {}): Extra {
	return {
		type: "assistant",
		timestamp: TS,
		message: { role: "assistant", model: "claude-synthetic-1", content },
		...extra,
	};
}

function onlyTurn(transcript: ClaudeTranscript): ClaudeTurn {
	expect(transcript.turns).toHaveLength(1);
	const [turn] = transcript.turns;
	if (turn === undefined) {
		throw new Error("expected exactly one turn");
	}
	return turn;
}

function onlyAssistant(transcript: ClaudeTranscript): Extract<ClaudeTurn, { kind: "assistant" }> {
	const turn = onlyTurn(transcript);
	if (turn.kind !== "assistant") {
		throw new Error(`expected an assistant turn, got ${turn.kind}`);
	}
	return turn;
}

function bucketTotal(stats: ParseStats): number {
	return (
		stats.parsedEntries +
		stats.skippedEntries +
		stats.droppedSidechains +
		stats.droppedMeta +
		stats.droppedApiErrors +
		stats.malformedLines
	);
}

function emptyStats(): ParseStats {
	return {
		rawLines: 0,
		parsedEntries: 0,
		malformedLines: 0,
		skippedEntries: 0,
		droppedSidechains: 0,
		droppedMeta: 0,
		droppedApiErrors: 0,
	};
}

describe("parseClaudeSession — line handling", () => {
	it("returns an empty transcript for an empty file", () => {
		const { transcript, warnings } = parse("");
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats).toStrictEqual(emptyStats());
		expect(transcript.meta).toStrictEqual({ sessionId: SESSION_ID, path: SESSION_PATH });
		expect(warnings).toStrictEqual(["session contained no importable turns"]);
	});

	it("ignores blank lines and a trailing newline", () => {
		const { transcript } = parse("\n \n\t\n\n");
		expect(transcript.stats).toStrictEqual(emptyStats());
		expect(transcript.turns).toStrictEqual([]);
	});

	it("accepts CRLF line endings", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: hello")).replace(/\n/g, "\r\n"));
		expect(transcript.turns).toStrictEqual([{ kind: "user", text: "Ada: hello", timestamp: TS }]);
	});

	it("skips a malformed line in the middle and keeps parsing", () => {
		const { transcript, warnings } = parse(jsonl(userEntry("first"), "{ this is not json", userEntry("second")));
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "first", timestamp: TS },
			{ kind: "user", text: "second", timestamp: TS },
		]);
		expect(transcript.stats.malformedLines).toBe(1);
		expect(transcript.stats.parsedEntries).toBe(2);
		expect(warnings).toStrictEqual(["1 malformed JSONL line(s) skipped"]);
	});

	it("counts valid JSON that is not an object as malformed", () => {
		const { transcript } = parse(jsonl("[]", "null", "42", '"a string"'));
		expect(transcript.stats.malformedLines).toBe(4);
		expect(transcript.turns).toStrictEqual([]);
	});

	it("never throws on hostile input", () => {
		const garbage = "\u0000{\"type\":\"user\"\n<<<>>>\n" + "x".repeat(10_000) + "\n{\"a\":";
		expect(() => parse(garbage)).not.toThrow();
		expect(parse(garbage).transcript.stats.malformedLines).toBeGreaterThan(0);
	});

	it("treats a non-string input as an empty session instead of throwing", () => {
		const { transcript } = parse(undefined as unknown as string);
		expect(transcript.stats).toStrictEqual(emptyStats());
		expect(transcript.turns).toStrictEqual([]);
	});
});

describe("parseClaudeSession — filtering with counters (DP6)", () => {
	it("drops unknown entry types into skippedEntries", () => {
		const { transcript } = parse(jsonl({ type: "mystery-type", timestamp: TS }));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
		expect(transcript.stats.parsedEntries).toBe(0);
	});

	it("drops every bookkeeping type into skippedEntries", () => {
		const bookkeeping = [
			"attachment",
			"file-history-snapshot",
			"mode",
			"permission-mode",
			"ai-title",
			"atis-latch",
			"api-request",
			"api-request-blob",
			"api-request-shape",
			"last-prompt",
		];
		const { transcript } = parse(jsonl(...bookkeeping.map((type) => ({ type, timestamp: TS }))));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(bookkeeping.length);
		expect(transcript.stats.parsedEntries).toBe(0);
	});

	it("drops sidechain entries into droppedSidechains", () => {
		const { transcript } = parse(jsonl(userEntry("subagent scratch", { isSidechain: true })));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.droppedSidechains).toBe(1);
		expect(transcript.stats.parsedEntries).toBe(0);
	});

	it("drops meta injections into droppedMeta", () => {
		const { transcript } = parse(jsonl(userEntry("Caveat: injected.", { isMeta: true })));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.droppedMeta).toBe(1);
	});

	it("drops API-error placeholders into droppedApiErrors", () => {
		const { transcript } = parse(jsonl(assistantEntry([{ type: "text", text: "API Error: Overloaded" }], { isApiErrorMessage: true })));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.droppedApiErrors).toBe(1);
	});

	it("counts an entry once even when several drop reasons apply", () => {
		const { transcript } = parse(
			jsonl({ type: "user", isSidechain: true, isApiErrorMessage: true, message: { content: "x" } }),
		);
		expect(transcript.stats.droppedSidechains).toBe(1);
		expect(transcript.stats.droppedApiErrors).toBe(0);
		expect(transcript.stats.droppedMeta).toBe(0);
		expect(transcript.stats.skippedEntries).toBe(0);
	});
});

describe("parseClaudeSession — user entries", () => {
	it("emits one user turn for string content", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: please add a retry helper.")));
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "Ada: please add a retry helper.", timestamp: TS },
		]);
		expect(transcript.stats.parsedEntries).toBe(1);
	});

	it("concatenates text blocks of an array content", () => {
		const { transcript } = parse(
			jsonl(userEntry([
				{ type: "text", text: "first line" },
				{ type: "text", text: "second line" },
			])),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "first line\nsecond line", timestamp: TS },
		]);
	});

	it("emits tool_result turns before the accompanying user text", () => {
		const { transcript } = parse(
			jsonl(userEntry([
				{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" },
				{ type: "text", text: "I changed the file" },
			])),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "tool_result", toolUseId: "toolu_1", text: "file contents", isError: false, timestamp: TS },
			{ kind: "user", text: "I changed the file", timestamp: TS },
		]);
	});

	it("reads tool_result content that is a string", () => {
		const { transcript } = parse(
			jsonl(userEntry([{ type: "tool_result", tool_use_id: "toolu_2", content: "  ok\n" }])),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "tool_result", toolUseId: "toolu_2", text: "ok", isError: false, timestamp: TS },
		]);
	});

	it("reads tool_result content that is an array of text blocks", () => {
		const { transcript } = parse(
			jsonl(userEntry([
				{
					type: "tool_result",
					tool_use_id: "toolu_3",
					content: [
						{ type: "text", text: "line a" },
						{ type: "image", source: { type: "base64", data: "c3ludGhldGlj" } },
						{ type: "text", text: "line b" },
					],
				},
			])),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "tool_result", toolUseId: "toolu_3", text: "line a\nline b", isError: false, timestamp: TS },
		]);
	});

	it("maps is_error to isError", () => {
		const { transcript } = parse(
			jsonl(userEntry([{ type: "tool_result", tool_use_id: "toolu_4", content: "No matches found.", is_error: true }])),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "tool_result", toolUseId: "toolu_4", text: "No matches found.", isError: true, timestamp: TS },
		]);
	});

	it("defaults a missing tool_use_id to an empty string", () => {
		const { transcript } = parse(jsonl(userEntry([{ type: "tool_result", content: "orphaned" }])));
		expect(transcript.turns).toStrictEqual([
			{ kind: "tool_result", toolUseId: "", text: "orphaned", isError: false, timestamp: TS },
		]);
	});

	it("counts a tool_result-only entry as parsed, not skipped", () => {
		const { transcript } = parse(jsonl(userEntry([{ type: "tool_result", tool_use_id: "toolu_5", content: "x" }])));
		expect(transcript.stats.parsedEntries).toBe(1);
		expect(transcript.stats.skippedEntries).toBe(0);
	});

	it("drops a user entry that is only a system-reminder", () => {
		const { transcript } = parse(
			jsonl(userEntry("<system-reminder>Todo list is empty.</system-reminder>")),
		);
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
		expect(transcript.stats.parsedEntries).toBe(0);
	});

	it("keeps the user text around a system-reminder", () => {
		const { transcript } = parse(
			jsonl(userEntry("Keep the public API stable.\n<system-reminder>\nopened a file\n</system-reminder>")),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "Keep the public API stable.", timestamp: TS },
		]);
	});

	it("strips system-reminders case-insensitively and across lines", () => {
		const { transcript } = parse(
			jsonl(userEntry("<SYSTEM-REMINDER>\nline one\nline two\n</SYSTEM-REMINDER>\nDo the thing.")),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "user", text: "Do the thing.", timestamp: TS }]);
	});

	it("strips several system-reminders from one message", () => {
		const { transcript } = parse(
			jsonl(userEntry(
				"<system-reminder>a</system-reminder>Before<system-reminder>b</system-reminder>After",
			)),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "user", text: "BeforeAfter", timestamp: TS }]);
	});

	it("drops user text that is whitespace-only after stripping", () => {
		const { transcript } = parse(
			jsonl(userEntry("  \n <system-reminder>noise</system-reminder>\n\t ")),
		);
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("counts a user entry without a message as skipped", () => {
		const { transcript } = parse(jsonl({ type: "user", timestamp: TS }));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});
});

describe("parseClaudeSession — assistant entries", () => {
	it("emits one assistant turn for text only", () => {
		const { transcript } = parse(jsonl(assistantEntry([{ type: "text", text: "All set." }])));
		expect(transcript.turns).toStrictEqual([
			{
				kind: "assistant",
				text: "All set.",
				tools: [],
				model: "claude-synthetic-1",
				timestamp: TS,
			},
		]);
	});

	it("joins multiple text blocks with a blank line", () => {
		const { transcript } = parse(
			jsonl(assistantEntry([
				{ type: "text", text: "First paragraph." },
				{ type: "text", text: "Second paragraph." },
			])),
		);
		expect(onlyAssistant(transcript).text).toBe("First paragraph.\n\nSecond paragraph.");
	});

	it("keeps tool_use blocks with no text", () => {
		const { transcript } = parse(
			jsonl(assistantEntry([
				{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "ls /repo/src" } },
			])),
		);
		expect(transcript.turns).toStrictEqual([
			{
				kind: "assistant",
				text: "",
				tools: [{ id: "toolu_9", claudeName: "Bash", input: { command: "ls /repo/src" } }],
				model: "claude-synthetic-1",
				timestamp: TS,
			},
		]);
	});

	it("drops thinking and redacted_thinking blocks and keeps text plus tools", () => {
		const { transcript } = parse(
			jsonl(assistantEntry([
				{ type: "thinking", thinking: "Consider the props.", signature: "c2lnbmF0dXJl" },
				{ type: "redacted_thinking", data: "cmVkYWN0ZWQ=" },
				{ type: "text", text: "I'll guard the props access." },
				{ type: "tool_use", id: "toolu_11", name: "Grep", input: { pattern: "props" } },
			])),
		);
		const turn = onlyAssistant(transcript);
		expect(turn).toStrictEqual({
			kind: "assistant",
			text: "I'll guard the props access.",
			tools: [{ id: "toolu_11", claudeName: "Grep", input: { pattern: "props" } }],
			model: "claude-synthetic-1",
			timestamp: TS,
		});
		expect(JSON.stringify(turn)).not.toContain("signature");
		expect(JSON.stringify(turn)).not.toContain("Consider the props");
	});

	it("emits no turn when the only block is redacted_thinking", () => {
		const { transcript } = parse(jsonl(assistantEntry([{ type: "redacted_thinking", data: "cmVkYWN0ZWQ=" }])));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("emits no turn when the only block is thinking", () => {
		const { transcript } = parse(jsonl(assistantEntry([{ type: "thinking", thinking: "hmm", signature: "c2ln" }])));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("defaults missing tool_use fields without dropping the call", () => {
		const { transcript } = parse(jsonl(assistantEntry([{ type: "tool_use" }])));
		expect(transcript.turns).toStrictEqual([
			{
				kind: "assistant",
				text: "",
				tools: [{ id: "", claudeName: "", input: undefined }],
				model: "claude-synthetic-1",
				timestamp: TS,
			},
		]);
	});

	it("preserves Claude tool names verbatim — mapping is not parsing (DP7)", () => {
		const { transcript } = parse(
			jsonl(assistantEntry([{ type: "tool_use", id: "toolu_12", name: "MultiEdit", input: { edits: [] } }])),
		);
		expect(onlyAssistant(transcript).tools).toStrictEqual([
			{ id: "toolu_12", claudeName: "MultiEdit", input: { edits: [] } },
		]);
	});

	it("accepts assistant content as a plain string", () => {
		const { transcript } = parse(
			jsonl({ type: "assistant", timestamp: TS, message: { role: "assistant", content: "Done." } }),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "assistant", text: "Done.", tools: [], timestamp: TS }]);
	});
});

describe("parseClaudeSession — summary and system entries", () => {
	it("maps a summary entry to a summary turn", () => {
		const { transcript } = parse(
			jsonl({ type: "summary", summary: "Refactored the banner component.", leafUuid: "abc", timestamp: TS }),
		);
		expect(transcript.turns).toStrictEqual([
			{ kind: "summary", text: "Refactored the banner component.", timestamp: TS },
		]);
		expect(transcript.stats.parsedEntries).toBe(1);
	});

	it("skips a summary entry without a summary string", () => {
		const { transcript } = parse(jsonl({ type: "summary", leafUuid: "abc", timestamp: TS }));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("maps a compact_boundary system entry to a summary turn", () => {
		const { transcript } = parse(
			jsonl({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: TS }),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "summary", text: "Conversation compacted", timestamp: TS }]);
	});

	it("reads a compact_boundary payload from message.content too", () => {
		const { transcript } = parse(
			jsonl({
				type: "system",
				subtype: "compact_boundary",
				timestamp: TS,
				message: { role: "system", content: "Compacted earlier." },
			}),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "summary", text: "Compacted earlier.", timestamp: TS }]);
	});

	it("reads a compact_boundary payload given as text blocks", () => {
		const { transcript } = parse(
			jsonl({
				type: "system",
				subtype: "compact_boundary",
				timestamp: TS,
				content: [{ type: "text", text: "Conversation compacted" }],
			}),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "summary", text: "Conversation compacted", timestamp: TS }]);
	});

	it("skips system entries with another subtype", () => {
		const { transcript } = parse(jsonl({ type: "system", subtype: "hook_result", content: "hook ok", timestamp: TS }));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("skips system entries without a subtype", () => {
		const { transcript } = parse(jsonl({ type: "system", content: "plain", timestamp: TS }));
		expect(transcript.turns).toStrictEqual([]);
		expect(transcript.stats.skippedEntries).toBe(1);
	});
});

describe("parseClaudeSession — meta", () => {
	it("takes sessionId from the first entry that carries one", () => {
		const { transcript } = parse(
			jsonl({ type: "mode", timestamp: TS }, userEntry("Ada: hi", { sessionId: "sess-abc" })),
		);
		expect(transcript.meta.sessionId).toBe("sess-abc");
	});

	it("falls back to options.sessionId", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: hi")), { sessionId: "given-id" });
		expect(transcript.meta.sessionId).toBe("given-id");
	});

	it("falls back to the file name without .jsonl", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: hi")), { path: "/repo/some/session-9.jsonl" });
		expect(transcript.meta.sessionId).toBe("session-9");
	});

	it("records the source path", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: hi")), { path: "/repo/some/session-9.jsonl" });
		expect(transcript.meta.path).toBe("/repo/some/session-9.jsonl");
	});

	it("takes cwd and gitBranch from the first entry that carries them", () => {
		const { transcript } = parse(
			jsonl(
				userEntry("Ada: hi"),
				userEntry("second", { cwd: "/repo", gitBranch: "trunk" }),
				userEntry("third", { cwd: "/elsewhere", gitBranch: "other" }),
			),
		);
		expect(transcript.meta.cwd).toBe("/repo");
		expect(transcript.meta.gitBranch).toBe("trunk");
	});

	it("takes the title from an ai-title entry", () => {
		const { transcript } = parse(
			jsonl(userEntry("Ada: hi"), { type: "ai-title", aiTitle: "Banner tolerance", timestamp: TS }),
		);
		expect(transcript.meta.title).toBe("Banner tolerance");
		expect(transcript.stats.skippedEntries).toBe(1);
	});

	it("does not use a summary as the title", () => {
		const { transcript } = parse(
			jsonl(userEntry("Ada: hi"), { type: "summary", summary: "Not a title", timestamp: TS }),
		);
		expect(transcript.meta.title).toBeUndefined();
	});

	it("computes first and last timestamp, ignoring invalid values", () => {
		const { transcript } = parse(
			jsonl(
				userEntry("one", { timestamp: TS }),
				userEntry("two", { timestamp: "not-a-real-timestamp" }),
				userEntry("three", { timestamp: TS_LATER }),
				userEntry("four", { timestamp: "2024-05-01T10:15:00.000Z" }),
				{ type: "mode", timestamp: TS_LATER },
			),
		);
		expect(transcript.meta.firstTimestamp).toBe(TS);
		expect(transcript.meta.lastTimestamp).toBe(TS_LATER);
	});

	it("omits timestamp fields when no entry carries a valid one", () => {
		const { transcript } = parse(jsonl({ type: "user", message: { content: "Ada: hi" } }));
		expect(transcript.meta).toStrictEqual({ sessionId: SESSION_ID, path: SESSION_PATH });
		expect(transcript.turns).toStrictEqual([{ kind: "user", text: "Ada: hi" }]);
	});

	it("keeps the model on the turn but not an invalid timestamp", () => {
		const { transcript } = parse(
			jsonl({ type: "assistant", timestamp: "yesterday", message: { role: "assistant", model: "m", content: "ok" } }),
		);
		expect(transcript.turns).toStrictEqual([{ kind: "assistant", text: "ok", tools: [], model: "m" }]);
	});

	it("dedupes models in first-seen order", () => {
		const { transcript } = parse(
			jsonl(
				assistantEntry("one", { message: { role: "assistant", model: "m-one", content: "one" } }),
				assistantEntry("two", { message: { role: "assistant", model: "m-two", content: "two" } }),
				assistantEntry("three", { message: { role: "assistant", model: "m-one", content: "three" } }),
			),
		);
		expect(transcript.meta.models).toStrictEqual(["m-one", "m-two"]);
	});

	it("omits models when no assistant entry carries one", () => {
		const { transcript } = parse(jsonl(userEntry("Ada: hi")));
		expect(transcript.meta.models).toBeUndefined();
	});

	it("ignores the parent chain and leafUuid", () => {
		const plain = jsonl(
			{ type: "user", timestamp: TS, message: { role: "user", content: "Ada: hi" } },
			{ type: "assistant", timestamp: TS, message: { role: "assistant", content: "hello" } },
		);
		const chained = jsonl(
			{ type: "user", uuid: "u1", parentUuid: null, timestamp: TS, message: { role: "user", content: "Ada: hi" } },
			{
				type: "assistant",
				uuid: "u2",
				parentUuid: "u1",
				leafUuid: "u2",
				timestamp: TS,
				message: { role: "assistant", content: "hello" },
			},
		);
		expect(parse(chained).transcript).toStrictEqual(parse(plain).transcript);
	});
});

describe("parseClaudeSession — purity and accounting", () => {
	it("is idempotent on the same input", () => {
		const raw = readFixture("noisy-session.jsonl");
		expect(parse(raw)).toStrictEqual(parse(raw));
	});

	it("returns independent results across calls", () => {
		const raw = jsonl(userEntry("Ada: hi"));
		const first = parse(raw);
		first.transcript.turns.length = 0;
		expect(parse(raw).transcript.turns).toHaveLength(1);
	});

	it("accounts for every raw line in exactly one bucket", () => {
		for (const raw of [
			readFixture("basic-session.jsonl"),
			readFixture("noisy-session.jsonl"),
			jsonl(userEntry("a"), "{bad", "[]", { type: "mode" }, { type: "user", isMeta: true }),
		]) {
			const { transcript } = parse(raw);
			expect(bucketTotal(transcript.stats)).toBe(transcript.stats.rawLines);
		}
	});
});

describe("parseClaudeSession — fixtures", () => {
	const basicPath = `${FIXTURE_DIR}basic-session.jsonl`;

	it("parses the basic session end to end", () => {
		const { transcript, warnings } = parse(readFixture("basic-session.jsonl"), { path: basicPath });
		expect(warnings).toStrictEqual([]);
		expect(transcript.meta).toStrictEqual({
			sessionId: SESSION_ID,
			path: basicPath,
			cwd: "/repo",
			gitBranch: "main",
			title: "Add a retry helper",
			firstTimestamp: "2024-05-01T10:00:00.000Z",
			lastTimestamp: "2024-05-01T10:01:00.000Z",
			models: ["claude-synthetic-1"],
		});
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "Please add a retry helper to src/app.ts", timestamp: "2024-05-01T10:00:05.000Z" },
			{
				kind: "assistant",
				text: "Let me read the current file first.",
				tools: [{ id: "toolu_synth_01", claudeName: "Read", input: { file_path: "/repo/src/app.ts" } }],
				model: "claude-synthetic-1",
				timestamp: "2024-05-01T10:00:09.000Z",
			},
			{
				kind: "tool_result",
				toolUseId: "toolu_synth_01",
				text: "export function main() {\n\treturn 1;\n}",
				isError: false,
				timestamp: "2024-05-01T10:00:10.000Z",
			},
			{
				kind: "assistant",
				text: "Here is a small retry helper for src/app.ts.",
				tools: [
					{
						id: "toolu_synth_02",
						claudeName: "Edit",
						input: {
							file_path: "/repo/src/app.ts",
							old_string: "export function main() {",
							new_string: "export function main() {\n\treturn retry(() => work());",
						},
					},
				],
				model: "claude-synthetic-1",
				timestamp: "2024-05-01T10:00:14.000Z",
			},
			{ kind: "user", text: "Thanks, that looks right.", timestamp: "2024-05-01T10:01:00.000Z" },
		]);
		expect(transcript.stats).toStrictEqual({
			rawLines: 6,
			parsedEntries: 5,
			malformedLines: 0,
			skippedEntries: 1,
			droppedSidechains: 0,
			droppedMeta: 0,
			droppedApiErrors: 0,
		});
	});

	it("parses the noisy session with every drop counter set", () => {
		const { transcript, warnings } = parse(readFixture("noisy-session.jsonl"), {
			path: `${FIXTURE_DIR}noisy-session.jsonl`,
		});
		expect(transcript.stats).toStrictEqual({
			rawLines: 21,
			parsedEntries: 8,
			malformedLines: 1,
			skippedEntries: 9,
			droppedSidechains: 1,
			droppedMeta: 1,
			droppedApiErrors: 1,
		});
		expect(warnings).toStrictEqual(["1 malformed JSONL line(s) skipped"]);
		expect(transcript.meta.title).toBeUndefined();
		expect(transcript.meta.cwd).toBe("/repo");
		expect(transcript.meta.gitBranch).toBe("main");
		expect(transcript.meta.firstTimestamp).toBe("2024-05-02T09:00:00.000Z");
		expect(transcript.meta.lastTimestamp).toBe("2024-05-02T09:01:10.000Z");
		expect(transcript.meta.models).toStrictEqual(["claude-synthetic-2"]);
		expect(transcript.turns.map((turn) => turn.kind)).toStrictEqual([
			"user",
			"user",
			"assistant",
			"tool_result",
			"assistant",
			"summary",
			"summary",
			"user",
		]);
		expect(transcript.turns[1]).toStrictEqual({
			kind: "user",
			text: "Keep the public API stable.",
			timestamp: "2024-05-02T09:00:10.000Z",
		});
		expect(transcript.turns[3]).toStrictEqual({
			kind: "tool_result",
			toolUseId: "toolu_synth_11",
			text: "No matches found.",
			isError: true,
			timestamp: "2024-05-02T09:00:20.000Z",
		});
		expect(transcript.turns[6]).toStrictEqual({
			kind: "summary",
			text: "Conversation compacted",
			timestamp: "2024-05-02T09:01:05.000Z",
		});
	});

	it("falls back to the fixture file name and omits absent meta", () => {
		const minimalPath = `${FIXTURE_DIR}minimal-session.jsonl`;
		const { transcript, warnings } = parse(readFixture("minimal-session.jsonl"), { path: minimalPath });
		expect(warnings).toStrictEqual([]);
		expect(transcript.meta).toStrictEqual({
			sessionId: "minimal-session",
			path: minimalPath,
			models: ["claude-synthetic-3"],
		});
		expect(transcript.turns).toStrictEqual([
			{ kind: "user", text: "Ada: what does the parse step do?" },
			{ kind: "assistant", text: "It turns the session log into turns.", tools: [], model: "claude-synthetic-3" },
		]);
		expect(transcript.stats).toStrictEqual({
			rawLines: 2,
			parsedEntries: 2,
			malformedLines: 0,
			skippedEntries: 0,
			droppedSidechains: 0,
			droppedMeta: 0,
			droppedApiErrors: 0,
		});
	});
});
