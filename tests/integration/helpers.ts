/**
 * Harness for the opt-in end-to-end resume tests (DP13).
 *
 * Everything here is hermetic: a throwaway tree under `os.tmpdir()`, a throwaway project
 * directory, and hand-written synthetic Claude Code fixtures copied into the layout the
 * extension reads. The real `$HOME/.claude` and `~/.pi` are never read or written, and no
 * fixture contains data from a real session (DP12).
 *
 * The Claude store is relocated the way Claude Code itself allows — `CLAUDE_CONFIG_DIR` pointing
 * at `<baseDir>/claude-config` — instead of redirecting `HOME`. Redirecting `HOME` used to hide
 * pi's own model catalogue and provider credentials from the child process, which made every run
 * fail for a harness reason rather than a product one; the child still gets a temp `HOME` so it
 * writes nothing to the real pi session store, but the Claude fixtures live outside it.
 */
import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectSlug } from "../../src/claude/locate.ts";
import { CLAUDE_CONFIG_DIR_ENV } from "../../src/cli/env.ts";

/** `tests/integration` */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root of this worktree. */
export const REPO_ROOT = path.resolve(HERE, "..", "..");
/** The extension entry point under test, loaded into pi with `-e`. */
export const EXTENSION_ENTRY = path.join(REPO_ROOT, "src", "index.ts");
/** Default overall budget for one `pi` invocation; the suite's testTimeout is larger. */
export const PI_TIMEOUT_MS = 150_000;

/**
 * Model used unless `PI_CLAUDE_IT_MODEL` overrides it.
 *
 * Deliberately a provider pi ships in core: the child runs with a temp `HOME` and agent
 * directory, so a provider that arrives as an extension (the local `ollama` one, for example) is
 * not discoverable and would fail before the transcript is ever read. Any provider whose
 * credentials are in the parent environment can be selected with `PI_CLAUDE_IT_MODEL`.
 */
export const DEFAULT_IT_MODEL = "openrouter/deepseek/deepseek-v4.1-flash";

/**
 * Canonical fixture project directory. It is *not* the directory copied from: the harness
 * copies these files into `<baseDir>/claude-config/projects/<slug of the temp project>/`, where
 * the slug is computed exactly like `claudeProjectSlug()`. The name here only records the
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
	/**
	 * File name inside the project directory, i.e. `<sessionId>.jsonl`.
	 */
	readonly fileName: string;
	readonly sessionId: string;
	/** Codeword that exists only in this fixture, or null when the fixture has no turns. */
	readonly fact: string | null;
	/** Deterministic mtime (epoch seconds); newer than every older fixture, used by `latest`. */
	readonly mtimeSeconds: number;
}

/**
 * Build one fixture, deriving the session id from the file name so the two cannot disagree, and
 * the epoch-seconds mtime from the ISO instant the fixture states.
 */
function fixture(fileName: string, fact: string | null, mtimeIso: string): FixtureSession {
	return {
		fileName,
		sessionId: fileName.replace(/\.jsonl$/, ""),
		fact,
		mtimeSeconds: Date.parse(mtimeIso) / 1000,
	};
}

/** Four turns; carries the codeword used by the resume tests. Newest fixture, so `latest` = this. */
export const LONG_SESSION: FixtureSession = fixture("4f8c2b1a-9d3e-4c57-8a02-6b1e5d9f0c34.jsonl", "ZEPHYRQUARTZ4711", "2025-03-04T09:02:25.000Z");

/** Exactly one user turn. */
export const ONE_TURN_SESSION: FixtureSession = fixture("8b1e4d72-6c2a-4f09-b3d8-5a7e0c1b9f26.jsonl", "amber-otter-42", "2025-02-10T14:30:00.000Z");

/** A `tool_use` / `tool_result` pair whose tool output carries the codeword (DP6, DP7). */
export const TOOL_SESSION: FixtureSession = fixture("c3d9a6f4-2e7b-4a18-9c05-1f8d4b2e6a70.jsonl", "cobalt-lantern-77", "2025-02-20T11:05:24.000Z");

/** Zero-byte session file: nothing to resume, so the run must fail loudly (DP11). */
export const EMPTY_SESSION: FixtureSession = fixture("d5a0c8e2-7b1f-4d63-8e94-2c6a0b3f5d18.jsonl", null, "2025-01-01T00:00:00.000Z");

/** One truncated (malformed) line between valid turns; parsing tolerates it (DP11). */
export const MALFORMED_SESSION: FixtureSession = fixture("e9b3f1c7-4a8d-4e26-b0f5-7d2c9a1e6b43.jsonl", "silver-orchid-19", "2025-02-01T08:15:31.000Z");

/** Every fixture, oldest first. */
export const FIXTURES: readonly FixtureSession[] = [
	EMPTY_SESSION,
	MALFORMED_SESSION,
	ONE_TURN_SESSION,
	TOOL_SESSION,
	LONG_SESSION,
];

/** A temp tree: a fake `$HOME`, the project pi runs in, and a relocated Claude store. */
export interface FixtureHome {
	/** Root of the temp tree; delete this to clean up everything. */
	readonly baseDir: string;
	/** Fake `$HOME` for the child pi process: nothing written here leaves the temp tree. */
	readonly home: string;
	/** Working directory for pi; its Claude project slug holds the fixtures. */
	readonly projectDir: string;
	/** `<baseDir>/claude-config`, exported to the child as `CLAUDE_CONFIG_DIR`. */
	readonly claudeConfigDir: string;
	/** `<claudeConfigDir>/projects/<slug>` for `projectDir`. */
	readonly claudeProjectDir: string;
	/** `<baseDir>/sessions`, passed as `--session-dir` when a run must persist a pi session. */
	readonly sessionsDir: string;
	/** Id of the long fixture session; the default subject of the resume tests. */
	readonly sessionId: string;
	/** Codeword only present in that session's transcript. */
	readonly expectedFact: string;
}

/**
 * Claude Code's project directory name for a working directory: `/a/b` -> `-a-b`.
 *
 * Delegates to the extension's own `claudeProjectSlug()` instead of re-implementing the rule. The
 * harness used to fold separators and colons but not dots, so a project directory containing a dot
 * produced fixtures under a slug the extension never looks at, and every resume test failed for a
 * harness reason. `path.resolve()` first, because the harness always places an absolute directory
 * while a caller may pass a relative one. `tests/unit/slug-mirror.test.ts` keeps the two in step.
 */
export function projectSlugFor(cwd: string): string {
	return claudeProjectSlug(path.resolve(cwd));
}

/** `<claudeConfigDir>/projects` — the root Claude Code keeps per-project directories under. */
export function claudeProjectsRootFor(claudeConfigDir: string): string {
	return path.join(claudeConfigDir, "projects");
}

/** `<claudeConfigDir>/projects/<slug>` for a working directory. */
export function claudeProjectDirFor(claudeConfigDir: string, cwd: string): string {
	return path.join(claudeProjectsRootFor(claudeConfigDir), projectSlugFor(cwd));
}

/** `<claudeConfigDir>/projects/<slug>/<sessionId>.jsonl` */
export function claudeSessionFile(
	claudeConfigDir: string,
	cwd: string,
	sessionId: string,
): string {
	return path.join(claudeProjectDirFor(claudeConfigDir, cwd), `${sessionId}.jsonl`);
}

/**
 * Build a temp tree containing the synthetic Claude project under a relocated
 * `CLAUDE_CONFIG_DIR`, and return the paths the tests need. Never touches the real
 * `$HOME/.claude` or `~/.pi` (DP4, DP12).
 */
export async function createFixtureHome(): Promise<FixtureHome> {
	const baseDir = await mkdtemp(path.join(tmpdir(), "pi-claude-resume-it-"));
	const home = path.join(baseDir, "home");
	const projectDir = path.join(baseDir, "project");
	const claudeConfigDir = path.join(baseDir, "claude-config");
	const sessionsDir = path.join(baseDir, "sessions");
	await mkdir(home);
	await mkdir(projectDir);
	// pi creates the session directory on demand; making it here keeps the layout assertion in
	// `harness.test.ts` about placement rather than about who created the directory.
	await mkdir(sessionsDir);

	const claudeProjectDir = claudeProjectDirFor(claudeConfigDir, projectDir);
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
		claudeConfigDir,
		claudeProjectDir,
		sessionsDir,
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
 * Each of these only narrows discovery so a run cannot depend on machine state; none selects a
 * session, a model or a config directory.
 *
 * `--offline` is opt-in rather than unconditional: a run that starts with an empty agent
 * directory has no refreshed model catalogue, so an offline run can only succeed when the chosen
 * model is known without discovery. Opt in with `PI_CLAUDE_IT_OFFLINE=1` (see
 * {@link hermeticPiFlags}).
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
 * Credentials inherited from the parent environment on purpose.
 *
 * The suite never invents a credential and never reads pi's `auth.json`: the provider pi needs
 * has to be exported by whoever runs the suite. These keys are therefore explicitly kept, and a
 * test asserts they survive {@link buildChildEnv} — hermetic must not silently mean unauthenticated.
 */
export const INHERITED_CREDENTIAL_ENV_KEYS: readonly string[] = [
	"OPENROUTER_API_KEY",
	"ANTHROPIC_API_KEY",
	"OLLAMA_API_KEY",
];

/**
 * Environment for a child pi run: the caller's credentials are inherited, `HOME` and pi's agent
 * directory are redirected into the temp tree so nothing reaches the real store, and the Claude
 * store is relocated with Claude Code's own `CLAUDE_CONFIG_DIR` rather than by moving `HOME`
 * (DP4, DP12).
 */
export function buildChildEnv(fixture: FixtureHome): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of SCRUBBED_ENV_KEYS) delete env[key];
	env.HOME = fixture.home;
	env.USERPROFILE = fixture.home;
	env.PI_TELEMETRY = "0";
	env.PI_CODING_AGENT_DIR = path.join(fixture.home, ".pi", "agent");
	// Belt and braces: `--session-dir` is passed explicitly per run, but if a run ever forgets
	// it, pi must still land inside the temp tree rather than in the real session store.
	env.PI_CODING_AGENT_SESSION_DIR = fixture.sessionsDir;
	// The variable under test: the same one Claude Code honours (see `src/cli/env.ts`).
	env[CLAUDE_CONFIG_DIR_ENV] = fixture.claudeConfigDir;
	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";
	if (isOfflineRequested()) {
		env.PI_OFFLINE = "1";
	} else {
		delete env.PI_OFFLINE;
	}
	return env;
}

/** Where pi persists sessions for this harness (`<baseDir>/sessions`). */
export function piSessionRoot(fixture: FixtureHome): string {
	return fixture.sessionsDir;
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
	/** The temp tree the run belongs to: its env, and the project directory as cwd. */
	readonly fixture: FixtureHome;
	/** Defaults to {@link PI_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

/**
 * Run `pi` once in the fixture's project directory, capturing stdout/stderr. A non-zero exit is
 * a normal result here: the tests assert on it (DP11), so this never rejects.
 */
export async function runPi(
	args: readonly string[],
	options: PiRunOptions,
): Promise<PiRunResult> {
	const startedAt = performance.now();
	const env = buildChildEnv(options.fixture);
	const timeoutMs = options.timeoutMs ?? PI_TIMEOUT_MS;

	return await new Promise<PiRunResult>((resolve) => {
		const child = execFile(
			piExecutable(),
			[...args],
			{
				cwd: options.fixture.projectDir,
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

/** One pi session JSONL file found under the harness's session directory. */
export interface PiSessionFile {
	readonly file: string;
	/** Parsed entries; lines that cannot be parsed are skipped (a session file may end mid-line). */
	readonly entries: readonly Record<string, unknown>[];
}

/** Read every pi session JSONL file under `<baseDir>/sessions`. */
export async function readPiSessionFiles(
	fixture: FixtureHome,
): Promise<readonly PiSessionFile[]> {
	const files = await listJsonlFiles(piSessionRoot(fixture));
	const sessions: PiSessionFile[] = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8");
		sessions.push({ file, entries: parseJsonlEntries(raw) });
	}
	return sessions;
}

/** Count `custom_message` entries per `customType` across every pi session in the temp tree. */
export async function customMessageCounts(
	fixture: FixtureHome,
): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (const session of await readPiSessionFiles(fixture)) {
		for (const entry of session.entries) {
			if (entry.type !== "custom_message") continue;
			const customType = entry.customType;
			if (typeof customType !== "string") continue;
			counts[customType] = (counts[customType] ?? 0) + 1;
		}
	}
	return counts;
}

/** Count `custom_message` entries of one `customType` across the temp tree. */
export async function countCustomMessages(
	fixture: FixtureHome,
	customType: string,
): Promise<number> {
	const counts = await customMessageCounts(fixture);
	return counts[customType] ?? 0;
}

/**
 * Every `*.jsonl` file pi wrote anywhere in the temp tree, i.e. outside the Claude store.
 *
 * Used to prove that a run which asks for persistence writes under `--session-dir` and that a
 * run which passes `--no-session` writes no session at all (DP4, DP12).
 */
export async function listPiJsonlFiles(fixture: FixtureHome): Promise<string[]> {
	const files = await listJsonlFiles(fixture.baseDir);
	return files.filter((file) => !isInside(fixture.claudeConfigDir, file));
}

/** True when `file` sits inside `directory` (both absolute, symlinks not resolved). */
export function isInside(directory: string, file: string): boolean {
	const root = path.resolve(directory);
	const target = path.resolve(file);
	return target === root || target.startsWith(root + path.sep);
}

/** Parse JSONL tolerantly: blank and unparsable lines are skipped. */
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
 * Contents of every `custom_message` entry of one `customType` across the temp tree, flattened
 * to text. Used to prove what actually reached the persisted transcript (DP6, DP8).
 */
export async function customMessageContents(
	fixture: FixtureHome,
	customType: string,
): Promise<string[]> {
	const contents: string[] = [];
	for (const session of await readPiSessionFiles(fixture)) {
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
