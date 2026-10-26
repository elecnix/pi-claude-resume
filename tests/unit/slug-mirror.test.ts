/**
 * The harness's project slug must equal the extension's (DP5, DP13).
 *
 * `tests/integration/helpers.ts` builds the Claude store the end-to-end suite reads, so its idea
 * of a project directory name has to match `claudeProjectSlug()` exactly. A harness that folds a
 * different set of characters writes fixtures somewhere the extension never looks, and the resume
 * suite then fails for a harness reason rather than a product one — which is what happened when
 * dots were folded in one place and not the other.
 *
 * Every path here is synthetic (DP12): invented directories, no real machine layout.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeProjectSlug } from "../../src/claude/locate.ts";
import { projectSlugFor } from "../integration/helpers.ts";

/** Paths whose slug rules could plausibly disagree between the two implementations. */
const MATRIX: readonly { readonly label: string; readonly cwd: string }[] = [
	{ label: "absolute", cwd: "/srv/synthetic/app" },
	{ label: "relative", cwd: "synthetic/app" },
	{ label: "single segment", cwd: "app" },
	{ label: "trailing slash", cwd: "/srv/synthetic/app/" },
	{ label: "several trailing slashes", cwd: "/srv/synthetic/app///" },
	{ label: "dot inside a segment", cwd: "/srv/my.app" },
	{ label: "several dots and a version", cwd: "/srv/my.app/v1.2.3" },
	{ label: "leading dot", cwd: "/srv/.config/app" },
	{ label: "trailing dot", cwd: "/srv/synthetic/app." },
	{ label: "spaces", cwd: "/srv/my synthetic app" },
	{ label: "colon", cwd: "/srv/a:b/app" },
	{ label: "windows style", cwd: "C:\\synthetic\\app" },
	{ label: "backslash separators", cwd: "synthetic\\app" },
	{ label: "unicode", cwd: "/srv/naïve-プロジェクト/应用" },
	{ label: "mixed dots and separators", cwd: "/srv/a.b/c d/e" },
	{ label: "root", cwd: "/" },
	{ label: "empty", cwd: "" },
	{ label: "surrounding whitespace", cwd: "  /srv/synthetic/app  " },
];

describe("the harness slug mirrors claudeProjectSlug", () => {
	it.each(MATRIX)("agrees for a $label path", ({ cwd }) => {
		// The harness resolves first: it always places an absolute directory, while the extension
		// receives pi's absolute cwd.
		expect(projectSlugFor(cwd)).toBe(claudeProjectSlug(path.resolve(cwd)));
	});

	it("folds dots, which the harness used to leave alone", () => {
		// Before the fix a dotted project directory built fixtures under `-srv-my.app`, a slug the
		// extension never derives; the dot is a separator in Claude Code's own naming.
		expect(projectSlugFor("/srv/my.app")).toBe("-srv-my-app");
		expect(projectSlugFor("/srv/my.app")).toBe(claudeProjectSlug("/srv/my.app"));
	});

	it("keeps a colon, which the harness used to fold", () => {
		expect(projectSlugFor("/srv/a:b")).toBe("-srv-a:b");
		expect(projectSlugFor("/srv/a:b")).toBe(claudeProjectSlug("/srv/a:b"));
	});

	it("keeps the slug pi-claude-resume's own fixtures are laid out under", () => {
		// The committed fixture directory name, and the one the harness test asserts.
		expect(projectSlugFor("/tmp/project")).toBe("-tmp-project");
	});
});
