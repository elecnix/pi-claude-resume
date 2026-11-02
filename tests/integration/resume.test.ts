/**
 * End-to-end: `pi -p --claude <session-id> "<prompt>"` resumes a synthetic Claude Code session
 * (DP1, DP13). These tests assert on what the model can answer, so they are opt-in.
 *
 * How to run (needs a reachable model and provider credentials in the environment):
 *
 *   PI_CLAUDE_IT=1 OPENROUTER_API_KEY=... \
 *     npx vitest run --config tests/integration/vitest.config.ts
 *
 * `PI_CLAUDE_IT_MODEL` overrides the model, which defaults to
 * `openrouter/deepseek/deepseek-v4.1-flash` — a provider pi ships in core, so it resolves in a
 * child whose agent directory starts empty. Credentials must come from the environment (for
 * example `OPENROUTER_API_KEY`, from `pi auth print-api-key --provider openrouter` here): pi's
 * `auth.json` is deliberately not used, because `HOME` and pi's agent directory are redirected
 * into a temp directory (DP12). The Claude store is relocated with Claude Code's own
 * `CLAUDE_CONFIG_DIR` instead of by moving `HOME`, which is what keeps pi's model catalogue and
 * provider credentials reachable (DP4).
 * Pass `PI_CLAUDE_IT_OFFLINE=1` only when the model is known without discovery (an offline run
 * cannot refresh a model catalogue in a fresh agent directory).
 * Without `PI_CLAUDE_IT=1` the whole suite skips with a warning so unit runs and CI stay
 * hermetic (DP13).
 *
 * Every fixture is hand-written and synthetic (DP12); the only fact the tests ask about is a
 * codeword that exists in one fixture transcript and nowhere else.
 */
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BOUNDARY_CUSTOM_TYPE, TRANSCRIPT_CUSTOM_TYPE } from "../../src/types.ts";
import {
	EMPTY_SESSION,
	EXTENSION_ENTRY,
	isInside,
	LONG_SESSION,
	MALFORMED_SESSION,
	ONE_TURN_SESSION,
	TOOL_SESSION,
	claudeSessionFile,
	containsIgnoreCase,
	countCustomMessages,
	customMessageContents,
	createFixtureHome,
	customMessageCounts,
	disposeFixtureHome,
	formatRunResult,
	hermeticPiFlags,
	integrationModel,
	isIntegrationEnabled,
	listPiJsonlFiles,
	runPi,
} from "./helpers.ts";
import type { FixtureHome, FixtureSession, PiRunResult } from "./helpers.ts";

const MODEL = integrationModel();
const ENABLED = isIntegrationEnabled();

if (!ENABLED) {
	console.warn(
		[
			"",
			"[pi-claude-resume] SKIPPING end-to-end resume tests: PI_CLAUDE_IT is not 1.",
			"These tests call a real model and are opt-in (DP13). To run them:",
			"  PI_CLAUDE_IT=1 OPENROUTER_API_KEY=... \\",
			"    npx vitest run --config tests/integration/vitest.config.ts",
			`(model: ${MODEL}, override with PI_CLAUDE_IT_MODEL)`,
			"",
		].join("\n"),
	);
}

const suite = ENABLED ? describe : describe.skip;

/**
 * The only prompt the suite sends. Kept short so each model call is cheap; asking for a fact
 * that exists solely in the fixture transcript is what proves the transcript reached the model.
 */
const PROMPT =
	"Without using any tools, reply with exactly one line: the deployment codeword that appears in the Claude Code transcript. If no Claude Code transcript is present, reply exactly NO-TRANSCRIPT.";

/** A syntactically valid session id that the temp tree cannot contain. */
const UNKNOWN_SESSION_ID = "00000000-0000-4000-8000-000000000000";

/** Synthetic pi session id for the persistence test. */
const PI_SESSION_ID = "7e4a0c91-2b6d-4f38-8a05-3c9d1e6b2f47";

/** Every suite run creates its own temp tree; all of them are removed at the end (DP12). */
const homes: FixtureHome[] = [];

async function newFixtureHome(): Promise<FixtureHome> {
	const home = await createFixtureHome();
	homes.push(home);
	return home;
}

afterAll(async () => {
	for (const home of homes) {
		await disposeFixtureHome(home);
	}
});

/** Base argv: print mode, load this worktree's extension, pick the model, stay hermetic. */
function baseArgs(): string[] {
	return ["-p", "-e", EXTENSION_ENTRY, "--model", MODEL, ...hermeticPiFlags()];
}

/** Ephemeral run: nothing is persisted, so these cases only inspect stdout/stderr. */
function ephemeralArgs(extra: readonly string[]): string[] {
	return [...baseArgs(), "--no-session", ...extra];
}

/** Persisting run: pi keeps its session under the fixture's `sessions/` directory. */
function persistingArgs(fixture: FixtureHome, extra: readonly string[]): string[] {
	return [...baseArgs(), "--session-dir", fixture.sessionsDir, ...extra];
}

function expectSuccess(run: PiRunResult): void {
	expect(run.code, formatRunResult(run)).toBe(0);
}

/** A fixture's codeword, or a hard failure: an empty codeword would make the assertion vacuous. */
function factOf(fixture: FixtureSession): string {
	if (fixture.fact === null) {
		throw new Error(`fixture ${fixture.fileName} carries no codeword`);
	}
	return fixture.fact;
}

suite("pi -p --claude resumes a synthetic Claude Code session", () => {
	it("answers with a fact that exists only in the four-turn transcript", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", home.sessionId, PROMPT]), {
			fixture: home,
		});

		expectSuccess(run);
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			true,
		);
		// `--no-session` means no session JSONL anywhere in the temp tree (DP4, DP12).
		expect(await listPiJsonlFiles(home), formatRunResult(run)).toEqual([]);
	});

	it("does not know the fact without --claude (control run)", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs([PROMPT]), { fixture: home });

		expectSuccess(run);
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			false,
		);
	});

	it("fails loudly for an unknown session id and injects nothing", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", UNKNOWN_SESSION_ID, PROMPT]), {
			fixture: home,
		});

		expect(run.code, formatRunResult(run)).not.toBe(0);
		// DP5/DP11: the failure names what was looked for.
		expect(run.stderr, formatRunResult(run)).toContain(UNKNOWN_SESSION_ID);
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			false,
		);
	});

	it("resolves --claude latest to the newest session of the project directory", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", "latest", PROMPT]), {
			fixture: home,
		});

		// The harness gives the long fixture both the newest timestamp and the newest mtime, so
		// `latest` is unambiguous whichever signal the implementation ranks by.
		expectSuccess(run);
		expect(containsIgnoreCase(run.stdout, factOf(LONG_SESSION)), formatRunResult(run)).toBe(
			true,
		);
	});

	it("resumes a one-turn session", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", ONE_TURN_SESSION.sessionId, PROMPT]), {
			fixture: home,
		});

		expectSuccess(run);
		expect(
			containsIgnoreCase(run.stdout, factOf(ONE_TURN_SESSION)),
			formatRunResult(run),
		).toBe(true);
	});

	it("keeps tool results in the transcript (tool_use/tool_result pair)", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", TOOL_SESSION.sessionId, PROMPT]), {
			fixture: home,
		});

		expectSuccess(run);
		// The codeword appears only inside the fixture's tool_result content (DP6, DP7).
		expect(containsIgnoreCase(run.stdout, factOf(TOOL_SESSION)), formatRunResult(run)).toBe(
			true,
		);
	});

	it("tolerates a malformed line and still resumes the valid turns", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", MALFORMED_SESSION.sessionId, PROMPT]), {
			fixture: home,
		});

		expectSuccess(run);
		expect(
			containsIgnoreCase(run.stdout, factOf(MALFORMED_SESSION)),
			formatRunResult(run),
		).toBe(true);
	});

	it("fails loudly for a session with no usable turns", async () => {
		const home = await newFixtureHome();
		const run = await runPi(ephemeralArgs(["--claude", EMPTY_SESSION.sessionId, PROMPT]), {
			fixture: home,
		});

		// DP11: nothing to inject means an error and a non-zero exit, not an empty history. The
		// diagnostic here is about the file's contents, not about which id was asked for, so it
		// names the failure (`empty-session`) rather than repeating the id the caller passed;
		// the id is echoed by a *locate* failure, which the cases above cover.
		expect(run.code, formatRunResult(run)).not.toBe(0);
		expect(run.stderr, formatRunResult(run)).toContain("empty-session");
		expect(run.stderr, formatRunResult(run)).toContain("no conversation to resume");
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			false,
		);
	});

	it("accepts an absolute path as the --claude spec", async () => {
		const home = await newFixtureHome();
		const pathSpec = claudeSessionFile(home.claudeConfigDir, home.projectDir, home.sessionId);
		const run = await runPi(ephemeralArgs(["--claude", pathSpec, PROMPT]), {
			fixture: home,
		});

		expectSuccess(run);
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			true,
		);
	});

	it("rejects a partial session id instead of guessing (DP5, DR1)", async () => {
		const home = await newFixtureHome();
		const partial = home.sessionId.slice(0, 8);
		const run = await runPi(ephemeralArgs(["--claude", partial, PROMPT]), {
			fixture: home,
		});

		expect(run.code, formatRunResult(run)).not.toBe(0);
		expect(run.stderr, formatRunResult(run)).toContain(partial);
		expect(containsIgnoreCase(run.stdout, home.expectedFact), formatRunResult(run)).toBe(
			false,
		);
	});

	it("records the import once and does not duplicate it when the pi session is re-run (DP10)", async () => {
		const home = await newFixtureHome();

		const first = await runPi(
			persistingArgs(home, [
				"--session-id",
				PI_SESSION_ID,
				"--claude",
				home.sessionId,
				PROMPT,
			]),
			{ fixture: home },
		);
		expectSuccess(first);

		const afterFirst = await customMessageCounts(home);
		expect(afterFirst[TRANSCRIPT_CUSTOM_TYPE] ?? 0, formatRunResult(first)).toBe(1);
		// DP8: the import ends with the boundary notice, sent as its own custom message (DR2).
		expect(afterFirst[BOUNDARY_CUSTOM_TYPE] ?? 0, formatRunResult(first)).toBe(1);

		const transcripts = await customMessageContents(home, TRANSCRIPT_CUSTOM_TYPE);
		expect(transcripts.length, formatRunResult(first)).toBe(1);
		expect(
			containsIgnoreCase(transcripts[0] ?? "", home.expectedFact),
			formatRunResult(first),
		).toBe(true);

		// Persistence went where `--session-dir` points, and nowhere else: the only session JSONL
		// in the temp tree is the one under `sessions/` (DP4, DP12).
		const written = await listPiJsonlFiles(home);
		expect(written.length, formatRunResult(first)).toBe(1);
		expect(isInside(home.sessionsDir, written[0] ?? ""), formatRunResult(first)).toBe(true);
		expect(path.dirname(written[0] ?? ""), formatRunResult(first)).toBe(
			path.resolve(home.sessionsDir),
		);

		// Same pi session, same --claude id: the transcript is keyed by the Claude session id and
		// must not be injected a second time.
		const second = await runPi(
			persistingArgs(home, [
				"--session",
				PI_SESSION_ID,
				"--claude",
				home.sessionId,
				"Reply with the single word OK.",
			]),
			{ fixture: home },
		);
		expectSuccess(second);

		const afterSecond = await customMessageCounts(home);
		expect(afterSecond, formatRunResult(second)).toEqual(afterFirst);
		expect(
			await countCustomMessages(home, TRANSCRIPT_CUSTOM_TYPE),
			formatRunResult(second),
		).toBe(1);
		// The re-run reused the same session file instead of creating another one.
		expect(await listPiJsonlFiles(home), formatRunResult(second)).toEqual(written);
	});
});
