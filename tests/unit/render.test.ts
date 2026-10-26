/**
 * Specification for the transcript renderer (DP6, DP7, DP9, DP13).
 *
 * Every fixture here is hand-written and synthetic: invented ids, invented paths under
 * `/workspace/example-project` and invented prompts. Nothing is captured from a real session (DP12).
 */
import { describe, expect, it } from "vitest";
import type {
	ClaudeSessionMeta,
	ClaudeToolCall,
	ClaudeTranscript,
	ClaudeTurn,
	ParseStats,
	ToolMapper,
} from "../../src/types.ts";
import { renderTranscript } from "../../src/claude/render.ts";

/**
 * Stand-in for the real mapping table (DP7, DR4): a small, explicitly fake mapping so these
 * tests never depend on the tool table's contents, only on how the renderer uses it.
 */
const fakeMapper: ToolMapper = (claudeName, input) => {
	const args = (input ?? {}) as Record<string, unknown>;
	switch (claudeName) {
		case "Read":
			return { piName: "read", input: { path: args.file_path ?? "" }, notes: [] };
		case "Bash":
			return { piName: "bash", input: { command: args.command ?? "" }, notes: [] };
		default:
			return {
				piName: "bash",
				input: { command: `placeholder for ${claudeName}` },
				notes: [`no pi equivalent for ${claudeName}`, "arguments may be incomplete"],
			};
	}
};

const STATS: ParseStats = {
	rawLines: 6,
	parsedEntries: 6,
	malformedLines: 0,
	skippedEntries: 0,
	droppedSidechains: 0,
	droppedMeta: 0,
	droppedApiErrors: 0,
};

function transcriptWith(turns: ClaudeTurn[], meta: Partial<ClaudeSessionMeta> = {}): ClaudeTranscript {
	return {
		meta: {
			sessionId: "synthetic-session-1",
			path: "/workspace/example-project/synthetic.jsonl",
			...meta,
		},
		turns,
		stats: STATS,
	};
}

/** Render with the fake mapper unless the test overrides it. */
function render(transcript: ClaudeTranscript, options: Parameters<typeof renderTranscript>[1] = {}) {
	return renderTranscript(transcript, { mapTool: fakeMapper, ...options });
}

function userTurn(text: string, timestamp?: string): ClaudeTurn {
	return timestamp === undefined ? { kind: "user", text } : { kind: "user", text, timestamp };
}

describe("renderTranscript header", () => {
	it("always renders the session heading with the session id", () => {
		const result = render(transcriptWith([userTurn("hello")]));
		expect(result.text.split("\n")[0]).toBe("# Claude Code session synthetic-session-1");
	});

	it("renders the optional header facts when the session carries them", () => {
		const result = render(
			transcriptWith([userTurn("hello")], {
				title: "Synthetic fixture session",
				cwd: "/workspace/example-project",
				gitBranch: "main",
				firstTimestamp: "2024-01-01T00:00:00.000Z",
			}),
		);
		expect(result.text).toContain("- title: Synthetic fixture session");
		expect(result.text).toContain("- cwd: /workspace/example-project");
		expect(result.text).toContain("- git branch: main");
		expect(result.text).toContain("- session started: 2024-01-01T00:00:00.000Z");
	});

	it("omits every optional header fact when the session has none", () => {
		const result = render(transcriptWith([userTurn("hello")]));
		expect(result.text).not.toContain("- title:");
		expect(result.text).not.toContain("- cwd:");
		expect(result.text).not.toContain("- git branch:");
		expect(result.text).not.toContain("- model(s):");
		expect(result.text).not.toContain("- session started:");
	});

	it("joins several models with a comma", () => {
		const result = render(transcriptWith([userTurn("hello")], { models: ["claude-a", "claude-b", "claude-c"] }));
		expect(result.text).toContain("- model(s): claude-a, claude-b, claude-c");
	});

	it("omits an empty or blank model list", () => {
		expect(render(transcriptWith([userTurn("hello")], { models: [] })).text).not.toContain("- model(s):");
		expect(render(transcriptWith([userTurn("hello")], { models: ["", "  "] })).text).not.toContain(
			"- model(s):",
		);
	});

	it("separates the header from the first turn with exactly one blank line", () => {
		const result = render(transcriptWith([userTurn("hello")], { title: "Synthetic fixture session" }));
		expect(result.text).toContain("- title: Synthetic fixture session\n\n## User (unknown)");
	});
});

describe("renderTranscript turns", () => {
	it("renders a user turn with its timestamp", () => {
		const result = render(transcriptWith([userTurn("Add a greeting to the readme.", "t1")]));
		expect(result.text).toContain("## User (t1)\nAdd a greeting to the readme.");
	});

	it('renders "unknown" when a turn has no timestamp', () => {
		const result = render(transcriptWith([userTurn("Add a greeting to the readme.")]));
		expect(result.text).toContain("## User (unknown)");
	});

	it("renders assistant text", () => {
		const result = render(
			transcriptWith([
				{ kind: "assistant", text: "I will look at the readme first.", tools: [], timestamp: "t2" },
			]),
		);
		expect(result.text).toContain("## Assistant (t2)\nI will look at the readme first.");
	});

	it('renders "(no text)" for an assistant turn that only calls tools', () => {
		const tools: ClaudeToolCall[] = [{ id: "toolu_synthetic_2", claudeName: "Bash", input: { command: "ls" } }];
		const result = render(transcriptWith([{ kind: "assistant", text: "   ", tools }]));
		expect(result.text).toContain("## Assistant (unknown)\n(no text)");
	});

	it("renders a tool call with pi's tool name and JSON arguments", () => {
		const tools: ClaudeToolCall[] = [
			{ id: "toolu_synthetic_1", claudeName: "Read", input: { file_path: "README.md" } },
		];
		const result = render(transcriptWith([{ kind: "assistant", text: "Looking.", tools }]));
		expect(result.text).toContain('- tool read({"path":"README.md"})');
	});

	it("keeps a blank line before every tool call and joins notes with a semicolon", () => {
		const tools: ClaudeToolCall[] = [
			{ id: "toolu_synthetic_1", claudeName: "Read", input: { file_path: "README.md" } },
			{ id: "toolu_synthetic_2", claudeName: "TodoWrite", input: { todos: [] } },
		];
		const result = render(transcriptWith([{ kind: "assistant", text: "Working.", tools }]));
		expect(result.text).toContain(
			'Working.\n\n- tool read({"path":"README.md"})\n\n- tool bash({"command":"placeholder for TodoWrite"})\n  notes: no pi equivalent for TodoWrite; arguments may be incomplete',
		);
		expect(result.text.match(/^- tool /gm)).toHaveLength(2);
	});

	it("omits the notes line when the mapper reports nothing lossy", () => {
		const tools: ClaudeToolCall[] = [{ id: "toolu_synthetic_1", claudeName: "Bash", input: { command: "ls" } }];
		const result = render(transcriptWith([{ kind: "assistant", text: "Listing.", tools }]));
		expect(result.text).toContain('- tool bash({"command":"ls"})');
		expect(result.text).not.toContain("notes:");
	});

	it("pairs a tool result with the call that produced it through the tool_use id", () => {
		const result = render(
			transcriptWith([
				{
					kind: "tool_result",
					toolUseId: "toolu_synthetic_1",
					text: "readme.md",
					isError: false,
					timestamp: "t3",
				},
			]),
		);
		expect(result.text).toContain("## Tool result (t3)\n- for toolu_synthetic_1: ok\nreadme.md");
	});

	it("marks an error result as error", () => {
		const result = render(
			transcriptWith([{ kind: "tool_result", toolUseId: "toolu_synthetic_2", text: "exit 1", isError: true }]),
		);
		expect(result.text).toContain("- for toolu_synthetic_2: error");
	});

	it('falls back to "unknown tool call" when the result carries no id', () => {
		const result = render(transcriptWith([{ kind: "tool_result", toolUseId: "", text: "ok", isError: false }]));
		expect(result.text).toContain("- for unknown tool call: ok");
	});

	it("renders Claude's compaction summary as its own block", () => {
		const result = render(
			transcriptWith([
				{ kind: "summary", text: "The user asked for a greeting in the readme.", timestamp: "t4" },
			]),
		);
		expect(result.text).toContain("## Summary (t4)\nThe user asked for a greeting in the readme.");
	});

	it("renders turns in source order", () => {
		const result = render(transcriptWith([userTurn("first", "t1"), userTurn("second", "t2")]));
		expect(result.text.indexOf("## User (t1)")).toBeLessThan(result.text.indexOf("## User (t2)"));
	});
});

describe("renderTranscript per-payload caps", () => {
	it("caps a tool result and states how many characters it dropped", () => {
		const result = render(
			transcriptWith([{ kind: "tool_result", toolUseId: "toolu_synthetic_1", text: "x".repeat(500), isError: false }]),
			{ maxToolResultChars: 100 },
		);
		expect(result.text).toContain("[... 400 characters truncated ...]");
		expect(result.truncated).toBe(true);
		// A payload cap is not a turn drop: nothing was removed from the middle of the transcript.
		expect(result.droppedTurns).toBe(0);
		expect(result.droppedChars).toBe(0);
	});

	it("leaves a tool result that fits the payload cap untouched", () => {
		const result = render(
			transcriptWith([{ kind: "tool_result", toolUseId: "toolu_synthetic_1", text: "short", isError: false }]),
			{ maxToolResultChars: 100 },
		);
		expect(result.text).toContain("- for toolu_synthetic_1: ok\nshort");
		expect(result.text).not.toContain("truncated");
		expect(result.truncated).toBe(false);
	});

	it("caps a tool input and marks the cut inside the call line", () => {
		const tools: ClaudeToolCall[] = [{ id: "toolu_synthetic_3", claudeName: "Bash", input: { command: "y".repeat(200) } }];
		const result = render(transcriptWith([{ kind: "assistant", text: "Running.", tools }]), {
			maxToolInputChars: 50,
		});
		expect(result.text).toContain("characters truncated");
		expect(result.text.match(/^- tool bash\(/m)).not.toBeNull();
		expect(result.truncated).toBe(true);
	});
});

describe("renderTranscript whole-text budget", () => {
	/**
	 * Eight equal-size user turns. Each block is the same length on purpose, so the arithmetic
	 * in the assertions below is the format's arithmetic, not an accident of the fixture.
	 */
	const eightTurns = (): ClaudeTurn[] =>
		Array.from({ length: 8 }, (_, index) =>
			userTurn(`message ${index + 1} ${"x".repeat(30)}`, `t${index + 1}`),
		);

	it("keeps the full transcript when it fits, without any omission marker", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 10_000 });
		expect(result.truncated).toBe(false);
		expect(result.droppedTurns).toBe(0);
		expect(result.droppedChars).toBe(0);
		expect(result.text).not.toContain("omitted");
		expect(result.text).toContain("## User (t8)");
	});

	it("drops whole middle turns and reports their exact counts", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 365 });
		expect(result.droppedTurns).toBe(3);
		expect(result.droppedChars).toBe(159);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("[... 3 turns (159 characters) omitted ...]");
	});

	it("keeps the first and the last turn when it drops the middle", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 365 });
		// First turn (the original task) and last turn (the most recent state) survive (DP9).
		expect(result.text).toContain("## User (t1)\nmessage 1 ");
		expect(result.text).toContain("## User (t8)\nmessage 8 ");
		expect(result.text).not.toContain("## User (t3)");
		expect(result.text).not.toContain("## User (t4)");
		expect(result.text).not.toContain("## User (t5)");
	});

	it("never emits half a turn: the marker is a block of its own", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 365 });
		expect(result.text).toContain("\n\n[... 3 turns (159 characters) omitted ...]\n\n## User (t6)");
		// Every surviving turn is complete: heading plus its whole message.
		expect(result.text).toContain(`## User (t6)\nmessage 6 ${"x".repeat(30)}`);
	});

	it("grows the kept turns inwards from both ends", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 365 });
		expect(result.text).toContain("## User (t1)");
		expect(result.text).toContain("## User (t2)");
		expect(result.text).toContain("## User (t6)");
		expect(result.text).toContain("## User (t7)");
		expect(result.text).toContain("## User (t8)");
		expect(result.droppedTurns).toBe(3);
	});

	it("hard-caps the text when even one turn at each end busts the budget", () => {
		// The minimum keep set (header + first + last + marker) is 195 characters here, two over
		// the budget, so the hard cap wins and the extra cut states itself too (DP9).
		const result = render(transcriptWith(eightTurns()), { maxChars: 193 });
		expect(result.truncated).toBe(true);
		expect(result.droppedTurns).toBe(6);
		// Six whole turns (318 characters) plus the two characters the hard cap cut.
		expect(result.droppedChars).toBe(318 + 2);
		expect(result.text).toContain("characters omitted ...");
		expect(result.text.length).toBeLessThanOrEqual(193 + "[... 2 characters omitted ...]".length);
		// Both ends are still present after the safety cap.
		expect(result.text).toContain("## User (t1)");
		expect(result.text).toContain("## User (t8)");
	});

	it("counts the hard-cap cut in droppedChars, so the report is exact (DP9)", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 193 });
		const marker = "[... 2 characters omitted ...]";

		// The documented bound: the budget plus the one marker the hard cap inserts.
		expect(result.text).toContain(marker);
		expect(result.text.length).toBeLessThanOrEqual(193 + marker.length);
		// Everything removed is in the count: whole turns and the hard-cap cut together.
		expect(result.droppedChars).toBe(318 + 2);
		expect(result.chars).toBe(result.text.length);
	});

	it("reports chars and estimatedTokens from the final text", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 365 });
		expect(result.chars).toBe(result.text.length);
		expect(result.estimatedTokens).toBe(Math.ceil(result.text.length / 4));
	});

	it("honours the maxChars option instead of the 120 000-character default", () => {
		const result = render(transcriptWith(eightTurns()), { maxChars: 400 });
		expect(result.truncated).toBe(true);
		expect(result.chars).toBeLessThanOrEqual(400 + 50);
	});
});

describe("renderTranscript tool availability (DP7)", () => {
	/** Maps Claude's Task to pi's `subagent`, a tool only a subagent extension provides. */
	const subagentMapper: ToolMapper = (_claudeName, input) => ({
		piName: "subagent",
		input: (input ?? {}) as Record<string, unknown>,
		notes: [],
	});

	const taskCall: ClaudeToolCall[] = [
		{ id: "toolu_synthetic_9", claudeName: "Task", input: { prompt: "Find the fixture" } },
	];

	it("marks a mapped call whose pi tool is not active in this session", () => {
		const result = render(transcriptWith([{ kind: "assistant", text: "Delegating.", tools: taskCall }]), {
			mapTool: subagentMapper,
			piTools: ["bash", "read", "edit"],
		});

		expect(result.text).toContain("- tool subagent(");
		expect(result.text).toContain(
			"notes: subagent is not an active tool in this pi session: this Task call happened in Claude Code and is not available here.",
		);
	});

	it("leaves an active pi tool unmarked", () => {
		const result = render(transcriptWith([{ kind: "assistant", text: "Delegating.", tools: taskCall }]), {
			mapTool: subagentMapper,
			piTools: ["bash", "read", "edit", "subagent"],
		});

		expect(result.text).toContain("- tool subagent(");
		expect(result.text).not.toContain("not an active tool");
	});

	it("falls back to pi's own built-in tools when the caller has no runtime list", () => {
		// `intercom` is not a pi built-in, so even a caller that passes no list gets the marking.
		const intercomMapper: ToolMapper = () => ({ piName: "intercom", input: { action: "send" }, notes: [] });
		const result = render(
			transcriptWith([
				{
					kind: "assistant",
					text: "Messaging.",
					tools: [{ id: "toolu_synthetic_8", claudeName: "SendMessage", input: { message: "hello" } }],
				},
			]),
			{ mapTool: intercomMapper },
		);

		expect(result.text).toContain("intercom is not an active tool in this pi session");
		expect(result.text).toContain("this SendMessage call happened in Claude Code");
	});

	it("marks every call of a turn that pi cannot make, without touching the pi-native ones", () => {
		const mixed: ClaudeToolCall[] = [
			{ id: "toolu_synthetic_1", claudeName: "Bash", input: { command: "ls" } },
			{ id: "toolu_synthetic_2", claudeName: "Task", input: { prompt: "Find it" } },
		];
		const mapper: ToolMapper = (claudeName, input) =>
			claudeName === "Task"
				? { piName: "subagent", input: (input ?? {}) as Record<string, unknown>, notes: [] }
				: { piName: "bash", input: (input ?? {}) as Record<string, unknown>, notes: [] };

		const result = render(transcriptWith([{ kind: "assistant", text: "Working.", tools: mixed }]), {
			mapTool: mapper,
			piTools: ["bash"],
		});

		expect(result.text).toContain("- tool bash({\"command\":\"ls\"})");
		expect(result.text.match(/not an active tool/g)).toHaveLength(1);
	});
});

describe("renderTranscript injection and determinism", () => {
	it("passes Claude's tool name and raw arguments to the injected mapper", () => {
		const seen: Array<[string, unknown]> = [];
		const spy: ToolMapper = (claudeName, input) => {
			seen.push([claudeName, input]);
			return { piName: "read", input: { path: "README.md" }, notes: [] };
		};
		const tools: ClaudeToolCall[] = [{ id: "toolu_synthetic_1", claudeName: "Read", input: { file_path: "README.md" } }];
		render(transcriptWith([{ kind: "assistant", text: "Looking.", tools }]), { mapTool: spy });
		expect(seen).toEqual([["Read", { file_path: "README.md" }]]);
	});

	it("produces identical output on two calls (no clock, no randomness)", () => {
		const transcript = transcriptWith(
			[
				userTurn("Add a greeting to the readme.", "t1"),
				{
					kind: "assistant",
					text: "Looking.",
					tools: [{ id: "toolu_synthetic_1", claudeName: "Read", input: { file_path: "README.md" } }],
				},
				{ kind: "tool_result", toolUseId: "toolu_synthetic_1", text: "readme", isError: false },
			],
			{ title: "Synthetic fixture session", models: ["claude-a"] },
		);
		expect(render(transcript)).toEqual(render(transcript));
	});

	it("matches the golden transcript for a small synthetic session", () => {
		const transcript = transcriptWith(
			[
				{ kind: "user", text: "Add a greeting to the readme.", timestamp: "2024-01-01T00:00:00.000Z" },
				{
					kind: "assistant",
					text: "I will look at the readme first.",
					tools: [{ id: "toolu_synthetic_1", claudeName: "Read", input: { file_path: "README.md" } }],
					timestamp: "2024-01-01T00:00:01.000Z",
				},
				{
					kind: "tool_result",
					toolUseId: "toolu_synthetic_1",
					text: "# Example project\n\nA synthetic readme.",
					isError: false,
					timestamp: "2024-01-01T00:00:02.000Z",
				},
				{
					kind: "assistant",
					text: "",
					tools: [{ id: "toolu_synthetic_2", claudeName: "Bash", input: { command: "ls" } }],
				},
				{ kind: "tool_result", toolUseId: "", text: "readme.md", isError: true },
				{ kind: "summary", text: "The user asked for a greeting in the readme.", timestamp: "2024-01-01T00:00:03.000Z" },
			],
			{
				cwd: "/workspace/example-project",
				gitBranch: "main",
				title: "Synthetic fixture session",
				firstTimestamp: "2024-01-01T00:00:00.000Z",
				models: ["claude-synthetic-a", "claude-synthetic-b"],
			},
		);

		const expected = [
			"# Claude Code session synthetic-session-1",
			"- title: Synthetic fixture session",
			"- cwd: /workspace/example-project",
			"- git branch: main",
			"- model(s): claude-synthetic-a, claude-synthetic-b",
			"- session started: 2024-01-01T00:00:00.000Z",
			"",
			"## User (2024-01-01T00:00:00.000Z)",
			"Add a greeting to the readme.",
			"",
			"## Assistant (2024-01-01T00:00:01.000Z)",
			"I will look at the readme first.",
			"",
			'- tool read({"path":"README.md"})',
			"",
			"## Tool result (2024-01-01T00:00:02.000Z)",
			"- for toolu_synthetic_1: ok",
			"# Example project",
			"",
			"A synthetic readme.",
			"",
			"## Assistant (unknown)",
			"(no text)",
			"",
			'- tool bash({"command":"ls"})',
			"",
			"## Tool result (unknown)",
			"- for unknown tool call: error",
			"readme.md",
			"",
			"## Summary (2024-01-01T00:00:03.000Z)",
			"The user asked for a greeting in the readme.",
		].join("\n");

		const result = render(transcript);
		expect(result.text).toBe(expected);
		expect(result.chars).toBe(725);
		expect(result.estimatedTokens).toBe(182);
		expect(result.truncated).toBe(false);
	});
});
