/**
 * Tests for `CLAUDE_CONFIG_DIR` handling in the adapter layer (DP3, DP4).
 *
 * The rules pinned here are the ones a user can observe: an unset or blank variable leaves the
 * default store alone, a set one moves the projects root, and nothing in the process environment
 * is ever written. Everything is synthetic (DP12): invented paths, no real Claude installation.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CONFIG_DIR_ENV, claudeProjectsRoot } from "../../src/cli/env.ts";

/** A path no machine has; only used to build expectations. */
const SYNTHETIC_CONFIG_DIR = "/tmp/pi-claude-resume-synthetic/claude-config";

/** The variable name is part of the contract (Claude Code's own spelling), so pin it too. */
describe("CLAUDE_CONFIG_DIR_ENV", () => {
	it('is the exact variable Claude Code reads', () => {
		expect(CLAUDE_CONFIG_DIR_ENV).toBe("CLAUDE_CONFIG_DIR");
	});
});

describe("claudeProjectsRoot", () => {
	const saved = process.env[CLAUDE_CONFIG_DIR_ENV];

	afterEach(() => {
		// The default-argument case reads the real process environment; restore it either way.
		if (saved === undefined) {
			delete process.env[CLAUDE_CONFIG_DIR_ENV];
		} else {
			process.env[CLAUDE_CONFIG_DIR_ENV] = saved;
		}
	});

	it("returns undefined when the variable is unset", () => {
		expect(claudeProjectsRoot({})).toBeUndefined();
	});

	it("returns undefined when the variable is an empty string", () => {
		expect(claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: "" })).toBeUndefined();
	});

	it("returns undefined when the variable is only whitespace", () => {
		for (const blank of [" ", "\t", "\n", "   \t  "]) {
			expect(claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: blank })).toBeUndefined();
		}
	});

	it("returns undefined rather than a string, so the caller can fall back", () => {
		expect(typeof claudeProjectsRoot({})).toBe("undefined");
		expect(typeof claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: SYNTHETIC_CONFIG_DIR })).toBe(
			"string",
		);
	});

	it("appends the projects directory to an absolute value", () => {
		expect(claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: SYNTHETIC_CONFIG_DIR })).toBe(
			path.join(SYNTHETIC_CONFIG_DIR, "projects"),
		);
	});

	it("trims surrounding whitespace before joining", () => {
		expect(
			claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: `  ${SYNTHETIC_CONFIG_DIR}\n` }),
		).toBe(path.join(SYNTHETIC_CONFIG_DIR, "projects"));
	});

	it("keeps a relative value relative", () => {
		expect(claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: "synthetic/claude-config" })).toBe(
			path.join("synthetic/claude-config", "projects"),
		);
	});

	it("drops a trailing separator instead of doubling it", () => {
		expect(claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: `${SYNTHETIC_CONFIG_DIR}/` })).toBe(
			path.join(SYNTHETIC_CONFIG_DIR, "projects"),
		);
		expect(
			claudeProjectsRoot({ [CLAUDE_CONFIG_DIR_ENV]: `${SYNTHETIC_CONFIG_DIR}//` }),
		).toBe(path.join(SYNTHETIC_CONFIG_DIR, "projects"));
	});

	it("reads the environment it is given, not the process environment", () => {
		process.env[CLAUDE_CONFIG_DIR_ENV] = "/tmp/pi-claude-resume-synthetic/other-root";
		const env = { [CLAUDE_CONFIG_DIR_ENV]: SYNTHETIC_CONFIG_DIR };
		expect(claudeProjectsRoot(env)).toBe(path.join(SYNTHETIC_CONFIG_DIR, "projects"));
		expect(claudeProjectsRoot()).toBe(
			path.join("/tmp/pi-claude-resume-synthetic/other-root", "projects"),
		);
	});

	it("does not mutate the environment object it is given", () => {
		const env = Object.freeze({ [CLAUDE_CONFIG_DIR_ENV]: ` ${SYNTHETIC_CONFIG_DIR} ` });
		expect(claudeProjectsRoot(env)).toBe(path.join(SYNTHETIC_CONFIG_DIR, "projects"));
		expect(env).toEqual({ [CLAUDE_CONFIG_DIR_ENV]: ` ${SYNTHETIC_CONFIG_DIR} ` });
	});

	it("does not write to process.env when called with no arguments", () => {
		process.env[CLAUDE_CONFIG_DIR_ENV] = ` ${SYNTHETIC_CONFIG_DIR} `;
		const before = { ...process.env };

		expect(claudeProjectsRoot()).toBe(path.join(SYNTHETIC_CONFIG_DIR, "projects"));

		// The value survives verbatim (not trimmed in place) and no new key appeared.
		expect(process.env[CLAUDE_CONFIG_DIR_ENV]).toBe(` ${SYNTHETIC_CONFIG_DIR} `);
		expect({ ...process.env }).toEqual(before);
	});
});
