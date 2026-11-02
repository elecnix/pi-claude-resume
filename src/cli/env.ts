/**
 * Environment adaptation for the Claude Code session store (DP3, DP4).
 *
 * Claude Code keeps one JSONL file per session under `<config dir>/projects/<slug>/`, where the
 * config dir defaults to `~/.claude` and can be relocated with `CLAUDE_CONFIG_DIR` — the same
 * variable Claude Code itself reads. Honouring it means a user who moved the store, or a test
 * harness that sandboxes it, is read where Claude Code actually wrote, instead of this package
 * inventing a second convention. The store is still only ever opened for reading (DP4).
 *
 * Only the adapter layer may read the environment (DP3): `src/claude/locate.ts` receives the
 * resolved root and the home directory as plain data, so it stays testable without touching
 * `process.env` and cannot pick up a variable nobody meant it to read.
 */
import { join } from "node:path";

/** The environment variable Claude Code reads to relocate its config directory. */
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
/** The environment variable that names the home directory on POSIX systems. */
export const HOME_ENV = "HOME";

/**
 * `$HOME`, or `undefined` when it is unset or blank.
 *
 * The one place the extension reads it: `locate()` takes the home directory as data, so an
 * unreadable environment cannot leak into the conversion core and a test never has to mutate the
 * real `process.env` to change where `~` points (DP3). `undefined` means "no opinion", and the
 * caller falls back to the operating system's own idea of the home directory.
 */
export function homeDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const home = env[HOME_ENV];
	if (typeof home !== "string") return undefined;
	const trimmed = home.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * `<CLAUDE_CONFIG_DIR>/projects`, or `undefined` when the variable is unset or blank.
 *
 * `undefined` means "no override", not an error: the caller then falls back to
 * `<home>/.claude/projects`, which is where Claude Code writes by default. Surrounding
 * whitespace is trimmed because a value pasted into a shell profile often carries it, and a
 * relative value is joined as given and left relative — Claude Code resolves such a value
 * against its working directory, and so does the caller of this function.
 */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env[CLAUDE_CONFIG_DIR_ENV];
	if (typeof configured !== "string") return undefined;
	const trimmed = configured.trim();
	if (trimmed === "") return undefined;
	return join(trimmed, "projects");
}
