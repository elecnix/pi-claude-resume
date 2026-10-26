/**
 * Claude Code tool names and argument shapes -> pi tool names and argument shapes (DP7, DR4).
 *
 * The tables are data. An unmapped tool degrades to a declared placeholder, never to a
 * plausible-looking lie and never to an exception. Commands generated for `Grep`, `Glob` and
 * `LS` are inert text handed to pi's `bash` tool; this module never executes anything.
 *
 * Nothing here touches the filesystem, the clock, the network or pi (DP3).
 */
import type { ToolMapper, ToolMapping } from "../types.ts";

/**
 * pi's built-in tool names, and nothing else: no `subagent`, no `intercom` -- those arrive with
 * optional extensions that a bare `pi` install does not have.
 *
 * The renderer judges a mapped call against the list the host reports for the session
 * (`pi.getActiveTools()`, threaded through `RenderOptions.piTools`) and falls back to this one
 * only when a caller renders without a runtime list. It is a *fallback*, not the source of truth:
 * marking a call unavailable is a claim about this session, and the runtime list is the only
 * honest source for it (DP7, DP8).
 */
export const PI_CORE_TOOLS: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"powershell",
];

/** Tool name used when a Claude tool has no pi equivalent. */
export const PLACEHOLDER_TOOL = "bash";

/** Claude tool name -> pi tool name. */
export const CLAUDE_TO_PI_TOOL: Readonly<Record<string, string>> = {
	Bash: "bash",
	BashOutput: "bash",
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	NotebookEdit: "edit",
	Grep: "bash",
	Glob: "bash",
	LS: "bash",
	Task: "subagent",
	Agent: "subagent",
	SendMessage: "intercom",
	TodoWrite: "bash",
	KillShell: "bash",
};

/** Claude tool name -> { claude argument key: pi argument key }. */
export const CLAUDE_ARG_KEY_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	Bash: {},
	Read: { file_path: "path" },
	Write: { file_path: "path" },
};

/** Argument keys that only make sense inside Claude Code, dropped on the way in. */
export const DROPPED_ARG_KEYS: ReadonlySet<string> = new Set<string>([
	"description",
	"explanation",
	"summary",
	"header",
	"replace_all",
	"danger_mode",
	"enable_auto_approve",
	"output_mode",
	"run_in_background",
]);

/**
 * Claude tools that are bookkeeping rather than actions: there is no faithful pi call, so they
 * are rendered as a declared, inert placeholder instead of a plausible-looking shell command.
 */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set<string>([
	"TodoWrite",
	"BashOutput",
	"KillShell",
]);

/** Argument keys a table-driven tool cannot work without; a missing one is reported, not invented. */
const REQUIRED_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
	Bash: ["command"],
	Read: ["file_path"],
	Write: ["file_path", "content"],
};

type Args = Record<string, unknown>;
interface Built {
	input: Args;
	notes: string[];
}

/** Argument keys consumed by a dedicated shape builder, so they never leak through verbatim. */
const EDIT_CONSUMED: ReadonlySet<string> = new Set(["file_path", "old_string", "new_string"]);
const MULTI_EDIT_CONSUMED: ReadonlySet<string> = new Set(["file_path", "edits"]);
const NOTEBOOK_EDIT_CONSUMED: ReadonlySet<string> = new Set([
	"notebook_path",
	"file_path",
	"cell_id",
	"new_source",
	"edit_mode",
	"cell_type",
]);
const TASK_CONSUMED: ReadonlySet<string> = new Set(["subagent_type", "prompt"]);
const GREP_CONSUMED: ReadonlySet<string> = new Set([
	"pattern",
	"path",
	"glob",
	"-i",
	"-A",
	"-B",
	"-C",
	"multiline",
	"output_mode",
	"head_limit",
]);
const GLOB_CONSUMED: ReadonlySet<string> = new Set(["pattern", "path", "head_limit", "multiline"]);
const SEND_MESSAGE_CONSUMED: ReadonlySet<string> = new Set(["to", "message"]);

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029]/g;

/** Collapse line breaks so a quoted value can never split an inert command in two. */
const collapseLineBreaks = (value: string): string => value.replace(LINE_BREAKS, " ");

/**
 * Quote one value for a POSIX shell: always single-quoted, with embedded single quotes closed,
 * escaped and reopened (`'"'"'`). Backticks, `$`, `;`, `&`, `|` and newlines lose all meaning.
 */
export function quoteForShell(value: string): string {
	return `'${collapseLineBreaks(value).replaceAll("'", `'"'"'`)}'`;
}

/** Define an own enumerable property without tripping the `__proto__` setter. */
const setArg = (target: Args, key: string, value: unknown): void => {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
};

const isArgs = (value: unknown): value is Args =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const hasText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Copy the keys a builder did not interpret; a computed pi key always wins over one copied through. */
const copyExtras = (input: Args, args: Args, consumed: ReadonlySet<string>): void => {
	for (const [key, value] of Object.entries(args)) {
		if (consumed.has(key) || DROPPED_ARG_KEYS.has(key)) continue;
		if (Object.hasOwn(input, key)) continue;
		setArg(input, key, value);
	}
};

/**
 * Name every argument a builder did not interpret. A generated command that quietly ignores input
 * is the silent lie DP7 forbids, and a fixed list of known-untranslatable keys would go stale the
 * next time Claude Code adds one.
 */
function noteUnconsumed(
	args: Args,
	consumed: ReadonlySet<string>,
	notes: string[],
	claudeName: string,
): void {
	const remaining = Object.keys(args).filter((key) => !consumed.has(key));
	if (remaining.length === 0) return;
	notes.push(
		`${claudeName} arguments ${remaining.join(", ")} had no counterpart in the generated command and were not translated.`,
	);
}

/** A single-line, inert command that names the tool it stands in for. Never runs anything. */
const inertCommand = (claudeName: string): string =>
	`: ${quoteForShell(`${hasText(claudeName) ? claudeName : "(unnamed tool)"} was not representable as a pi tool call`)}`;

function placeholderMapping(claudeName: string, notes: string[]): ToolMapping {
	return {
		piName: PLACEHOLDER_TOOL,
		input: { command: inertCommand(claudeName) },
		notes,
	};
}

// ---------------------------------------------------------------------------
// Dedicated shape builders: Claude argument shapes that are not a key-for-key rename
// ---------------------------------------------------------------------------

function buildEdit(args: Args): Built {
	const input: Args = {};
	const notes: string[] = [];

	if (hasText(args.file_path)) setArg(input, "path", args.file_path);
	else notes.push("Edit arguments carried no file_path, so the pi edit call has no path.");

	const oldText = args.old_string;
	const newText = args.new_string;
	if (typeof oldText === "string" && typeof newText === "string") {
		setArg(input, "edits", [{ oldText, newText }]);
	} else {
		notes.push("Edit carried no usable old_string/new_string pair, so the replacement was not carried over.");
	}

	if (args.replace_all === true) {
		notes.push("Edit's replace_all flag has no pi equivalent and was dropped.");
	}

	copyExtras(input, args, EDIT_CONSUMED);
	return { input, notes };
}

function buildMultiEdit(args: Args): Built {
	const input: Args = {};
	const notes: string[] = [];

	if (hasText(args.file_path)) setArg(input, "path", args.file_path);
	else notes.push("MultiEdit arguments carried no file_path, so the pi edit call has no path.");

	const rawEdits = args.edits;
	if (Array.isArray(rawEdits)) {
		const edits: Args[] = [];
		let skipped = 0;
		for (const entry of rawEdits) {
			if (!isArgs(entry)) {
				skipped += 1;
				continue;
			}
			const oldText = entry.old_string;
			const newText = entry.new_string;
			if (typeof oldText === "string" && typeof newText === "string") edits.push({ oldText, newText });
			else skipped += 1;
		}
		if (edits.length > 0) setArg(input, "edits", edits);
		if (skipped > 0) {
			notes.push(`MultiEdit carried ${skipped} edit(s) without an old_string/new_string pair; they were not carried over.`);
		}
		if (rawEdits.length === 0) notes.push("MultiEdit carried an empty edits array.");
	} else {
		notes.push("MultiEdit arguments carried no edits array, so no replacements were carried over.");
	}

	copyExtras(input, args, MULTI_EDIT_CONSUMED);
	return { input, notes };
}

function buildNotebookEdit(args: Args): Built {
	const input: Args = {};
	const notes: string[] = [];

	const path = hasText(args.notebook_path) ? args.notebook_path : args.file_path;
	if (hasText(path)) setArg(input, "path", path);
	else notes.push("NotebookEdit arguments carried no notebook_path, so the pi edit call has no path.");

	notes.push("NotebookEdit changes one notebook cell; pi has no notebook cell model, so only the notebook path was carried over.");

	copyExtras(input, args, NOTEBOOK_EDIT_CONSUMED);
	return { input, notes };
}

/** A positive whole number of lines, or undefined: `-A 2` is a count, `-A two` is not. */
function lineCount(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value.trim())
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * `-A`, `-B` and `-C` are rg's own context flags, so they carry over verbatim (DP7). A value that
 * is not a line count is declared rather than passed on as something rg would misread.
 */
function addContextFlags(parts: string[], args: Args, notes: string[]): void {
	for (const flag of ["-A", "-B", "-C"] as const) {
		const value = args[flag];
		if (value === undefined) continue;
		const lines = lineCount(value);
		if (lines === undefined) {
			notes.push(`Grep's ${flag} value was not a positive whole number of lines, so it was not translated.`);
			continue;
		}
		parts.push(flag, String(lines));
	}
}

function buildGrep(args: Args): Built {
	const notes: string[] = [];
	const parts: string[] = ["rg", "-n"];

	if (args["-i"] === true) parts.push("-i");
	if (hasText(args.glob)) parts.push("-g", quoteForShell(args.glob));
	addContextFlags(parts, args, notes);

	// rg's own multiline switch; anything other than `true` means Claude did not ask for it.
	if (args.multiline === true) {
		parts.push("-U");
	} else if (args.multiline !== undefined && args.multiline !== false) {
		notes.push("Grep's multiline flag was not a boolean, so it was not translated.");
	}

	if (hasText(args.pattern)) {
		parts.push("--", quoteForShell(args.pattern));
		if (hasText(args.path)) parts.push(quoteForShell(args.path));
	} else {
		notes.push("Grep arguments carried no pattern, so the generated rg command cannot run.");
	}

	const outputMode = args.output_mode;
	if (typeof outputMode === "string" && outputMode !== "content") {
		notes.push(`Grep's output_mode "${outputMode}" was not translated; the generated command prints matching lines.`);
	}

	// head_limit caps how many result lines Claude Code showed. Cutting the stream would need a
	// shell pipeline, which would change what the recorded command means, so it is declared, not
	// invented (DP7).
	const headLimit = args.head_limit;
	if (headLimit !== undefined && headLimit !== null) {
		const lines = lineCount(headLimit);
		notes.push(
			lines === undefined
				? "Grep's head_limit was not a positive whole number of lines, so it was not translated."
				: `Grep's head_limit of ${lines} was not translated; the generated command prints every match.`,
		);
	}

	noteUnconsumed(args, GREP_CONSUMED, notes, "Grep");
	return { input: { command: parts.join(" ") }, notes };
}

function buildGlob(args: Args): Built {
	const notes: string[] = [];
	const parts: string[] = ["rg", "--files"];

	if (hasText(args.pattern)) parts.push("-g", quoteForShell(args.pattern));
	else notes.push("Glob arguments carried no pattern, so the generated rg command cannot run.");
	if (hasText(args.path)) parts.push(quoteForShell(args.path));

	// A file listing has nothing to truncate per match and no use for multiline patterns. If Claude
	// Code ever sends them, the transcript says they were dropped instead of losing them silently.
	if (args.head_limit !== undefined && args.head_limit !== null) {
		notes.push("Glob's head_limit was not translated; the generated command lists every matching file.");
	}
	if (args.multiline === true) {
		notes.push("Glob's multiline flag has no meaning when listing files, so it was not translated.");
	}

	noteUnconsumed(args, GLOB_CONSUMED, notes, "Glob");
	return { input: { command: parts.join(" ") }, notes };
}

function buildLs(args: Args): Built {
	const parts: string[] = ["ls", "-la"];
	if (hasText(args.path)) parts.push(quoteForShell(args.path));
	return { input: { command: parts.join(" ") }, notes: [] };
}

function buildTask(args: Args): Built {
	const input: Args = {};
	const notes: string[] = [];

	if (hasText(args.subagent_type)) setArg(input, "agent", args.subagent_type);
	if (hasText(args.prompt)) setArg(input, "task", args.prompt);
	else notes.push("Task arguments carried no prompt, so the pi task was left empty rather than invented.");

	copyExtras(input, args, TASK_CONSUMED);
	return { input, notes };
}

function buildSendMessage(args: Args): Built {
	const input: Args = { action: "send" };
	const notes: string[] = [];

	if (hasText(args.to)) setArg(input, "to", args.to);
	else notes.push("SendMessage arguments carried no recipient, so the intercom call has no destination.");
	if (hasText(args.message)) setArg(input, "message", args.message);
	else notes.push("SendMessage arguments carried no message body, so the intercom call has nothing to send.");

	copyExtras(input, args, SEND_MESSAGE_CONSUMED);
	return { input, notes };
}

const SHAPE_BUILDERS: Readonly<Record<string, (args: Args) => Built>> = {
	Edit: buildEdit,
	MultiEdit: buildMultiEdit,
	NotebookEdit: buildNotebookEdit,
	Grep: buildGrep,
	Glob: buildGlob,
	LS: buildLs,
	Task: buildTask,
	Agent: buildTask,
	SendMessage: buildSendMessage,
};

function buildFromTables(claudeName: string, args: Args): Built {
	const keyMap = CLAUDE_ARG_KEY_MAP[claudeName] ?? {};
	const input: Args = {};
	const notes: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (DROPPED_ARG_KEYS.has(key)) continue;
		setArg(input, keyMap[key] ?? key, value);
	}

	for (const required of REQUIRED_ARG_KEYS[claudeName] ?? []) {
		const piKey = keyMap[required] ?? required;
		if (input[piKey] === undefined) {
			notes.push(`${claudeName} arguments carried no ${required}, so the pi ${claudeName} call is incomplete.`);
		}
	}

	return { input, notes };
}

function mapToolCallUnguarded(claudeName: unknown, input: unknown): ToolMapping {
	const name = typeof claudeName === "string" ? claudeName : String(claudeName ?? "");
	const label = hasText(name) ? name : "(unnamed tool)";
	// Own properties only: `constructor`, `toString` and friends must not resolve through the prototype.
	const mapped = Object.hasOwn(CLAUDE_TO_PI_TOOL, name) ? CLAUDE_TO_PI_TOOL[name] : undefined;
	const known = mapped !== undefined;
	const piName = mapped ?? PLACEHOLDER_TOOL;
	const notes: string[] = [];

	if (!known) {
		notes.push(`Claude tool "${label}" has no pi equivalent; it was rendered as a declared, inert bash placeholder.`);
	}

	// A call with no argument object keeps its pi name but carries nothing: nothing is invented.
	if (!isArgs(input)) {
		notes.push(`${label} arguments were not an object, so no arguments were carried over.`);
		return { piName, input: {}, notes };
	}

	if (!known) return placeholderMapping(name, notes);

	if (BOOKKEEPING_TOOLS.has(name)) {
		return placeholderMapping(name, [
			`${label} is Claude Code bookkeeping with no pi equivalent; it was rendered as a declared, inert bash placeholder.`,
		]);
	}

	const builder = SHAPE_BUILDERS[name];
	if (builder) {
		const built = builder(input);
		return { piName, input: built.input, notes: built.notes };
	}

	const built = buildFromTables(name, input);
	return { piName, input: built.input, notes: built.notes };
}

/** Map one Claude tool call. Never throws (DP7, DR4). */
export const mapToolCall: ToolMapper = (claudeName: string, input: unknown): ToolMapping => {
	try {
		return mapToolCallUnguarded(claudeName, input);
	} catch {
		return placeholderMapping("(unknown tool)", [
			"Tool mapping raised an unexpected error, so the call was rendered as a declared placeholder.",
		]);
	}
};
