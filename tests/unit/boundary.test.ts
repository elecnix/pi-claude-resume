import { describe, expect, it } from "vitest";

import { MAX_LISTED_TOOLS, buildBoundaryMessage } from "../../src/claude/boundary.ts";
import type { BoundaryInput, ClaudeSessionMeta, RenderResult } from "../../src/types.ts";

/**
 * Synthetic fixtures only (DP12): every id, path and title below is invented for the test.
 */
const SESSION_ID = "3f9a1c77-0a1b-4b6d-9f4e-2c5d8e7a1b30";

function meta(overrides: Partial<ClaudeSessionMeta> = {}): ClaudeSessionMeta {
	return {
		sessionId: SESSION_ID,
		path: `/fixtures/sessions/${SESSION_ID}.jsonl`,
		...overrides,
	};
}

function rendered(overrides: Partial<RenderResult> = {}): RenderResult {
	return {
		text: "[imported transcript]",
		chars: 21,
		estimatedTokens: 5,
		truncated: false,
		droppedTurns: 0,
		droppedChars: 0,
		...overrides,
	};
}

function input(overrides: Partial<BoundaryInput> = {}): BoundaryInput {
	return {
		meta: meta(),
		piTools: ["bash", "read", "edit", "write"],
		claudeTools: ["Bash", "Read", "Edit"],
		rendered: rendered(),
		...overrides,
	};
}

const TYPICAL = buildBoundaryMessage(input());

describe("buildBoundaryMessage - handover (DP8, DR2)", () => {
	it("says the transcript came from Claude Code and that pi is now the agent in force", () => {
		expect(TYPICAL).toContain("produced by Claude Code");
		expect(TYPICAL).toContain("imported into this pi session");
		expect(TYPICAL).toContain("continuation");
		expect(TYPICAL).toContain("pi, not Claude Code, is the agent in force");
	});

	it("makes pi's own system prompt and tool list authoritative over the transcript", () => {
		expect(TYPICAL).toContain(
			"pi's own system prompt and the pi tool list below are authoritative",
		);
		expect(TYPICAL).toContain("claims a different tool set");
		expect(TYPICAL).toContain("historical context only");
	});

	it("does not claim the transcript holds native pi entries", () => {
		expect(TYPICAL).toContain("not native pi session entries you can replay");
		const lower = TYPICAL.toLowerCase();
		for (const claim of [
			"as native pi entries",
			"native pi tool call",
			"replay the tool calls",
			"tool-call blocks",
			"native pi history",
		]) {
			expect(lower).not.toContain(claim);
		}
	});
});

describe("buildBoundaryMessage - tool lists", () => {
	it("lists the pi tools active in this session, comma-separated", () => {
		expect(TYPICAL).toContain("Tools active in this pi session: bash, read, edit, write.");
	});

	it("says explicitly when the session has no pi tools", () => {
		const message = buildBoundaryMessage(input({ piTools: [] }));
		expect(message).toContain("Tools active in this pi session: none");
		expect(message).toContain("no tools are available to you in this session");
		expect(message).not.toMatch(/Tools active in this pi session: \./);
	});

	it("ignores blank tool names", () => {
		const message = buildBoundaryMessage(input({ piTools: ["", "  ", "bash"], claudeTools: [] }));
		expect(message).toContain("Tools active in this pi session: bash.");
	});

	it("caps a long pi tool list but still states the total count", () => {
		const piTools = Array.from({ length: 40 }, (_, index) => `tool_${index}`);
		const message = buildBoundaryMessage(input({ piTools }));
		expect(message).toContain(`tool_${MAX_LISTED_TOOLS - 1}`);
		expect(message).not.toContain(`tool_${MAX_LISTED_TOOLS},`);
		expect(message).toContain("40 in total");
		expect(message).toContain(`${40 - MAX_LISTED_TOOLS} more are not named here`);
	});

	it("names the Claude tools as history rather than as the model's own tools", () => {
		expect(TYPICAL).toContain("Claude Code tools that appear in the imported history as history");
		expect(TYPICAL).toContain("Bash, Read, Edit.");
	});

	it("caps a long Claude tool list too", () => {
		const claudeTools = Array.from({ length: 60 }, (_, index) => `ClaudeTool${index}`);
		const message = buildBoundaryMessage(input({ claudeTools }));
		expect(message).toContain(`ClaudeTool${MAX_LISTED_TOOLS - 1}`);
		expect(message).not.toContain(`ClaudeTool${MAX_LISTED_TOOLS},`);
		expect(message).toContain("60 in total");
	});

	it("omits the Claude tool paragraph when the imported history named no tools", () => {
		const message = buildBoundaryMessage(input({ claudeTools: [] }));
		expect(message).not.toContain("Claude Code tools");
		expect(message).toContain("Tools active in this pi session: bash");
	});
});

describe("buildBoundaryMessage - session identity (DP8)", () => {
	it("includes the Claude session id verbatim", () => {
		expect(TYPICAL).toContain(`Imported Claude Code session: id ${SESSION_ID}.`);
		expect(buildBoundaryMessage(input({ piTools: [], claudeTools: [] }))).toContain(SESSION_ID);
	});

	it("includes title, cwd and git branch when the caller supplies them", () => {
		const message = buildBoundaryMessage(
			input({
				meta: meta({
					title: "Tidy the fixture loader",
					cwd: "/fixtures/work/demo-project",
					gitBranch: "feat/demo-branch",
				}),
			}),
		);
		expect(message).toContain("title Tidy the fixture loader");
		expect(message).toContain("cwd /fixtures/work/demo-project");
		expect(message).toContain("git branch feat/demo-branch");
	});

	it("omits title, cwd and git branch cleanly when they are absent", () => {
		expect(TYPICAL).not.toContain("title ");
		expect(TYPICAL).not.toContain("cwd ");
		expect(TYPICAL).not.toContain("git branch");
		expect(TYPICAL).toContain(`Imported Claude Code session: id ${SESSION_ID}.`);
		expect(TYPICAL).not.toContain("undefined");
	});

	it("treats blank optional metadata as absent", () => {
		const message = buildBoundaryMessage(
			input({ meta: meta({ title: "   ", cwd: "", gitBranch: "  " }) }),
		);
		expect(message).toContain(`Imported Claude Code session: id ${SESSION_ID}.`);
		expect(message).not.toContain("title");
		expect(message).not.toContain("git branch");
	});

	it("never leaks the source file path or a date", () => {
		expect(TYPICAL).not.toContain("/fixtures/sessions");
		expect(TYPICAL).not.toContain(".jsonl");
		expect(TYPICAL).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(TYPICAL).not.toMatch(/\b\d{1,2}:\d{2}\b/);
	});
});

describe("buildBoundaryMessage - omission (DP9)", () => {
	it("says nothing about omission when the transcript was not truncated", () => {
		const message = buildBoundaryMessage(input({ rendered: rendered({ truncated: false }) }));
		expect(message).not.toMatch(/omitted|cut to fit|context budget/);
	});

	it("states the dropped turns and characters when the transcript was truncated", () => {
		const message = buildBoundaryMessage(
			input({ rendered: rendered({ truncated: true, droppedTurns: 7, droppedChars: 41234 }) }),
		);
		expect(message).toContain("7 turns");
		expect(message).toContain("41234 characters");
		expect(message).toContain("not the whole conversation");
	});
});

describe("buildBoundaryMessage - closing instruction (DP8)", () => {
	it("ends by telling the model the next user message continues and not to re-issue finished calls", () => {
		const tail = TYPICAL.slice(-260);
		expect(tail).toContain("The user's next message continues the work from here.");
		expect(TYPICAL).toContain("Do not repeat or re-issue a tool call");
		expect(TYPICAL).toContain("already appears as completed in the transcript above.");
		expect(TYPICAL.trimEnd().endsWith("transcript above.")).toBe(true);
	});
});

describe("buildBoundaryMessage - shape and budget", () => {
	it("is deterministic across calls", () => {
		const first = buildBoundaryMessage(
			input({ piTools: ["bash", "read"], claudeTools: ["Bash"] }),
		);
		const second = buildBoundaryMessage(
			input({ piTools: ["bash", "read"], claudeTools: ["Bash"] }),
		);
		expect(second).toBe(first);
		expect(buildBoundaryMessage(input())).toBe(TYPICAL);
	});

	it("stays under 1,500 characters for a typical input", () => {
		expect(TYPICAL.length).toBeLessThan(1_500);
		expect(TYPICAL.length).toBeGreaterThan(400);
	});

	it("stays bounded for a hostile input and truncates an oversized title", () => {
		const message = buildBoundaryMessage(
			input({
				meta: meta({ title: "x".repeat(10_000), cwd: "/fixtures/work/" + "d".repeat(4_000) }),
				piTools: Array.from({ length: 500 }, (_, index) => `pi_tool_${index}`),
				claudeTools: Array.from({ length: 500 }, (_, index) => `ClaudeTool${index}`),
				rendered: rendered({ truncated: true, droppedTurns: 999, droppedChars: 999_999 }),
			}),
		);
		expect(message.length).toBeLessThan(1_900);
		expect(message).toContain("characters, truncated");
		expect(message).not.toContain("x".repeat(300));
		expect(message).toContain("500 in total");
	});

	it("does not grow with the input once every list and metadata value is capped", () => {
		const smaller = buildBoundaryMessage(
			input({
				meta: meta({ title: "x".repeat(10_000) }),
				piTools: Array.from({ length: 500 }, (_, index) => `pi_tool_${index}`),
				claudeTools: Array.from({ length: 500 }, (_, index) => `ClaudeTool${index}`),
			}),
		);
		const larger = buildBoundaryMessage(
			input({
				meta: meta({ title: "x".repeat(100_000) }),
				piTools: Array.from({ length: 5_000 }, (_, index) => `pi_tool_${index}`),
				claudeTools: Array.from({ length: 5_000 }, (_, index) => `ClaudeTool${index}`),
			}),
		);
		expect(larger.length - smaller.length).toBeLessThan(40);
		expect(larger.length).toBeLessThan(1_900);
	});

	it("contains no emoji", () => {
		const message = buildBoundaryMessage(
			input({ meta: meta({ title: "tidy the loader" }), claudeTools: ["Bash", "Read"] }),
		);
		expect(message).not.toMatch(/\p{Extended_Pictographic}/u);
		expect(message).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
	});
});
