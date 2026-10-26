/**
 * Locate one Claude Code session file by id, path or `latest` (DP5).
 *
 * Filesystem reads only: no network, no writes, no pi runtime (DP3, DP4). Nothing in this module
 * throws — every bad input and every filesystem failure is returned as a `LocateResult` error so
 * the bridge can fail visibly, with the candidates it found, and never half-resume (DP11).
 */
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { LocateOptions, LocateResult } from "../types.ts";

/** The one keyword that resolves without a full id (DR1). */
const LATEST = "latest";
/** Claude Code stores one JSONL file per session. */
const SESSION_EXTENSION = ".jsonl";

/**
 * Claude Code's project directory name for a working directory: `/a/b` -> `-a-b`.
 *
 * The rule is a literal rewrite of the absolute cwd: every path separator and every dot becomes
 * `-`, so `/srv/my.app` and `/srv/my/app` share a slug. This is only a **fast path**: the
 * authoritative lookup in `locateClaudeSession` scans every project directory, so a cwd the slug
 * rule gets wrong can never make us resume the wrong conversation (DP5).
 *
 * Normalization: surrounding whitespace is trimmed and trailing separators are dropped before the
 * rewrite, so `/a/b/` and `/a/b` agree. An empty or separator-only cwd yields `""` — a name no
 * project directory can have — which callers read as "no fast path"; returning a sentinel instead
 * of throwing keeps this module's "never throws" contract intact (DP11).
 *
 * Only separators and dots are rewritten, so a Windows drive colon survives
 * (`C:\Users\dev\app` -> `C:-Users-dev-app`). That rule is unverified against Claude Code on
 * Windows and deliberately not guessed at further: the slug is a hint, and the authoritative
 * lookup scans every project directory anyway.
 */
export function claudeProjectSlug(cwd: string): string {
	const normalized = cwd.trim().replace(/[/\\]+$/, "");
	if (normalized === "") {
		return "";
	}
	return normalized.replace(/[/\\.]/g, "-");
}

/**
 * Resolve `--claude` to exactly one readable session file, or fail with a reason.
 *
 * Accepted specs, in order (DP5, DR1):
 *  - `latest` — the newest `*.jsonl` for `cwd`'s project directory;
 *  - a path (`~/…`, absolute, or an existing relative file) — used directly;
 *  - anything else — an exact session id, i.e. `<projectDir>/<spec>.jsonl` for one project dir.
 * There is no prefix matching and no fuzzy matching: a partial id resolves to nothing.
 */
export function locateClaudeSession(options: LocateOptions): LocateResult {
	const rawSpec = options.spec;
	if (typeof rawSpec !== "string" || rawSpec.includes("\u0000")) {
		return invalid("the session spec is missing or contains a NUL character");
	}
	if (rawSpec.trim() === "") {
		return invalid("the session spec is empty");
	}

	const home = options.homeDir ?? process.env["HOME"] ?? homedir();
	const projectsRoot = resolve(options.projectsRoot ?? join(home, ".claude", "projects"));

	if (rawSpec === LATEST) {
		return locateLatest(options.cwd, projectsRoot);
	}

	const expanded = expandHome(rawSpec, home);
	const isPath = rawSpec.startsWith("~/") || isAbsolute(expanded) || statExists(expanded);
	if (isPath) {
		return locateByPath(expanded);
	}
	if (rawSpec.includes("/") || rawSpec.includes("\\")) {
		return invalid(`"${rawSpec}" is not an existing session file; pass an absolute path or a session id`);
	}
	return locateById(rawSpec, projectsRoot);
}

/** Expand a leading `~/` against `home`; every other spec is left untouched. */
function expandHome(spec: string, home: string): string {
	if (!spec.startsWith("~/")) {
		return spec;
	}
	const rest = spec.slice(2);
	return rest === "" ? home : join(home, rest);
}

/** An explicit path must be a readable, regular `*.jsonl` file; it is never reinterpreted as an id. */
function locateByPath(candidate: string): LocateResult {
	const absolute = resolve(candidate);
	if (!absolute.endsWith(SESSION_EXTENSION)) {
		return invalid(`"${candidate}" is not a Claude Code session file: expected a ${SESSION_EXTENSION} path`);
	}
	switch (checkReadableFile(absolute)) {
		case "denied":
			return unreadable(absolute);
		case "missing":
			return invalid(`no session file exists at "${absolute}"`);
		case "not-file":
			return invalid(`"${absolute}" is not a regular file`);
		case "ok":
			return {
				ok: true,
				path: absolute,
				sessionId: basename(absolute, SESSION_EXTENSION),
				projectDir: dirname(absolute),
				source: "path",
			};
	}
}

/** An exact id must exist as `<id>.jsonl` in exactly one project directory (DP5, DR1). */
function locateById(id: string, projectsRoot: string): LocateResult {
	const fileName = `${id}${SESSION_EXTENSION}`;
	const rootRead = readProjectDirs(projectsRoot);
	if (!rootRead.ok) {
		return rootRead.reason === "denied"
			? unreadable(projectsRoot)
			: notFound(`no Claude Code session store at "${projectsRoot}"`);
	}
	const missing = notFound(`no Claude Code session with id "${id}" in "${projectsRoot}"`);
	const matches: string[] = [];
	const unsearchable: string[] = [];
	for (const projectDir of rootRead.dirs) {
		const candidate = join(projectsRoot, projectDir, fileName);
		const { stat, denied } = statOrError(candidate);
		if (stat?.isFile() === true) {
			matches.push(candidate);
		} else if (denied) {
			unsearchable.push(join(projectsRoot, projectDir));
		}
	}
	if (matches.length === 0) {
		const blocked = unsearchable[0];
		return blocked === undefined ? missing : unreadable(blocked);
	}
	matches.sort();
	if (matches.length > 1) {
		return {
			ok: false,
			code: "ambiguous",
			message: `session id "${id}" exists in ${matches.length} projects; pass one of the candidate paths instead`,
			candidates: matches,
		};
	}
	const selected = matches[0];
	if (selected === undefined) {
		return missing;
	}
	return resolveSessionFile(selected, "id");
}

/**
 * `latest` is the one spec where "the newest session" is unambiguously what the user asked for
 * (DR1). It is scoped to the cwd's project directory; only when that directory does not exist at
 * all — a cwd no Claude session has ever run in — does it widen to the whole store, because there
 * is no per-directory answer to give and the request was explicitly for the newest session. If the
 * directory exists but holds no session, that is reported as not-found rather than answered with
 * another project's conversation.
 */
function locateLatest(cwd: string, projectsRoot: string): LocateResult {
	const slug = claudeProjectSlug(cwd);
	if (slug !== "") {
		const projectDir = join(projectsRoot, slug);
		const read = readSessions(projectDir);
		if (read.ok) {
			const newest = newestSession(read.files);
			if (newest === undefined) {
				return notFound(`no Claude Code sessions for "${cwd}" in "${projectDir}" (slug "${slug}")`);
			}
			return resolveSessionFile(newest.path, "latest");
		}
		if (read.reason === "denied") {
			return unreadable(projectDir);
		}
	}

	const rootRead = readProjectDirs(projectsRoot);
	if (!rootRead.ok) {
		return rootRead.reason === "denied"
			? unreadable(projectsRoot)
			: notFound(`no Claude Code session store at "${projectsRoot}"`);
	}
	const all: SessionFile[] = [];
	const unsearchable: string[] = [];
	for (const projectDir of rootRead.dirs) {
		const directory = join(projectsRoot, projectDir);
		const read = readSessions(directory);
		if (read.ok) {
			all.push(...read.files);
		} else if (read.reason === "denied") {
			unsearchable.push(directory);
		}
	}
	const newest = newestSession(all);
	if (newest === undefined) {
		const blocked = unsearchable[0];
		return blocked === undefined
			? notFound(`no Claude Code session files in "${projectsRoot}"`)
			: unreadable(blocked);
	}
	return resolveSessionFile(newest.path, "latest");
}

interface SessionFile {
	path: string;
	mtimeMs: number;
}

/** Newest by mtime; ties fall back to path order so the same input always picks the same file. */
function newestSession(files: readonly SessionFile[]): SessionFile | undefined {
	let best: SessionFile | undefined;
	for (const file of files) {
		if (best === undefined || file.mtimeMs > best.mtimeMs || (file.mtimeMs === best.mtimeMs && file.path < best.path)) {
			best = file;
		}
	}
	return best;
}

/** A directory read either produces entries or states why it could not (DP11: no silent skip). */
type DirRead =
	| { ok: true; entries: Dirent[] }
	| { ok: false; reason: "missing" | "denied" };

/** Immediate subdirectories of the projects root, sorted; an unreadable root is reported. */
function readProjectDirs(projectsRoot: string):
	| { ok: true; dirs: string[] }
	| { ok: false; reason: "missing" | "denied" } {
	const read = readDir(projectsRoot);
	if (!read.ok) {
		return read;
	}
	const dirs: string[] = [];
	for (const entry of read.entries) {
		if (entry.isDirectory()) {
			dirs.push(entry.name);
		}
	}
	return { ok: true, dirs: dirs.sort() };
}

/** The `*.jsonl` files of one project directory; an unreadable directory is reported. */
function readSessions(projectDir: string):
	| { ok: true; files: SessionFile[] }
	| { ok: false; reason: "missing" | "denied" } {
	const read = readDir(projectDir);
	if (!read.ok) {
		return read;
	}
	const files: SessionFile[] = [];
	for (const entry of read.entries) {
		if (!entry.name.endsWith(SESSION_EXTENSION)) {
			continue;
		}
		const candidate = join(projectDir, entry.name);
		const { stat } = statOrError(candidate);
		if (stat?.isFile() === true) {
			files.push({ path: candidate, mtimeMs: stat.mtimeMs });
		}
	}
	return { ok: true, files };
}

/** Turn a matched id/`latest` file into a result, reporting an unreadable file as such (DP11). */
function resolveSessionFile(path: string, source: "id" | "latest"): LocateResult {
	switch (checkReadableFile(path)) {
		case "ok":
			return {
				ok: true,
				path,
				sessionId: basename(path, SESSION_EXTENSION),
				projectDir: dirname(path),
				source,
			};
		case "denied":
			return unreadable(path);
		default:
			return notFound(`the session file "${path}" is gone or is no longer a regular file`);
	}
}

type FileCheck = "ok" | "missing" | "not-file" | "denied";

/** Existence, regular-file-ness and readability in one pass, without ever throwing. */
function checkReadableFile(path: string): FileCheck {
	const { stat, denied } = statOrError(path);
	if (stat === null) {
		return denied ? "denied" : "missing";
	}
	if (!stat.isFile()) {
		return "not-file";
	}
	try {
		accessSync(path, constants.R_OK);
	} catch (error) {
		return isPermissionError(error) ? "denied" : "missing";
	}
	return "ok";
}

function statExists(path: string): boolean {
	return statOrError(path).stat !== null;
}

function statOrError(path: string): { stat: Stats | null; denied: boolean } {
	try {
		return { stat: statSync(path), denied: false };
	} catch (error) {
		return { stat: null, denied: isPermissionError(error) };
	}
}

function readDir(path: string): DirRead {
	try {
		return { ok: true, entries: readdirSync(path, { withFileTypes: true }) };
	} catch (error) {
		return { ok: false, reason: isPermissionError(error) ? "denied" : "missing" };
	}
}

function isPermissionError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === "EACCES" || code === "EPERM";
}

function invalid(message: string): LocateResult {
	return { ok: false, code: "invalid-spec", message };
}

function notFound(message: string): LocateResult {
	return { ok: false, code: "not-found", message };
}

function unreadable(path: string): LocateResult {
	return { ok: false, code: "unreadable", message: `"${path}" cannot be read (permission denied)` };
}
