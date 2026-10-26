/**
 * Hermetic checks for the end-to-end harness itself (DP13).
 *
 * Unlike `resume.test.ts`, this file never calls a model and never reads a real Claude Code or
 * pi store: it validates the config, the temp-HOME layout, and the synthetic fixtures so that a
 * broken harness fails without needing `PI_CLAUDE_IT=1`. That is why these cases can run in CI
 * while the model-dependent suite stays opt-in and skips loudly.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_IT_MODEL,
	EMPTY_SESSION,
	FIXTURES,
	FIXTURES_ROOT,
	HERMETIC_PI_FLAGS,
	LONG_SESSION,
	MALFORMED_SESSION,
	ONE_TURN_SESSION,
	PROJECT_CWD_PLACEHOLDER,
	REPO_ROOT,
	TOOL_SESSION,
	claudeProjectDirFor,
	createFixtureHome,
	disposeFixtureHome,
	hermeticPiFlags,
	integrationModel,
	isIntegrationEnabled,
	parseJsonlEntries,
	piExecutable,
	projectSlugFor,
} from "./helpers.ts";
import integrationConfig from "./vitest.config.ts";

describe("integration config", () => {
	it("includes the integration suite at the repository root and nothing else", () => {
		const test = integrationConfig.test;
		expect(test).toBeDefined();
		expect(integrationConfig.root).toBe(REPO_ROOT);
		// `root` is the repository, so this pattern is repo-relative and resolves to this folder.
		expect(test?.include).toEqual(["tests/integration/**/*.test.ts"]);
		expect(test?.environment).toBe("node");
		expect(test?.testTimeout).toBe(180_000);
		expect(test?.fileParallelism).toBe(false);
	});

	it("does not exclude tests/integration from the run", () => {
		const exclude = integrationConfig.test?.exclude ?? [];
		expect(exclude.filter((pattern) => pattern.includes("integration"))).toEqual([]);
	});

	it("points at the pi CLI shipped in node_modules", () => {
		expect(path.isAbsolute(piExecutable())).toBe(true);
		expect(piExecutable().startsWith(REPO_ROOT)).toBe(true);
	});
});

describe("temp HOME layout", () => {
	it("mirrors the extension's project slug for the fixture directory", () => {
		// The fixture directory name records the synthetic slug of `/tmp/project` (DP5).
		expect(projectSlugFor("/tmp/project")).toBe("-tmp-project");
		expect(path.basename(FIXTURES_ROOT)).toBe(projectSlugFor("/tmp/project"));
	});

	it("copies every fixture into <home>/.claude/projects/<slug> and templates the cwd", async () => {
		const home = await createFixtureHome();
		try {
			expect(home.home.startsWith(tmpdir())).toBe(true);
			expect(home.projectDir.startsWith(home.baseDir)).toBe(true);
			expect(home.home.startsWith(homedir())).toBe(false);
			expect(home.claudeProjectDir).toBe(claudeProjectDirFor(home.home, home.projectDir));
			expect(path.basename(home.claudeProjectDir)).toBe(projectSlugFor(home.projectDir));

			const names = (await readdir(home.claudeProjectDir)).sort();
			expect(names).toEqual(FIXTURES.map((fixture) => fixture.fileName).sort());

			const emptyStat = await stat(path.join(home.claudeProjectDir, EMPTY_SESSION.fileName));
			expect(emptyStat.size).toBe(0);

			const longRaw = await readFile(
				path.join(home.claudeProjectDir, LONG_SESSION.fileName),
				"utf8",
			);
			expect(longRaw).not.toContain(PROJECT_CWD_PLACEHOLDER);
			expect(longRaw).toContain(JSON.stringify(home.projectDir).slice(1, -1));

			// Deterministic mtimes: `--claude latest` must resolve to the long session.
			const longMtime = (await stat(path.join(home.claudeProjectDir, LONG_SESSION.fileName)))
				.mtimeMs;
			for (const fixture of FIXTURES) {
				if (fixture.sessionId === LONG_SESSION.sessionId) continue;
				const other = await stat(path.join(home.claudeProjectDir, fixture.fileName));
				expect(longMtime).toBeGreaterThan(other.mtimeMs);
			}

			expect(home.sessionId).toBe(LONG_SESSION.sessionId);
			expect(home.expectedFact).toBe(LONG_SESSION.fact);
		} finally {
			await disposeFixtureHome(home);
		}
	});

	it("removes the whole temp tree on dispose", async () => {
		const home = await createFixtureHome();
		await disposeFixtureHome(home);
		await expect(stat(home.baseDir)).rejects.toThrow();
	});
});

describe("synthetic fixtures", () => {
	it("parses as JSONL, including the intentional malformed line", async () => {
		const expectedLineCounts = new Map<string, number>([
			[LONG_SESSION.fileName, 4],
			[ONE_TURN_SESSION.fileName, 1],
			[TOOL_SESSION.fileName, 4],
			[MALFORMED_SESSION.fileName, 3],
			[EMPTY_SESSION.fileName, 0],
		]);

		for (const fixture of FIXTURES) {
			const raw = await readFile(path.join(FIXTURES_ROOT, fixture.fileName), "utf8");
			const lines = raw.split("\n").filter((line) => line.trim() !== "");
			expect(lines.length, fixture.fileName).toBe(
				expectedLineCounts.get(fixture.fileName) ?? -1,
			);
			const parsed = parseJsonlEntries(raw);
			if (fixture.fileName === MALFORMED_SESSION.fileName) {
				// Exactly one line is truncated; the parser skips it rather than throwing (DP11).
				expect(parsed.length, fixture.fileName).toBe(lines.length - 1);
			} else {
				expect(parsed.length, fixture.fileName).toBe(lines.length);
			}
			for (const entry of parsed) {
				expect(typeof entry.type, fixture.fileName).toBe("string");
			}
		}
	});

	it("carries each expected codeword only in its own transcript file", async () => {
		const texts = new Map<string, string>();
		for (const fixture of FIXTURES) {
			texts.set(
				fixture.fileName,
				await readFile(path.join(FIXTURES_ROOT, fixture.fileName), "utf8"),
			);
		}

		for (const fixture of FIXTURES) {
			const own = texts.get(fixture.fileName) ?? "";
			if (fixture.fact === null) {
				expect(own, fixture.fileName).toBe("");
				continue;
			}
			expect(own.toLowerCase(), fixture.fileName).toContain(fixture.fact.toLowerCase());
			for (const other of FIXTURES) {
				if (other.sessionId === fixture.sessionId || other.fact === null) continue;
				expect(own.toLowerCase(), fixture.fileName).not.toContain(
					other.fact.toLowerCase(),
				);
			}
		}
	});

	it("contains no real-machine paths or captured session data (DP12)", async () => {
		const realHome = homedir();
		for (const fixture of FIXTURES) {
			const raw = await readFile(path.join(FIXTURES_ROOT, fixture.fileName), "utf8");
			expect(raw, fixture.fileName).not.toContain(realHome);
			expect(raw, fixture.fileName).not.toMatch(/\/(?:home|Users)\//);
			if (raw === "") continue;
			// Every absolute path in a fixture is either the synthetic /repo tree or the temp
			// project placeholder; nothing points at a real checkout.
			expect(raw, fixture.fileName).toContain(PROJECT_CWD_PLACEHOLDER);
		}

		// The tool fixture's paths are invented.
		const toolRaw = await readFile(path.join(FIXTURES_ROOT, TOOL_SESSION.fileName), "utf8");
		expect(toolRaw).toContain("/repo/src/release.txt");
	});

	it("only uses session ids that match their file names", () => {
		for (const fixture of FIXTURES) {
			expect(fixture.fileName).toBe(`${fixture.sessionId}.jsonl`);
		}
	});
});

describe("opt-in gate", () => {
	it("enables the model-dependent suite only for PI_CLAUDE_IT=1", () => {
		expect(isIntegrationEnabled({})).toBe(false);
		expect(isIntegrationEnabled({ PI_CLAUDE_IT: "0" })).toBe(false);
		expect(isIntegrationEnabled({ PI_CLAUDE_IT: "true" })).toBe(false);
		expect(isIntegrationEnabled({ PI_CLAUDE_IT: "1" })).toBe(true);
	});

	it("defaults the model and honours PI_CLAUDE_IT_MODEL", () => {
		expect(integrationModel({})).toBe(DEFAULT_IT_MODEL);
		expect(integrationModel({ PI_CLAUDE_IT_MODEL: "   " })).toBe(DEFAULT_IT_MODEL);
		expect(integrationModel({ PI_CLAUDE_IT_MODEL: "provider/model" })).toBe("provider/model");
	});

	it("keeps --no-extensions off and adds --offline only on request", () => {
		// `-e src/index.ts` is the extension under test; forbidding extension discovery must not
		// disable it, so --no-extensions never appears in the child argv.
		expect(hermeticPiFlags({})).not.toContain("--no-extensions");
		expect(hermeticPiFlags({})).toEqual([...HERMETIC_PI_FLAGS]);
		expect(hermeticPiFlags({ PI_CLAUDE_IT_OFFLINE: "1" })).toEqual([
			"--offline",
			...HERMETIC_PI_FLAGS,
		]);
		// Every flag narrows discovery; none of them selects a session or a model.
		expect(HERMETIC_PI_FLAGS).not.toContain("--session");
		expect(HERMETIC_PI_FLAGS).not.toContain("--model");
	});
});
