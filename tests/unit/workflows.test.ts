/**
 * Invariants for the repository's CI configuration (DP13, DP14, DP15).
 *
 * Deliberately dependency-free: no YAML parser, no actionlint. The workflows are read as text and
 * the few structural facts that matter are asserted with a tiny indentation-aware block reader.
 * A YAML library would parse these files happily while still letting a `branches:` filter silently
 * exclude stacked pull requests (DP14), so the assertions are written against the text that
 * review actually sees.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoFile(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), "utf8");
}

const ci = repoFile(".github/workflows/ci.yml");
const review = repoFile(".github/workflows/review.yml");
const valeWorkflow = repoFile(".github/workflows/vale.yml");
const dupdelta = repoFile(".github/workflows/dupdelta.yml");
const dependabot = repoFile(".github/dependabot.yml");

interface YamlBlock {
	/** The line that opens the block, e.g. `  push:`. */
	readonly header: string;
	readonly indent: number;
	/** Non-blank, non-comment lines nested under the header. */
	readonly body: readonly string[];
}

function indentOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** First block whose header line matches `headerPattern`, bounded by indentation. */
function findBlock(text: string, headerPattern: RegExp): YamlBlock | undefined {
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (!headerPattern.test(line)) continue;
		const indent = indentOf(line);
		const body: string[] = [];
		for (const candidate of lines.slice(index + 1)) {
			const candidateText = candidate.trim();
			if (candidateText === "") continue;
			if (candidateText.startsWith("#")) continue;
			if (indentOf(candidate) <= indent) break;
			body.push(candidate);
		}
		return { header: line, indent, body };
	}
	return undefined;
}

function requireBlock(text: string, headerPattern: RegExp): YamlBlock {
	const block = findBlock(text, headerPattern);
	if (!block) throw new Error(`no YAML block matching ${String(headerPattern)}`);
	return block;
}

/** Direct `key: value` children of a block, at the block's own child indentation. */
function childEntries(block: YamlBlock): Array<{ key: string; value: string }> {
	if (block.body.length === 0) return [];
	const childIndent = Math.min(...block.body.map(indentOf));
	const entries: Array<{ key: string; value: string }> = [];
	for (const line of block.body) {
		if (indentOf(line) !== childIndent) continue;
		const match = /^\s*([^\s:#][^:]*):(.*)$/.exec(line);
		if (!match) continue;
		entries.push({ key: (match[1] ?? "").trim(), value: (match[2] ?? "").trim() });
	}
	return entries;
}

function childKeys(block: YamlBlock): string[] {
	return childEntries(block).map((entry) => entry.key);
}

function childValue(block: YamlBlock, key: string): string | undefined {
	return childEntries(block).find((entry) => entry.key === key)?.value;
}

/** `- item` list entries anywhere inside a block (used for `branches:` lists). */
function listItems(block: YamlBlock): string[] {
	return block.body
		.map((line) => /^\s*-\s*(.+?)\s*$/.exec(line)?.[1])
		.filter((item): item is string => typeof item === "string");
}

function linesMatching(text: string, pattern: RegExp): string[] {
	return text.split(/\r?\n/).filter((line) => pattern.test(line));
}

describe("ci.yml", () => {
	it("is named ci and runs on every pull request", () => {
		expect(ci).toMatch(/^name:\s*ci\s*$/m);
		const on = requireBlock(ci, /^on:\s*$/);
		expect(childKeys(on)).toEqual(["pull_request", "push"]);
	});

	it("keeps pull_request unfiltered so stacked PRs are checked (DP14)", () => {
		const pullRequest = requireBlock(ci, /^\s*pull_request:\s*$/);
		expect(pullRequest.body.filter((line) => /^\s*branches\s*:/.test(line))).toEqual([]);
		expect(pullRequest.body).toEqual([]);
		// The only `branches:` key in the file is the push filter, asserted in the next test.
		expect(linesMatching(ci, /^\s*branches\s*:/)).toHaveLength(1);
	});

	it("checks main on push only", () => {
		const push = requireBlock(ci, /^\s{2}push:\s*$/);
		expect(childKeys(push)).toEqual(["branches"]);
		expect(listItems(push)).toEqual(["main"]);
	});

	it("grants read-only repository contents", () => {
		const permissions = requireBlock(ci, /^permissions:\s*$/);
		expect(childEntries(permissions)).toEqual([{ key: "contents", value: "read" }]);
	});

	it("runs a single test job on ubuntu-latest with a 15 minute timeout", () => {
		expect(childKeys(requireBlock(ci, /^jobs:\s*$/))).toEqual(["test"]);
		const testJob = requireBlock(ci, /^\s{2}test:\s*$/);
		expect(childValue(testJob, "runs-on")).toBe("ubuntu-latest");
		expect(childValue(testJob, "timeout-minutes")).toBe("15");
	});

	it("pins Node 22 and enables the npm cache without a lockfile", () => {
		expect(ci).toMatch(/^\s*- uses: actions\/checkout@v4\s*$/m);
		expect(ci).toMatch(/^\s*- uses: actions\/setup-node@v4\s*$/m);
		const withBlock = requireBlock(ci, /^\s*with:\s*$/);
		expect(childValue(withBlock, "node-version")).toBe("22");
		expect(childValue(withBlock, "cache")).toBe("npm");
		// No committed lockfile exists, so setup-node needs the manifest as its cache key input.
		expect(childValue(withBlock, "cache-dependency-path")).toBe("package.json");
	});

	it("installs dependencies without audit or funding noise", () => {
		expect(ci).toMatch(/^\s*- run: npm install --no-audit --no-fund\s*$/m);
		// `npm ci` cannot work here: there is no committed lockfile, so no step may use it.
		expect(linesMatching(ci, /^\s*-\s*run:\s*npm ci\b/)).toEqual([]);
	});

	it("runs the type-check and the unit tests (DP13, DP14)", () => {
		expect(ci).toMatch(/^\s*- run: npm run typecheck\s*$/m);
		expect(ci).toMatch(/^\s*- run: npm test\s*$/m);
	});

	it("cancels superseded runs for the same ref", () => {
		const concurrency = requireBlock(ci, /^concurrency:\s*$/);
		expect(childValue(concurrency, "group")).toBe("ci-${{ github.ref }}");
		expect(childValue(concurrency, "cancel-in-progress")).toBe("true");
	});
});

/** `with:` block of the step whose `uses:` line contains `usesFragment`, never another step's. */
function stepWithBlock(text: string, usesFragment: string): YamlBlock {
	const start = text.indexOf(usesFragment);
	if (start < 0) throw new Error(`no step uses ${usesFragment}`);
	return requireBlock(text.slice(start), /^\s*with:\s*$/);
}

describe("review.yml", () => {
	it("reviews every pull request, with no branches filter (DP15, DP14)", () => {
		expect(review).toMatch(/^name:\s*review\s*$/m);
		const on = requireBlock(review, /^on:\s*$/);
		expect(childKeys(on)).toEqual(["pull_request"]);
		expect(requireBlock(review, /^\s*pull_request:\s*$/).body).toEqual([]);
		expect(linesMatching(review, /^\s*branches\s*:/)).toEqual([]);
	});

	it("grants Cite exactly the permissions it needs", () => {
		const permissions = requireBlock(review, /^permissions:\s*$/);
		expect(childEntries(permissions)).toEqual([
			{ key: "contents", value: "read" },
			{ key: "pull-requests", value: "write" },
			{ key: "checks", value: "write" },
		]);
	});

	it("pins Cite to a full commit sha with a readable version comment", () => {
		expect(review).toMatch(/Review this pull request with Cite/);
		const usesLines = linesMatching(review, /^\s*uses:\s*elecnix\/cite@/);
		expect(usesLines).toHaveLength(1);
		const line = usesLines[0] ?? "";
		const sha = /elecnix\/cite@([0-9a-f]+)/.exec(line)?.[1] ?? "";
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(line).toMatch(/#\s*v\d+\.\d+\.\d+\s*$/);
		// Never a tag: a moved tag would change code running with write permissions.
		expect(line).not.toMatch(/elecnix\/cite@v/);
	});

	it("reads the model API key from repository secrets", () => {
		const key = childValue(requireBlock(review, /^\s{8}with:\s*$/), "model_api_key") ?? "";
		expect(key).toContain("secrets.MODEL_API_KEY");
		expect(key).toContain("secrets.OLLAMA_API_KEY");
		expect(key).toContain("vars.CITE_PROVIDER == 'openrouter'");
	});

	it("keeps exactly the five documented with inputs", () => {
		const withBlock = requireBlock(review, /^\s{8}with:\s*$/);
		expect(childKeys(withBlock).sort()).toEqual([
			"model_api_key",
			"model_base_url",
			"model_id",
			"require_parameters",
			"structured_output",
		]);
	});

	it("cancels superseded reviews for the same pull request", () => {
		const concurrency = requireBlock(review, /^concurrency:\s*$/);
		expect(childValue(concurrency, "group")).toBe(
			"cite-pr-${{ github.event.pull_request.number }}",
		);
		expect(childValue(concurrency, "cancel-in-progress")).toBe("true");
	});
});

describe("vale.yml", () => {
	it("lints every pull request, with no branches filter (DP14, DP15)", () => {
		expect(valeWorkflow).toMatch(/^name:\s*vale\s*$/m);
		const on = requireBlock(valeWorkflow, /^on:\s*$/);
		expect(childKeys(on)).toEqual(["pull_request"]);
		expect(requireBlock(valeWorkflow, /^\s*pull_request:\s*$/).body).toEqual([]);
		expect(linesMatching(valeWorkflow, /^\s*branches\s*:/)).toEqual([]);
	});

	it("grants read-only contents and pull-request annotations", () => {
		const permissions = requireBlock(valeWorkflow, /^permissions:\s*$/);
		expect(childEntries(permissions)).toEqual([
			{ key: "contents", value: "read" },
			{ key: "pull-requests", value: "write" },
		]);
	});

	it("runs a single job on ubuntu-latest", () => {
		expect(childKeys(requireBlock(valeWorkflow, /^jobs:\s*$/))).toEqual(["vale"]);
		expect(childValue(requireBlock(valeWorkflow, /^\s{2}vale:\s*$/), "runs-on")).toBe(
			"ubuntu-latest",
		);
	});

	it("pins vale-action to a full commit sha with a readable version comment", () => {
		const usesLines = linesMatching(valeWorkflow, /^\s*(?:-\s*)?uses:\s*vale-cli\/vale-action@/);
		expect(usesLines).toHaveLength(1);
		const line = usesLines[0] ?? "";
		const sha = /vale-cli\/vale-action@([0-9a-f]+)/.exec(line)?.[1] ?? "";
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(line).toMatch(/#\s*v\d+\s*$/);
		// Never a tag: a moved tag would change code that runs on every pull request.
		expect(line).not.toMatch(/vale-cli\/vale-action@v/);
	});

	it("pins the validated vale version and fails on error", () => {
		const withBlock = stepWithBlock(valeWorkflow, "vale-cli/vale-action");
		expect(childValue(withBlock, "version")).toBe("3.20.0");
		// A misspelling in documentation is a defect, so it blocks like a failing test (DP15).
		expect(childValue(withBlock, "fail_on_error")).toBe("'true'");
		expect(childValue(withBlock, "reporter")).toBe("github-pr-annotations");
		expect(childValue(withBlock, "files")).toBe("all");
	});
});

describe("dupdelta.yml", () => {
	it("reports every pull request, with no branches filter (DP14)", () => {
		expect(dupdelta).toMatch(/^name:\s*dupdelta\s*$/m);
		const on = requireBlock(dupdelta, /^on:\s*$/);
		expect(childKeys(on)).toEqual(["pull_request"]);
		expect(requireBlock(dupdelta, /^\s*pull_request:\s*$/).body).toEqual([]);
		expect(linesMatching(dupdelta, /^\s*branches\s*:/)).toEqual([]);
	});

	it("grants contents: read and pull-requests: write for its annotations", () => {
		const permissions = requireBlock(dupdelta, /^permissions:\s*$/);
		expect(childEntries(permissions)).toEqual([
			{ key: "contents", value: "read" },
			{ key: "pull-requests", value: "write" },
		]);
	});

	it("pins the detector to a full commit sha with a readable version comment", () => {
		const usesLines = linesMatching(dupdelta, /^\s*(?:-\s*)?uses:\s*elecnix\/dupdelta@/);
		expect(usesLines).toHaveLength(1);
		const line = usesLines[0] ?? "";
		const sha = /elecnix\/dupdelta@([0-9a-f]+)/.exec(line)?.[1] ?? "";
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(line).toMatch(/#\s*v\d+\.\d+\.\d+\s*$/);
		// Never a tag: a moved tag would change the code that annotates every pull request.
		expect(line).not.toMatch(/elecnix\/dupdelta@v/);
	});

	it("pins checkout and fetches enough history to reach the merge-base", () => {
		const usesLines = linesMatching(dupdelta, /^\s*(?:-\s*)?uses:\s*actions\/checkout@/);
		expect(usesLines).toHaveLength(1);
		const line = usesLines[0] ?? "";
		expect(/actions\/checkout@([0-9a-f]+)/.exec(line)?.[1] ?? "").toMatch(/^[0-9a-f]{40}$/);
		expect(line).toMatch(/#\s*v\d+\s*$/);
		const withBlock = stepWithBlock(dupdelta, "actions/checkout@");
		// The merge-base is what the action scans as "before"; a shallow clone has none.
		expect(childValue(withBlock, "fetch-depth")).toBe("0");
		expect(childValue(withBlock, "persist-credentials")).toBe("false");
	});

	it("runs a single job on ubuntu-latest", () => {
		expect(childKeys(requireBlock(dupdelta, /^jobs:\s*$/))).toEqual(["dupdelta"]);
		expect(childValue(requireBlock(dupdelta, /^\s{2}dupdelta:\s*$/), "runs-on")).toBe(
			"ubuntu-latest",
		);
	});

	it("installs and builds nothing: the action ships its own binary", () => {
		// No step runs a command at all, so there is no npm, cargo or build step to go stale.
		expect(linesMatching(dupdelta, /^\s*(?:-\s*)?run:\s*/)).toEqual([]);
		const instructions = dupdelta
			.split(/\r?\n/)
			.filter((line) => !line.trim().startsWith("#"));
		expect(instructions.join("\n")).not.toMatch(/\b(?:npm|cargo|make|build)\b/);
	});

	it("cancels superseded scans for the same pull request", () => {
		const concurrency = requireBlock(dupdelta, /^concurrency:\s*$/);
		expect(childValue(concurrency, "group")).toBe(
			"dupdelta-pr-${{ github.event.pull_request.number }}",
		);
		expect(childValue(concurrency, "cancel-in-progress")).toBe("true");
	});
});

/**
 * Every workflow this suite makes claims about. The inventory test below compares it with the
 * directory, so a workflow added without extending these assertions fails instead of going
 * unchecked — the same failure mode as a `branches:` filter, one level up.
 */
const WORKFLOW_FILES = [
	["ci.yml", ci],
	["review.yml", review],
	["vale.yml", valeWorkflow],
	["dupdelta.yml", dupdelta],
] as const;

describe("workflow inventory", () => {
	it("checks every workflow file, including vale.yml and dupdelta.yml", () => {
		const names = WORKFLOW_FILES.map(([name]) => name);
		expect(names).toContain("vale.yml");
		expect(names).toContain("dupdelta.yml");
		const onDisk = readdirSync(
			fileURLToPath(new URL("../../.github/workflows/", import.meta.url)),
		)
			.filter((entry) => entry.endsWith(".yml"))
			.sort();
		expect([...names].sort()).toEqual(onDisk);
	});
});

describe("runner choice", () => {
	it("never asks for a self-hosted runner label", () => {
		for (const [name, text] of WORKFLOW_FILES) {
			const runners = linesMatching(text, /^\s*runs-on:/);
			expect(runners.length, `${name} declares no runner`).toBeGreaterThan(0);
			for (const line of runners) {
				expect(line.replace(/^\s*runs-on:\s*/, "").trim(), name).toBe("ubuntu-latest");
			}
		}
	});

	it("records why an arc-runners label is not used", () => {
		expect(linesMatching(ci, /^\s*#/).join("\n")).toMatch(/arc-runners/);
	});
});

describe("dependabot.yml", () => {
	it("updates npm and github-actions", () => {
		expect(dependabot).toMatch(/^version:\s*2\s*$/m);
		const ecosystems = linesMatching(dependabot, /^\s*-\s*package-ecosystem:/).map((line) =>
			line.replace(/^\s*-\s*package-ecosystem:\s*/, "").trim(),
		);
		expect(ecosystems.sort()).toEqual(["github-actions", "npm"]);
	});

	it("checks both ecosystems weekly", () => {
		for (const ecosystem of ["github-actions", "npm"] as const) {
			const block = requireBlock(
				dependabot,
				new RegExp(`^\\s*-\\s*package-ecosystem:\\s*${ecosystem}\\s*$`),
			);
			expect(childValue(block, "directory")).toBe('"/"');
			expect(block.body.join("\n"), ecosystem).toMatch(/^\s*interval:\s*weekly\s*$/m);
		}
	});

	it("groups updates and caps open pull requests at five", () => {
		for (const ecosystem of ["github-actions", "npm"] as const) {
			const block = requireBlock(
				dependabot,
				new RegExp(`^\\s*-\\s*package-ecosystem:\\s*${ecosystem}\\s*$`),
			);
			expect(childValue(block, "open-pull-requests-limit"), ecosystem).toBe("5");
			const groups = requireBlock(block.body.join("\n"), /^\s*groups:\s*$/);
			expect(childKeys(groups).length, ecosystem).toBeGreaterThan(0);
			expect(groups.body.join("\n"), ecosystem).toMatch(/^\s*patterns:\s*$/m);
			expect(groups.body.join("\n"), ecosystem).toMatch(/"\*"/);
		}
	});
});
