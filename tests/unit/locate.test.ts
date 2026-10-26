/**
 * Specification for locating a Claude Code session (DP5, DP13).
 *
 * Every fixture here is hand-written and synthetic: no path, prompt or session from a real
 * machine, no captured file (DP12). Trees are built under `os.tmpdir()` and removed after each
 * test so the suite stays offline and finishes in seconds (DP13).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeProjectSlug, locateClaudeSession } from "../../src/claude/locate.ts";
import type { LocateErrorCode, LocateOptions, LocateResult } from "../../src/types.ts";

/** Content is a synthetic marker so a test can prove no file contents leak into a result. */
const SENTINEL = "SYNTHETIC-SENTINEL-LINE";
const SYNTHETIC_LINE = `{"type":"user","sessionId":"synthetic","message":{"role":"user","content":"${SENTINEL}"}}\n`;
/** Whole seconds, so `utimesSync` survives filesystems with one-second timestamp granularity. */
const T_BASE = 1_600_000_000;

const createdRoots: string[] = [];

/** A fresh temp root, removed after the test. */
function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pcr-locate-"));
	createdRoots.push(root);
	return root;
}

/** Write one synthetic session file, optionally pinning its mtime. Returns the absolute path. */
function writeSession(projectsRoot: string, slug: string, id: string, mtimeSeconds?: number): string {
	const projectDir = join(projectsRoot, slug);
	mkdirSync(projectDir, { recursive: true });
	const path = join(projectDir, `${id}${".jsonl"}`);
	writeFileSync(path, SYNTHETIC_LINE, "utf8");
	if (mtimeSeconds !== undefined) {
		utimesSync(path, mtimeSeconds, mtimeSeconds);
	}
	return path;
}

function options(spec: string, projectsRoot: string, cwd = "/synthetic/work/repo"): LocateOptions {
	return { spec, cwd, homeDir: projectsRoot, projectsRoot };
}

type OkResult = Extract<LocateResult, { ok: true }>;
type ErrResult = Extract<LocateResult, { ok: false }>;

function expectOk(result: LocateResult): asserts result is OkResult {
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(`expected ok, got ${JSON.stringify(result)}`);
	}
}

function expectError(result: LocateResult, code: LocateErrorCode): asserts result is ErrResult {
	expect(result.ok).toBe(false);
	if (result.ok) {
		throw new Error(`expected ${code}, got ok for ${result.path}`);
	}
	expect(result.code).toBe(code);
	expect(result.message.length).toBeGreaterThan(0);
}

afterEach(() => {
	for (const root of createdRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("claudeProjectSlug", () => {
	it("rewrites a nested absolute cwd", () => {
		expect(claudeProjectSlug("/synthetic/home/dev/app")).toBe("-synthetic-home-dev-app");
	});

	it("drops trailing separators before rewriting", () => {
		expect(claudeProjectSlug("/synthetic/home/dev/app/")).toBe("-synthetic-home-dev-app");
		expect(claudeProjectSlug("/synthetic/home/dev/app///")).toBe("-synthetic-home-dev-app");
	});

	it("rewrites a relative cwd", () => {
		expect(claudeProjectSlug("dev/app")).toBe("dev-app");
	});

	it("rewrites a windows-style cwd, leaving the drive colon alone", () => {
		expect(claudeProjectSlug("C:\\Users\\dev\\app")).toBe("C:-Users-dev-app");
	});

	it("rewrites dots inside path segments", () => {
		expect(claudeProjectSlug("/srv/my.app")).toBe("-srv-my-app");
	});

	it("trims surrounding whitespace", () => {
		expect(claudeProjectSlug("  /synthetic/app  ")).toBe("-synthetic-app");
	});

	it("returns an empty slug for empty, blank or separator-only input", () => {
		expect(claudeProjectSlug("")).toBe("");
		expect(claudeProjectSlug("   ")).toBe("");
		expect(claudeProjectSlug("/")).toBe("");
	});
});

describe("locateClaudeSession: direct paths", () => {
	it("uses an absolute path directly", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-export", "session-one");

		const result = locateClaudeSession(options(path, root));

		expectOk(result);
		expect(result.source).toBe("path");
		expect(result.path).toBe(path);
		expect(result.sessionId).toBe("session-one");
		expect(result.projectDir).toBe(dirname(path));
	});

	it("expands a leading ~/ against homeDir", () => {
		const home = makeRoot();
		mkdirSync(join(home, "exported"), { recursive: true });
		const path = join(home, "exported", "session-two.jsonl");
		writeFileSync(path, SYNTHETIC_LINE, "utf8");

		const result = locateClaudeSession({ spec: "~/exported/session-two.jsonl", cwd: "/synthetic/work/repo", homeDir: home });

		expectOk(result);
		expect(result.source).toBe("path");
		expect(result.path).toBe(path);
		expect(result.sessionId).toBe("session-two");
	});

	it("uses an existing relative path directly", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-export", "session-three");
		const spec = relative(process.cwd(), path);

		const result = locateClaudeSession(options(spec, root));

		expectOk(result);
		expect(result.source).toBe("path");
		expect(result.path).toBe(resolve(path));
	});

	it("rejects an existing path that is not a .jsonl file", () => {
		const root = makeRoot();
		const path = join(root, "notes.txt");
		writeFileSync(path, SYNTHETIC_LINE, "utf8");

		expectError(locateClaudeSession(options(path, root)), "invalid-spec");
	});

	it("rejects a directory path", () => {
		const root = makeRoot();
		const path = join(root, "bundle");
		mkdirSync(path);

		expectError(locateClaudeSession(options(path, root)), "invalid-spec");
	});

	it("rejects an absolute path that does not exist", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options(join(root, "missing", "session.jsonl"), root)), "invalid-spec");
	});
});

describe("locateClaudeSession: invalid specs", () => {
	it("rejects an empty spec", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("", root)), "invalid-spec");
	});

	it("rejects a whitespace-only spec", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("   ", root)), "invalid-spec");
	});

	it("rejects a slash-separated spec that is not an existing file", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("some/dir/session-one", root)), "invalid-spec");
	});

	it("rejects a backslash-separated spec that is not an existing file", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("some\\dir\\session-one", root)), "invalid-spec");
	});

	it("rejects a spec containing NUL", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("session\u0000one", root)), "invalid-spec");
		expectError(locateClaudeSession(options("latest\u0000", root)), "invalid-spec");
	});
});

describe("locateClaudeSession: exact ids", () => {
	it("finds an id in the project directory for the cwd", () => {
		const root = makeRoot();
		const path = writeSession(root, claudeProjectSlug("/synthetic/work/repo"), "abcdef01");

		const result = locateClaudeSession(options("abcdef01", root));

		expectOk(result);
		expect(result.source).toBe("id");
		expect(result.path).toBe(path);
		expect(result.sessionId).toBe("abcdef01");
		expect(result.projectDir).toBe(dirname(path));
	});

	it("finds an id after scanning many project directories", () => {
		const root = makeRoot();
		for (let index = 0; index < 30; index += 1) {
			writeSession(root, `-synthetic-project-${String(index).padStart(2, "0")}`, `filler-${index}`);
		}
		const path = writeSession(root, "-synthetic-project-29", "target-session");

		const result = locateClaudeSession(options("target-session", root, "/synthetic/some/other/place"));

		expectOk(result);
		expect(result.source).toBe("id");
		expect(result.path).toBe(path);
	});

	it("reports an ambiguous id with sorted absolute candidates", () => {
		const root = makeRoot();
		const first = writeSession(root, "-synthetic-alpha", "duplicate-id");
		const second = writeSession(root, "-synthetic-beta", "duplicate-id");

		const result = locateClaudeSession(options("duplicate-id", root));

		expectError(result, "ambiguous");
		expect(result.candidates).toEqual([first, second].sort());
		expect(result.message).toContain("duplicate-id");
	});

	it("returns not-found for an unknown id", () => {
		const root = makeRoot();
		writeSession(root, "-synthetic-alpha", "known-session");

		expectError(locateClaudeSession(options("unknown-session", root)), "not-found");
	});

	it("does not prefix-match an id (DP5, DR1)", () => {
		const root = makeRoot();
		writeSession(root, "-synthetic-alpha", "abcdef01-2345");

		expectError(locateClaudeSession(options("abcdef01", root)), "not-found");
	});

	it("does not treat an uppercase LATEST as the keyword", () => {
		const root = makeRoot();
		writeSession(root, "-synthetic-alpha", "some-session");

		expectError(locateClaudeSession(options("LATEST", root)), "not-found");
	});

	it("returns not-found when the projects root holds no project directories", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("abcdef01", root)), "not-found");
	});

	it("returns not-found when the projects root does not exist", () => {
		const root = makeRoot();

		expectError(locateClaudeSession(options("abcdef01", join(root, "absent"))), "not-found");
	});
});

describe("locateClaudeSession: latest", () => {
	it("picks the newest session in the cwd's project directory", () => {
		const root = makeRoot();
		const slug = claudeProjectSlug("/synthetic/work/repo");
		writeSession(root, slug, "older-session", T_BASE);
		const newest = writeSession(root, slug, "newer-session", T_BASE + 60);

		const result = locateClaudeSession(options("latest", root));

		expectOk(result);
		expect(result.source).toBe("latest");
		expect(result.path).toBe(newest);
		expect(result.sessionId).toBe("newer-session");
	});

	it("breaks an mtime tie deterministically by path", () => {
		const root = makeRoot();
		const slug = claudeProjectSlug("/synthetic/work/repo");
		writeSession(root, slug, "zzz-session", T_BASE);
		const first = writeSession(root, slug, "aaa-session", T_BASE);

		const result = locateClaudeSession(options("latest", root));

		expectOk(result);
		expect(result.path).toBe(first);
	});

	it("falls back to the newest session in any project directory when the cwd has no project dir", () => {
		const root = makeRoot();
		writeSession(root, "-synthetic-elsewhere-one", "elsewhere-one", T_BASE);
		const newest = writeSession(root, "-synthetic-elsewhere-two", "elsewhere-two", T_BASE + 120);

		const result = locateClaudeSession(options("latest", root, "/synthetic/brand/new/place"));

		expectOk(result);
		expect(result.source).toBe("latest");
		expect(result.path).toBe(newest);
		expect(result.projectDir).toBe(dirname(newest));
	});

	it("returns not-found for an empty project directory instead of borrowing another project", () => {
		const root = makeRoot();
		mkdirSync(join(root, claudeProjectSlug("/synthetic/work/repo")), { recursive: true });
		writeSession(root, "-synthetic-elsewhere", "elsewhere-session", T_BASE);

		expectError(locateClaudeSession(options("latest", root)), "not-found");
	});

	it("returns not-found when the store holds no sessions at all", () => {
		const root = makeRoot();
		expectError(locateClaudeSession(options("latest", root, "/synthetic/brand/new/place")), "not-found");
	});

	it("returns not-found when the projects root does not exist", () => {
		const root = makeRoot();
		expectError(locateClaudeSession(options("latest", join(root, "absent"), "/synthetic/brand/new/place")), "not-found");
	});
});

describe("locateClaudeSession: unreadable files", () => {
	const isWindows = process.platform === "win32";
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

	/** Make a path unreadable and hand back the undo, so cleanup never trips over a locked dir. */
	function lock(path: string): () => void {
		chmodSync(path, 0o000);
		return () => {
			chmodSync(path, 0o700);
		};
	}

	it.skipIf(isWindows || isRoot)("reports an unreadable explicit path as unreadable", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-export", "locked-session");
		const unlock = lock(path);
		try {
			const result = locateClaudeSession(options(path, root));

			expectError(result, "unreadable");
			expect(result.message).toContain(path);
		} finally {
			unlock();
		}
	});

	it.skipIf(isWindows || isRoot)("reports an unreadable id match as unreadable", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-alpha", "locked-id");
		const unlock = lock(path);
		try {
			expectError(locateClaudeSession(options("locked-id", root)), "unreadable");
		} finally {
			unlock();
		}
	});

	it.skipIf(isWindows || isRoot)("reports an unreadable projects root as unreadable", () => {
		const root = makeRoot();
		writeSession(root, "-synthetic-alpha", "session-one");
		const unlock = lock(root);
		try {
			expectError(locateClaudeSession(options("session-one", root)), "unreadable");
		} finally {
			unlock();
		}
	});

	it.skipIf(isWindows || isRoot)("reports a project directory it could not search as unreadable", () => {
		const root = makeRoot();
		const hiddenDir = join(root, "-synthetic-hidden");
		writeSession(root, "-synthetic-hidden", "hidden-session");
		const unlock = lock(hiddenDir);
		try {
			expectError(locateClaudeSession(options("hidden-session", root)), "unreadable");
		} finally {
			unlock();
		}
	});

	it.skipIf(isWindows || isRoot)("reports an unreadable cwd project directory for latest as unreadable", () => {
		const root = makeRoot();
		const slug = claudeProjectSlug("/synthetic/work/repo");
		const projectDir = join(root, slug);
		writeSession(root, slug, "session-one", T_BASE);
		const unlock = lock(projectDir);
		try {
			expectError(locateClaudeSession(options("latest", root)), "unreadable");
		} finally {
			unlock();
		}
	});
});

describe("locateClaudeSession: result shape", () => {
	it("is deterministic for the same input", () => {
		const root = makeRoot();
		const slug = claudeProjectSlug("/synthetic/work/repo");
		writeSession(root, slug, "session-one", T_BASE);
		writeSession(root, "-synthetic-alpha", "duplicate-id");
		writeSession(root, "-synthetic-beta", "duplicate-id");

		for (const spec of ["session-one", "duplicate-id", "latest", "missing-session", ""]) {
			const input = options(spec, root);
			expect(locateClaudeSession(input)).toEqual(locateClaudeSession(input));
			expect(JSON.stringify(locateClaudeSession(input))).toBe(JSON.stringify(locateClaudeSession(input)));
		}
	});

	it("returns only JSON-serializable metadata, never file contents", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-alpha", "session-one");

		const ok = locateClaudeSession(options("session-one", root));
		expectOk(ok);
		expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
		expect(JSON.stringify(ok)).not.toContain(SENTINEL);

		const absent = locateClaudeSession(options("duplicate-id", root));
		expectError(absent, "not-found");
		expect(JSON.parse(JSON.stringify(absent))).toEqual(absent);
		expect(JSON.stringify(absent)).not.toContain(SENTINEL);

		const byPath = locateClaudeSession(options(path, root));
		expectOk(byPath);
		expect(Object.keys(byPath).sort()).toEqual(["ok", "path", "projectDir", "sessionId", "source"]);
		expect(basename(byPath.path)).toBe("session-one.jsonl");
		expect(JSON.stringify(byPath)).not.toContain(SENTINEL);
	});

	it("never includes a Date or non-plain value on the picked file", () => {
		const root = makeRoot();
		const path = writeSession(root, "-synthetic-alpha", "session-one");

		const result = locateClaudeSession(options("session-one", root));
		expectOk(result);
		expect(statSync(path).isFile()).toBe(true);
		expect(typeof result.path).toBe("string");
	});
});
