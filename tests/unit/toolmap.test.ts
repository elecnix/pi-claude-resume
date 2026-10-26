/**
 * One test per mapping row plus every edge case of the Claude -> pi tool translation (DP7, DR4).
 *
 * All fixture values are hand-written and synthetic: no real session, prompt, path or code from
 * any machine appears here (DP12).
 */
import { describe, expect, it } from "vitest";
import {
	BOOKKEEPING_TOOLS,
	CLAUDE_ARG_KEY_MAP,
	CLAUDE_TO_PI_TOOL,
	DROPPED_ARG_KEYS,
	PI_CORE_TOOLS,
	PLACEHOLDER_TOOL,
	mapToolCall,
	quoteForShell,
} from "../../src/claude/toolmap.ts";

const SHELL_QUOTE_ESCAPE = `'"'"'`;

describe("PI_CORE_TOOLS", () => {
	it("lists pi's real built-in tools and nothing else", () => {
		// pi's core tool set; `subagent` and `intercom` are extensions, not built-ins (DP7).
		expect([...PI_CORE_TOOLS]).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
			"powershell",
		]);
		expect(PI_CORE_TOOLS).not.toContain("subagent");
		expect(PI_CORE_TOOLS).not.toContain("intercom");
	});

	it("has no duplicates", () => {
		expect(new Set(PI_CORE_TOOLS).size).toBe(PI_CORE_TOOLS.length);
	});

	it("contains the placeholder tool", () => {
		expect(PI_CORE_TOOLS).toContain(PLACEHOLDER_TOOL);
	});
});

describe("CLAUDE_TO_PI_TOOL rows", () => {
	it("declares only non-empty pi tool names", () => {
		for (const [claudeName, piName] of Object.entries(CLAUDE_TO_PI_TOOL)) {
			expect(claudeName.length, "claude name must not be empty").toBeGreaterThan(0);
			expect(piName.length, `pi name for ${claudeName} must not be empty`).toBeGreaterThan(0);
		}
	});

	it("keeps every argument-shape table row addressable", () => {
		for (const claudeName of Object.keys(CLAUDE_ARG_KEY_MAP)) {
			expect(CLAUDE_TO_PI_TOOL[claudeName], `${claudeName} has args but no tool row`).toBeTruthy();
		}
	});

	it("declares every bookkeeping tool as a mapped row", () => {
		for (const claudeName of BOOKKEEPING_TOOLS) {
			expect(CLAUDE_TO_PI_TOOL[claudeName]).toBe(PLACEHOLDER_TOOL);
		}
	});

	describe.each(Object.entries(CLAUDE_TO_PI_TOOL))("%s", (claudeName, piName) => {
		it(`maps to ${piName}`, () => {
			const mapping = mapToolCall(claudeName, {});
			expect(mapping.piName).toBe(piName);
			expect(Array.isArray(mapping.notes)).toBe(true);
		});
	});
});

describe("CLAUDE_ARG_KEY_MAP rows", () => {
	describe.each(
		Object.entries(CLAUDE_ARG_KEY_MAP).flatMap(([claudeName, keys]) =>
			Object.entries(keys).map(([claudeKey, piKey]) => [claudeName, claudeKey, piKey] as const),
		),
	)("%s renames %s", (claudeName, claudeKey, piKey) => {
		it(`to ${piKey}`, () => {
			const mapping = mapToolCall(claudeName, { [claudeKey]: "/tmp/synthetic", content: "x" });
			expect(mapping.input[piKey]).toBe("/tmp/synthetic");
			expect(mapping.input[claudeKey]).toBeUndefined();
		});
	});
});

describe("DROPPED_ARG_KEYS", () => {
	it("declares the Claude-only keys", () => {
		for (const key of ["description", "explanation", "summary", "header", "replace_all", "danger_mode", "enable_auto_approve"]) {
			expect(DROPPED_ARG_KEYS.has(key), `${key} should be dropped`).toBe(true);
		}
	});

	describe.each([...DROPPED_ARG_KEYS])("dropping %s", (dropped) => {
		it("really is dropped from a known tool's arguments", () => {
			const mapping = mapToolCall("Bash", { command: "true", [dropped]: "synthetic-value" });
			expect(mapping.piName).toBe("bash");
			expect(mapping.input).not.toHaveProperty(dropped);
			expect(mapping.input.command).toBe("true");
		});
	});
});

describe("Bash", () => {
	it("keeps command and timeout", () => {
		const mapping = mapToolCall("Bash", { command: "ls -1", timeout: 5_000 });
		expect(mapping.piName).toBe("bash");
		expect(mapping.input).toEqual({ command: "ls -1", timeout: 5_000 });
		expect(mapping.notes).toEqual([]);
	});

	it("drops Claude's description", () => {
		const mapping = mapToolCall("Bash", { command: "ls", description: "List files" });
		expect(mapping.input).toEqual({ command: "ls" });
	});

	it("notes a missing command instead of inventing one", () => {
		const mapping = mapToolCall("Bash", { description: "List files" });
		expect(mapping.input).toEqual({});
		expect(mapping.notes.join(" ")).toContain("command");
	});

	it("passes unknown keys through unchanged", () => {
		const mapping = mapToolCall("Bash", { command: "ls", cwd: "/tmp/synthetic" });
		expect(mapping.input).toEqual({ command: "ls", cwd: "/tmp/synthetic" });
	});
});

describe("Read", () => {
	it("renames file_path to path", () => {
		const mapping = mapToolCall("Read", { file_path: "/tmp/synthetic/a.txt" });
		expect(mapping.piName).toBe("read");
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt" });
	});

	it("keeps offset and limit", () => {
		const mapping = mapToolCall("Read", { file_path: "/tmp/synthetic/a.txt", offset: 10, limit: 20 });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt", offset: 10, limit: 20 });
	});

	it("notes a missing file_path", () => {
		const mapping = mapToolCall("Read", { offset: 3 });
		expect(mapping.input).toEqual({ offset: 3 });
		expect(mapping.notes.join(" ")).toContain("file_path");
	});

	it("passes unknown keys through unchanged", () => {
		const mapping = mapToolCall("Read", { file_path: "/tmp/synthetic/a.txt", pages: "1-2" });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt", pages: "1-2" });
	});
});

describe("Write", () => {
	it("renames file_path to path and keeps content", () => {
		const mapping = mapToolCall("Write", { file_path: "/tmp/synthetic/a.txt", content: "line one\nline two" });
		expect(mapping.piName).toBe("write");
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt", content: "line one\nline two" });
	});

	it("notes a missing content", () => {
		const mapping = mapToolCall("Write", { file_path: "/tmp/synthetic/a.txt" });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt" });
		expect(mapping.notes.join(" ")).toContain("content");
	});
});

describe("Edit", () => {
	it("turns old_string/new_string into a single edits entry", () => {
		const mapping = mapToolCall("Edit", {
			file_path: "/tmp/synthetic/a.txt",
			old_string: "before",
			new_string: "after",
		});
		expect(mapping.piName).toBe("edit");
		expect(mapping.input).toEqual({
			path: "/tmp/synthetic/a.txt",
			edits: [{ oldText: "before", newText: "after" }],
		});
		expect(mapping.notes).toEqual([]);
	});

	it("drops replace_all and says so", () => {
		const mapping = mapToolCall("Edit", {
			file_path: "/tmp/synthetic/a.txt",
			old_string: "a",
			new_string: "b",
			replace_all: true,
		});
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt", edits: [{ oldText: "a", newText: "b" }] });
		expect(mapping.input).not.toHaveProperty("replace_all");
		expect(mapping.notes.join(" ")).toContain("replace_all");
	});

	it("keeps the path and notes a missing old/new pair", () => {
		const mapping = mapToolCall("Edit", { file_path: "/tmp/synthetic/a.txt", replace_all: false });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt" });
		expect(mapping.input).not.toHaveProperty("edits");
		expect(mapping.notes.join(" ")).toContain("old_string");
	});

	it("notes a missing file_path", () => {
		const mapping = mapToolCall("Edit", { old_string: "a", new_string: "b" });
		expect(mapping.input).toEqual({ edits: [{ oldText: "a", newText: "b" }] });
		expect(mapping.notes.join(" ")).toContain("file_path");
	});

	it("passes an unknown key through unchanged", () => {
		const mapping = mapToolCall("Edit", {
			file_path: "/tmp/synthetic/a.txt",
			old_string: "a",
			new_string: "b",
			note: "synthetic",
		});
		expect(mapping.input.note).toBe("synthetic");
	});
});

describe("MultiEdit", () => {
	it("converts every old_string/new_string pair", () => {
		const mapping = mapToolCall("MultiEdit", {
			file_path: "/tmp/synthetic/a.txt",
			edits: [
				{ old_string: "one", new_string: "1" },
				{ old_string: "two", new_string: "2" },
				{ old_string: "three", new_string: "3" },
			],
		});
		expect(mapping.piName).toBe("edit");
		expect(mapping.input).toEqual({
			path: "/tmp/synthetic/a.txt",
			edits: [
				{ oldText: "one", newText: "1" },
				{ oldText: "two", newText: "2" },
				{ oldText: "three", newText: "3" },
			],
		});
		expect(mapping.notes).toEqual([]);
	});

	it("skips unusable edits and reports how many", () => {
		const mapping = mapToolCall("MultiEdit", {
			file_path: "/tmp/synthetic/a.txt",
			edits: [{ old_string: "one", new_string: "1" }, { old_string: "lonely" }, "not-an-object"],
		});
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt", edits: [{ oldText: "one", newText: "1" }] });
		expect(mapping.notes.join(" ")).toContain("2 edit(s)");
	});

	it("notes a missing edits array", () => {
		const mapping = mapToolCall("MultiEdit", { file_path: "/tmp/synthetic/a.txt", edits: "nope" });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt" });
		expect(mapping.notes.join(" ")).toContain("edits array");
	});

	it("notes an empty edits array", () => {
		const mapping = mapToolCall("MultiEdit", { file_path: "/tmp/synthetic/a.txt", edits: [] });
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/a.txt" });
		expect(mapping.notes.join(" ")).toContain("empty edits array");
	});
});

describe("NotebookEdit", () => {
	it("keeps only the notebook path and declares the loss", () => {
		const mapping = mapToolCall("NotebookEdit", {
			notebook_path: "/tmp/synthetic/nb.ipynb",
			cell_id: "cell-1",
			new_source: "print(1)",
			edit_mode: "replace",
		});
		expect(mapping.piName).toBe("edit");
		expect(mapping.input).toEqual({ path: "/tmp/synthetic/nb.ipynb" });
		expect(mapping.notes.join(" ")).toContain("notebook cell");
	});

	it("notes a missing notebook_path", () => {
		const mapping = mapToolCall("NotebookEdit", { cell_id: "cell-1" });
		expect(mapping.input).toEqual({});
		expect(mapping.notes.join(" ")).toContain("notebook_path");
	});
});

describe("Grep command generation", () => {
	it("builds a plain rg command", () => {
		expect(mapToolCall("Grep", { pattern: "TODO" }).input.command).toBe("rg -n -- 'TODO'");
	});

	it("adds -i when case-insensitive search was requested", () => {
		expect(mapToolCall("Grep", { pattern: "todo", "-i": true }).input.command).toBe("rg -n -i -- 'todo'");
	});

	it("does not add -i when the flag is false", () => {
		expect(mapToolCall("Grep", { pattern: "todo", "-i": false }).input.command).toBe("rg -n -- 'todo'");
	});

	it("adds the glob as a -g filter", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", glob: "*.ts" }).input.command).toBe(
			"rg -n -g '*.ts' -- 'TODO'",
		);
	});

	it("appends a quoted path", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", path: "/tmp/synthetic/src" }).input.command).toBe(
			"rg -n -- 'TODO' '/tmp/synthetic/src'",
		);
	});

	it("notes a missing pattern", () => {
		const mapping = mapToolCall("Grep", { path: "/tmp/synthetic" });
		expect(mapping.input.command).toBe("rg -n");
		expect(mapping.notes.join(" ")).toContain("pattern");
	});

	it("declares output_mode it did not translate", () => {
		const mapping = mapToolCall("Grep", { pattern: "TODO", output_mode: "files_with_matches" });
		expect(mapping.notes.join(" ")).toContain("files_with_matches");
	});

	it("translates -A into rg's after-context flag", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", "-A": 2 }).input.command).toBe(
			"rg -n -A 2 -- 'TODO'",
		);
	});

	it("translates -B into rg's before-context flag", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", "-B": 3 }).input.command).toBe(
			"rg -n -B 3 -- 'TODO'",
		);
	});

	it("translates -C into rg's context flag", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", "-C": 1 }).input.command).toBe(
			"rg -n -C 1 -- 'TODO'",
		);
	});

	it("keeps every context flag alongside -i and the glob filter", () => {
		expect(
			mapToolCall("Grep", { pattern: "todo", "-i": true, glob: "*.ts", "-A": 2, "-B": 1, "-C": 3 })
				.input.command,
		).toBe("rg -n -i -g '*.ts' -A 2 -B 1 -C 3 -- 'todo'");
	});

	it("accepts a context count written as a string, as Claude Code stores it", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", "-A": "4" }).input.command).toBe(
			"rg -n -A 4 -- 'TODO'",
		);
	});

	it("declares a -A value that is not a line count instead of passing it to rg", () => {
		const mapping = mapToolCall("Grep", { pattern: "TODO", "-A": "two" });
		expect(mapping.input.command).toBe("rg -n -- 'TODO'");
		expect(mapping.notes.join(" ")).toContain("-A");
		expect(mapping.notes.join(" ")).toContain("not a positive whole number");
	});

	it("translates multiline into rg's -U flag", () => {
		expect(mapToolCall("Grep", { pattern: "^a$", multiline: true }).input.command).toBe(
			"rg -n -U -- '^a$'",
		);
	});

	it("does not add -U when multiline is false or absent", () => {
		expect(mapToolCall("Grep", { pattern: "todo", multiline: false }).input.command).toBe(
			"rg -n -- 'todo'",
		);
		expect(mapToolCall("Grep", { pattern: "todo" }).input.command).toBe("rg -n -- 'todo'");
	});

	it("declares head_limit instead of dropping it silently", () => {
		const mapping = mapToolCall("Grep", { pattern: "TODO", head_limit: 25 });
		expect(mapping.input.command).toBe("rg -n -- 'TODO'");
		expect(mapping.notes.join(" ")).toContain("head_limit of 25");
		expect(mapping.notes.join(" ")).toContain("prints every match");
	});

	it("keeps rg's always-on line numbers and says so when Claude asked for none", () => {
		expect(mapToolCall("Grep", { pattern: "TODO", "-n": true }).input.command).toBe(
			"rg -n -- 'TODO'",
		);
		const mapping = mapToolCall("Grep", { pattern: "TODO", "-n": false });
		expect(mapping.input.command).toBe("rg -n -- 'TODO'");
		expect(mapping.notes.join(" ")).toContain("always prints line numbers");
	});

	it("names an argument it has no translation for, rather than dropping it", () => {
		// `type` is Claude's file-type filter; the generated rg line does not carry it.
		const mapping = mapToolCall("Grep", { pattern: "TODO", type: "ts", offset: 5 });
		expect(mapping.input.command).toBe("rg -n -- 'TODO'");
		expect(mapping.notes.join(" ")).toContain("type, offset");
		expect(mapping.notes.join(" ")).toContain("not translated");
	});

	it("stays inert for a hostile pattern", () => {
		const command = mapToolCall("Grep", { pattern: "$(rm -rf /tmp/x); `id`", path: "/tmp/synthetic" })
			.input.command as string;
		expect(command).toContain(`'\$(rm -rf /tmp/x); \`id\`'`);
		expect(command.split("\n")).toHaveLength(1);
	});
});

describe("Glob command generation", () => {
	it("builds an rg --files command", () => {
		expect(mapToolCall("Glob", { pattern: "**/*.ts" }).input.command).toBe("rg --files -g '**/*.ts'");
	});

	it("appends a quoted path", () => {
		expect(mapToolCall("Glob", { pattern: "**/*.ts", path: "/tmp/synthetic/src" }).input.command).toBe(
			"rg --files -g '**/*.ts' '/tmp/synthetic/src'",
		);
	});

	it("notes a missing pattern", () => {
		const mapping = mapToolCall("Glob", {});
		expect(mapping.input.command).toBe("rg --files");
		expect(mapping.notes.join(" ")).toContain("pattern");
	});

	it("declares head_limit instead of dropping it silently", () => {
		const mapping = mapToolCall("Glob", { pattern: "**/*.ts", head_limit: 10 });
		expect(mapping.input.command).toBe("rg --files -g '**/*.ts'");
		expect(mapping.notes.join(" ")).toContain("head_limit");
		expect(mapping.notes.join(" ")).toContain("lists every matching file");
	});

	it("names an argument it has no translation for, rather than dropping it", () => {
		const mapping = mapToolCall("Glob", { pattern: "**/*.ts", type: "ts" });
		expect(mapping.input.command).toBe("rg --files -g '**/*.ts'");
		expect(mapping.notes.join(" ")).toContain("type");
		expect(mapping.notes.join(" ")).toContain("not translated");
	});

	it("declares a multiline flag, which a file listing cannot honour", () => {
		const mapping = mapToolCall("Glob", { pattern: "**/*.ts", multiline: true });
		expect(mapping.input.command).toBe("rg --files -g '**/*.ts'");
		expect(mapping.notes.join(" ")).toContain("multiline");
	});
});

describe("LS command generation", () => {
	it("lists the current directory when no path is given", () => {
		expect(mapToolCall("LS", {}).input.command).toBe("ls -la");
	});

	it("lists a quoted path", () => {
		expect(mapToolCall("LS", { path: "/tmp/synthetic dir" }).input.command).toBe("ls -la '/tmp/synthetic dir'");
	});
});

describe("Task and Agent", () => {
	it("renames subagent_type to agent and prompt to task", () => {
		expect(mapToolCall("Task", { subagent_type: "explore", description: "Look", prompt: "Find it" })).toEqual({
			piName: "subagent",
			input: { agent: "explore", task: "Find it" },
			notes: [],
		});
	});

	it("maps Agent the same way", () => {
		expect(mapToolCall("Agent", { subagent_type: "explore", prompt: "Find it" }).input).toEqual({
			agent: "explore",
			task: "Find it",
		});
	});

	it("keeps only the task when no subagent_type was given", () => {
		expect(mapToolCall("Task", { task: "ignored", prompt: "Find it" }).input).toEqual({ task: "Find it" });
	});

	it("notes a missing prompt instead of inventing one", () => {
		const mapping = mapToolCall("Task", { subagent_type: "explore", description: "Look" });
		expect(mapping.input).toEqual({ agent: "explore" });
		expect(mapping.notes.join(" ")).toContain("prompt");
	});
});

describe("SendMessage", () => {
	it("becomes an intercom send", () => {
		expect(mapToolCall("SendMessage", { to: "peer", message: "hello", summary: "greeting" })).toEqual({
			piName: "intercom",
			input: { action: "send", to: "peer", message: "hello" },
			notes: [],
		});
	});

	it("notes a missing recipient", () => {
		const mapping = mapToolCall("SendMessage", { message: "hello" });
		expect(mapping.input).toEqual({ action: "send", message: "hello" });
		expect(mapping.notes.join(" ")).toContain("recipient");
	});

	it("notes a missing message", () => {
		const mapping = mapToolCall("SendMessage", { to: "peer" });
		expect(mapping.notes.join(" ")).toContain("message");
	});
});

describe("bookkeeping tools", () => {
	describe.each([...BOOKKEEPING_TOOLS])("%s", (claudeName) => {
		it("becomes a declared, inert placeholder that names the tool", () => {
			const mapping = mapToolCall(claudeName, { todos: [{ content: "x" }], bash_id: "b-1" });
			expect(mapping.piName).toBe(PLACEHOLDER_TOOL);
			expect(mapping.input.command).toBe(`: '${claudeName} was not representable as a pi tool call'`);
			expect(mapping.notes.join(" ")).toContain(claudeName);
			expect(mapping.notes.join(" ")).toContain("placeholder");
		});
	});

	it("never invents a plausible command for TodoWrite", () => {
		const mapping = mapToolCall("TodoWrite", { todos: [{ content: "synthetic" }] });
		expect(mapping.input.command).not.toContain("synthetic");
	});
});

describe("unknown tools", () => {
	it("degrade to the declared placeholder with a note", () => {
		const mapping = mapToolCall("Teleport", { destination: "/tmp/synthetic" });
		expect(mapping.piName).toBe(PLACEHOLDER_TOOL);
		expect(mapping.notes.length).toBeGreaterThan(0);
		expect(mapping.notes.join(" ")).toContain("Teleport");
	});

	it("keep the placeholder command inert and single-line", () => {
		const mapping = mapToolCall("Multi\nLine; $(whoami)", { a: 1 });
		const command = mapping.input.command as string;
		expect(command.startsWith(": '")).toBe(true);
		expect(command.split("\n")).toHaveLength(1);
		expect(command).not.toContain("\n");
	});

	it("do not carry unknown arguments into the placeholder", () => {
		const mapping = mapToolCall("Teleport", { destination: "/tmp/synthetic" });
		expect(mapping.input).toEqual({ command: expect.stringContaining("Teleport") });
	});

	it("are not resolved out of the table prototype", () => {
		for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
			const mapping = mapToolCall(name, { command: "true" });
			expect(mapping.piName).toBe(PLACEHOLDER_TOOL);
			expect(typeof mapping.input.command).toBe("string");
			expect(mapping.notes.length).toBeGreaterThan(0);
		}
	});
});

describe("non-object input", () => {
	describe.each([
		["null", null],
		["undefined", undefined],
		["string", "not-an-object"],
		["array", ["a", "b"]],
		["number", 42],
		["boolean", true],
	])("with %s", (_label, value) => {
		it("yields an empty input object and a note", () => {
			const mapping = mapToolCall("Bash", value);
			expect(mapping.piName).toBe("bash");
			expect(mapping.input).toEqual({});
			expect(mapping.notes.join(" ")).toContain("not an object");
		});
	});

	it("keeps the declared placeholder for an unknown tool with no arguments", () => {
		const mapping = mapToolCall("Teleport", null);
		expect(mapping.piName).toBe(PLACEHOLDER_TOOL);
		expect(mapping.input).toEqual({});
		expect(mapping.notes.length).toBeGreaterThan(1);
	});
});

describe("never throws", () => {
	const hostileInputs: Array<[string, unknown]> = [
		["circular", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
		["throwing getter", { get command(): string { throw new Error("boom"); } }],
		["throwing proxy", new Proxy({}, { ownKeys() { throw new Error("nope"); }, get() { throw new Error("nope"); } })],
		["huge string", "x".repeat(200_000)],
		["deep nesting", { file_path: "/tmp/synthetic", a: { b: { c: { d: true } } } }],
		["bigint values", { command: 10n }],
		["symbol keys", { [Symbol("k")]: "v", command: "true" }],
		["empty object", {}],
	];

	describe.each(hostileInputs)("with %s", (_label, value) => {
		it("returns a mapping for every Claude tool name", () => {
			for (const claudeName of [...Object.keys(CLAUDE_TO_PI_TOOL), "Teleport", ""]) {
				const mapping = mapToolCall(claudeName, value);
				expect(typeof mapping.piName).toBe("string");
				expect(mapping.piName.length).toBeGreaterThan(0);
				expect(Array.isArray(mapping.notes)).toBe(true);
				expect(typeof mapping.input).toBe("object");
				expect(mapping.input).not.toBeNull();
			}
		});
	});

	it("survives a non-string tool name", () => {
		for (const claudeName of [undefined, null, 42, {}, []] as unknown as string[]) {
			expect(() => mapToolCall(claudeName, { command: "true" })).not.toThrow();
		}
	});

	it("does not let a __proto__ argument key pollute the input object", () => {
		const args = JSON.parse('{"file_path":"/tmp/synthetic/a.txt","__proto__":{"polluted":true}}') as Record<
			string,
			unknown
		>;
		const mapping = mapToolCall("Read", args);
		expect(Object.getPrototypeOf(mapping.input)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(mapping.input.path).toBe("/tmp/synthetic/a.txt");
	});
});

describe("quoteForShell", () => {
	it("wraps a plain value in single quotes", () => {
		expect(quoteForShell("/tmp/synthetic")).toBe("'/tmp/synthetic'");
	});

	it("escapes embedded single quotes", () => {
		expect(quoteForShell("it's")).toBe(`'it${SHELL_QUOTE_ESCAPE}s'`);
	});

	it("neutralises backticks and $()", () => {
		expect(quoteForShell("`id` $(whoami)")).toBe("'`id` $(whoami)'");
	});

	it("neutralises separators", () => {
		expect(quoteForShell("a; b && c | d")).toBe("'a; b && c | d'");
	});

	it("collapses newlines to a single line", () => {
		expect(quoteForShell("one\ntwo\r\nthree")).toBe("'one two three'");
	});

	it("quotes the empty string", () => {
		expect(quoteForShell("")).toBe("''");
	});

	it("escapes quotes next to newlines", () => {
		expect(quoteForShell("a'\nb")).toBe(`'a${SHELL_QUOTE_ESCAPE} b'`);
	});
});
