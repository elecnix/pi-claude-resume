/**
 * Harness for the opt-in end-to-end resume tests (DP13).
 *
 * Everything here is hermetic: a throwaway HOME under `os.tmpdir()`, a throwaway project
 * directory, and hand-written synthetic Claude Code fixtures copied into the layout the
 * extension reads. The real `$HOME/.claude` and `~/.pi` are never read or written, and no
 * fixture contains data from a real session (DP12).
 */
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `tests/integration` */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root of this worktree. */
export const REPO_ROOT = path.resolve(HERE, "..", "..");
/** The extension entry point under test, loaded into pi with `-e`. */
export const EXTENSION_ENTRY = path.join(REPO_ROOT, "src", "index.ts");
/** Default overall budget for one `pi` invocation; the suite's testTimeout is larger. */
export const PI_TIMEOUT_MS = 150_000;
/** Model used unless `PI_CLAUDE_IT_MODEL` overrides it. */
export const DEFAULT_IT_MODEL = "ollama/deepseek-v4.1-flash:cloud";

/**
 * Canonical fixture project directory. It is *not* the directory copied from: the harness
 * copies these files into `<home>/.claude/projects/<slug of the temp project>/`, where the
 * slug is computed exactly like `claudeProjectSlug()`. The name here only records the
 * synthetic slug shape (`/tmp/project` -> `-tmp-project`).
 */
export const FIXTURES_ROOT = path.join(HERE, "fixtures", "claude", "-tmp-project");

/**
 * Placeholder for the pi working directory inside the fixtures. `createFixtureHome()` replaces
 * it with the temp project path so the copied session's `cwd` matches where pi runs (needed for
 * `--claude latest`). The committed fixtures therefore contain no machine-specific path (DP12).
 */
export const PROJECT_CWD_PLACEHOLDER = "__PROJECT_CWD__";

/** One synthetic Claude Code session tracked by the harness. */
export interface FixtureSession {
	/** File name inside the project directory, i.e. `<sessionId>.jsonl`. */
	readonly fileName: string;
	readonly sessionId: string;
	/** Codeword that exists only in this fixture, or null when the fixture has no turns. */
	readonly fact: string | null;
	/** Deterministic mtime (epoch seconds); newer than every older fixture, used by `latest`. */
	readonly mtimeSeconds: number;
}

/** Four turns; carries the codeword used by the resume tests. Newest fixture, so `latest` = this. */
export const LONG_SESSION: FixtureSession = {
	fileName: "4f8c2b1a-9d3e-4c57-8a02-6b1e5d9f0c34.jsonl",
	sessionId: "4f8c2b1a-9d3e-4c57-8a02-6b1e5d9f0c34",
	fact: "ZEPHYRQUARTZ4711",
	mtimeSeconds: Date.parse("2025-03-04T09:02:25.000Z") / 1000,
};

/** Exactly one user turn. */
export const ONE_TURN_SESSION: FixtureSession = {
	fileName: "8b1e4d72-6c2a-4f09-b3d8-5a7e0c1b9f26.jsonl",
	sessionId: "8b1e4d72-6c2a-4f09-b3d8-5a7e0c1b9f26",
	fact: "amber-otter-42",
	mtimeSeconds: Date.parse("2025-02-10T14:30:00.000Z") / 1000,
};

/** A `tool_use` / `tool_result` pair whose tool output carries the codeword (DP6, DP7). */
export const TOOL_SESSION: FixtureSession = {
	fileName: "c3d9a6f4-2e7b-4a18-9c05-1f8d4b2e6a70.jsonl",
	sessionId: "c3d9a6f4-2e7b-4a18-9c05-1f8d4b2e6a70",
	fact: "cobalt-lantern-77",
	mtimeSeconds: Date.parse("2025-02-20T11:05:24.000Z") / 1000,
};

/** Zero-byte session file: nothing to resume, so the run must fail loudly (DP11). */
export const EMPTY_SESSION: FixtureSession = {
	fileName: "d5a0c8e2-7b1f-4d63-8e94-2c6a0b3f5d18.jsonl",
	sessionId: "d5a0c8e2-7b1f-4d63-8e94-2c6a0b3f5d18",
	fact: null,
	mtimeSeconds: Date.parse("2025-01-01T00:00:00.000Z") / 1000,
};

/** One truncated (malformed) line between valid turns; parsing tolerates it (DP11). */
export const MALFORMED_SESSION: FixtureSession = {
	fileName: "e9b3f1c7-4a8d-4e26-b0f5-7d2c9a1e6b43.jsonl",
	sessionId: "e9b3f1c7-4a8d-4e26-b0f5-7d2c9a1e6b43",
	fact: "silver-orchid-19",
	mtimeSeconds: Date.parse("2025-02-01T08:15:31.000Z") / 1000,
};

/** Every fixture, oldest first. */
export const FIXTURES: readonly FixtureSession[] = [
	EMPTY_SESSION,
	MALFORMED_SESSION,
	ONE_TURN_SESSION,
	TOOL_SESSION,
	LONG_SESSION,
];

/** A temp HOME plus the project directory pi will run in. */
export interface FixtureHome {
	/** Root of the temp tree; delete this to clean up everything. */
	readonly baseDir: string;
	/** Fake `$HOME` for the child pi process. */
	readonly home: string;
	/** Working directory for pi; its Claude project slug holds the fixtures. */
	readonly projectDir: string;
	/** `<home>/.claude/projects/<slug>` for `projectDir`. */
	readonly claudeProjectDir: string;
	/** Id of the long fixture session; the default subject of the resume tests. */
	readonly sessionId: string;
	/** Codeword only present in that session's transcript. */
	readonly expectedFact: string;
}

/**
 * Claude Code's project directory name for a working directory: `/a/b` -> `-a-b`.
 *
 * Mirrors `claudeProjectSlug()` in `src/claude/locate.ts`; it is duplicated here so the harness
 * can build the layout before the extension is implemented, and the temp paths contain only
 * letters, digits, `-` and `/`, so no other escaping is involved.
 */
export function projectSlugFor(cwd: string): string {
	const normalized = path.resolve(cwd).replace(/[\\/]+$/, "");
	return normalized.replace(/[:/\\]/g, "-");
}

/** `<home>/.claude/projects/<slug>` for a working directory. */
export function claudeProjectDirFor(home: string, cwd: string): string {
	return path.join(home, ".claude", "projects", projectSlugFor(cwd));
}

/** `<home>/.claude/projects/<slug>/<sessionId>.jsonl` */
export function claudeSessionFile(home: string, cwd: string, sessionId: string): string {
	return path.join(claudeProjectDirFor(home, cwd), `${sessionId}.jsonl`);
}

/**
 * Build a temp HOME containing the synthetic Claude project, and return the paths the tests
 * need. Never touches the real `$HOME/.claude` or `~/.pi` (DP4, DP12).
 */
export async function createFixtureHome(): Promise<FixtureHome> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "pi-claude-resume-it-"));
	const home = path.join(baseDir, "home");
	const projectDir = path.join(baseDir, "project");
	await mkdir(home);
	await mkdir(projectDir);

	const claudeProjectDir = claudeProjectDirFor(home, projectDir);
	await mkdir(claudeProjectDir, { recursive: true });

	// Escape the path for embedding inside a JSON string literal.
	const cwdLiteral = JSON.stringify(projectDir).slice(1, -1);

	for (const fixture of FIXTURES) {
		const source = await readFile(path.join(FIXTURES_ROOT, fixture.fileName), "utf8");
		const templated = source.split(PROJECT_CWD_PLACEHOLDER).join(cwdLiteral);
		const target = path.join(claudeProjectDir, fixture.fileName);
		await writeFile(target, templated, "utf8");
		// Deterministic mtimes: `latest` must not depend on when the tests happened to run.
		await utimes(target, fixture.mtimeSeconds, fixture.mtimeSeconds);
	}

	if (LONG_SESSION.fact === null) {
		throw new Error("harness invariant: the long fixture session must carry a codeword");
	}

	return {
		baseDir,
		home,
		projectDir,
		claudeProjectDir,
		sessionId: LONG_SESSION.sessionId,
		expectedFact: LONG_SESSION.fact,
	};
}

/** Remove a fixture tree; safe to call more than once. */
export async function disposeFixtureHome(home: FixtureHome): Promise<void> {
	await rm(home.baseDir, { recursive: true, force: true });
}

/** Absolute path to the pi CLI shipped in `node_modules`. */
export function piExecutable(): string {
	const name = process.platform === "win32" ? "pi.cmd" : "pi";
	return path.join(REPO_ROOT, "node_modules", ".bin", name);
}

/**
 * Flags that keep a child pi run self-contained (DP13).
 *
 * `--no-extensions` is deliberately absent: the extension under test is what `-e` loads.
 * Each of these only narrows discovery so a run cannot depend on machine state.
 *
 * `--offline` is not unconditional: a fresh temp HOME has no model catalog, and pi resolves
 * `--model` against discovered providers, so an offline run can only succeed when the model is
 * known without discovery. Opt in with `PI_CLAUDE_IT_OFFLINE=1` (see {@link hermeticPiFlags}).
 */
export const HERMETIC_PI_FLAGS: readonly string[] = [
	"--thinking",
	"off",
	"--no-context-files",
	"--no-mcp",
	"--no-skills",
	"--no-prompt-templates",
];

/** `PI_CLAUDE_IT_OFFLINE=1` runs pi with `--offline`; see {@link HERMETIC_PI_FLAGS}. */
export function isOfflineRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CLAUDE_IT_OFFLINE === "1";
}

/** The hermetic flag list for this run, adding `--offline` on request. */
export function hermeticPiFlags(env: NodeJS.ProcessEnv = process.env): string[] {
	return isOfflineRequested(env)
		? ["--offline", ...HERMETIC_PI_FLAGS]
		: [...HERMETIC_PI_FLAGS];
}

/** Env vars scrubbed from the parent environment because they would point pi at the real home. */
const SCRUBBED_ENV_KEYS: readonly string[] = [
	"PI_SESSION_FILE",
	"PI_OFFLINE",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
];

/**
 * Environment for a child pi run: the caller's credentials are inherited, everything that
 * selects a home or session directory is redirected into `home` (DP4, DP12).
 */
export function buildChildEnv(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of SCRUBBED_ENV_KEYS) delete env[key];
	env.HOME = home;
	env.USERPROFILE = home;
	env.PI_TELEMETRY = "0";
	env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	env.PI_CODING_AGENT_SESSION_DIR = piSessionRoot(home);
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	if (isOfflineRequested()) {
		env.PI_OFFLINE = "1";
	} else {
		delete env.PI_OFFLINE;
	}
	return env;
}

/** Where pi persists sessions for this harness (`<agent dir>/sessions`). */
export function piSessionRoot(home: string): string {
	return path.join(home, ".pi", "agent", "sessions");
}

/** Outcome of one `pi` invocation. */
export interface PiRunResult {
	readonly args: readonly string[];
	readonly code: number;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

export interface PiRunOptions {
	/** Fake HOME for the child. */
	readonly home: string;
	/** Working directory for the child (the temp project directory). */
	readonly cwd: string;
	/** Defaults to {@link PI_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

/**
 * Run `pi` once, capturing stdout/stderr. A non-zero exit is a normal result here: the tests
 * assert on it (DP11), so this never rejects.
 */
export async function runPi(
	args: readonly string[],
	options: PiRunOptions,
): Promise<PiRunResult> {
	const startedAt = performance.now();
	const env = buildChildEnv(options.home);
	const timeoutMs = options.timeoutMs ?? PI_TIMEOUT_MS;

	return await new Promise<PiRunResult>((resolve) => {
		const child = execFile(
			piExecutable(),
			[...args],
			{
				cwd: options.cwd,
				env,
				timeout: timeoutMs,
				killSignal: "SIGKILL",
				maxBuffer: 8 * 1024 * 1024,
				encoding: "utf8",
				windowsHide: true,
			},
			(error: ExecFileException | null, stdout: string, stderr: string) => {
				resolve({
					args: [...args],
					code: exitCodeOf(error),
					signal: error?.signal ?? null,
					stdout,
					stderr,
					timedOut: error?.killed === true,
					durationMs: Math.round(performance.now() - startedAt),
				});
			},
		);
		// `execFile` gives the child a stdin pipe that stays open; pi treats a piped stdin as
		// extra prompt input and blocks until EOF. Close it so the run is one-shot.
		child.stdin?.end();
	});
}

function exitCodeOf(error: ExecFileException | null): number {
	if (error === null) return 0;
	return typeof error.code === "number" ? error.code : -1;
}

/** Human-readable transcript of a failed run; used as the vitest assertion message. */
export function formatRunResult(result: PiRunResult): string {
	const header = [
		`command: pi ${result.args.join(" ")}`,
		`exit: ${result.code}${result.signal === null ? "" : ` (signal ${result.signal})`}`,
		`timed out: ${result.timedOut}`,
		`duration: ${result.durationMs} ms`,
	].join("\n");
	return [header, "--- stdout ---", result.stdout, "--- stderr ---", result.stderr].join(
		"\n",
	);
}

/** Does `haystack` contain `needle`, ignoring case? */
export function containsIgnoreCase(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** One pi session JSONL file found under the temp HOME. */
export interface PiSessionFile {
	readonly file: string;
	/** Parsed entries; lines that cannot be parsed are skipped (a session file may end mid-line). */
	readonly entries: readonly Record<string, unknown>[];
}

/** Read every pi session JSONL file under the temp HOME. */
export async function readPiSessionFiles(home: string): Promise<readonly PiSessionFile[]> {
	const root = piSessionRoot(home);
	const files = await listJsonlFiles(root);
	const sessions: PiSessionFile[] = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8");
		sessions.push({ file, entries: parseJsonlEntries(raw) });
	}
	return sessions;
}

/** Count `custom_message` entries per `customType` across every pi session in the temp HOME. */
export async function customMessageCounts(home: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const session of await readPiSessionFiles(home)) {
		for (const entry of session.entries) {
			if (entry.type !== "custom_message") continue;
			const customType = entry.customType;
			if (typeof customType !== "string") continue;
			counts[customType] = (counts[customType] ?? 0) + 1;
		}
	}
	return counts;
}

/** Count `custom_message` entries of one `customType` across the temp HOME. */
export async function countCustomMessages(home: string, customType: string): Promise<number> {
	const counts = await customMessageCounts(home);
	return counts[customType] ?? 0;
}

/** Parse JSONL tolerantly: blank lines, and lines that cannot be parsed, are skipped. */
export function parseJsonlEntries(raw: string): Record<string, unknown>[] {
	const entries: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			entries.push(value as Record<string, unknown>);
		}
	}
	return entries;
}

async function listJsonlFiles(root: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listJsonlFiles(full)));
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(full);
		}
	}
	return files.sort();
}

/** The opt-in gate: only the literal `1` enables the model-dependent suite (DP13). */
export function isIntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_CLAUDE_IT === "1";
}

/** Model for the suite: `PI_CLAUDE_IT_MODEL`, or {@link DEFAULT_IT_MODEL}. */
export function integrationModel(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CLAUDE_IT_MODEL?.trim();
	return configured !== undefined && configured !== "" ? configured : DEFAULT_IT_MODEL;
}

/**
 * Contents of every `custom_message` entry of one `customType` across the temp HOME, flattened
 * to text. Used to prove what actually reached the persisted transcript (DP6, DP8).
 */
export async function customMessageContents(
	home: string,
	customType: string,
): Promise<string[]> {
	const contents: string[] = [];
	for (const session of await readPiSessionFiles(home)) {
		for (const entry of session.entries) {
			if (entry.type !== "custom_message" || entry.customType !== customType) continue;
			contents.push(contentToText(entry.content));
		}
	}
	return contents;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}
