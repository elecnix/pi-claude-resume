# Agent instructions

`pi-claude-resume` adds `--claude <session-id>` to the pi coding agent so a Claude Code
conversation can continue inside pi. This file is for any coding agent working in this
repository. `CLAUDE.md` is a symlink to it; edit this file, not the symlink.

## The review gate

[DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) is reviewed on every change — code, tests, docs, CI.
Before you write anything, read it. A reviewer who cannot map your diff to these principles and
their decision records should reject it, and a principle you violate must be either reworked or
amended in the same commit with the reason written down.

- **DP1** — One job: resume a Claude Code session inside pi. No general converter, no daemon, no
  session browser.
- **DP2** — Pi-native, compilation-free: plain TypeScript loaded by pi's own loader; no build
  step, no bundle, no new runtime dependency.
- **DP3** — The conversion core is pure and pi-free: `src/claude/*` and `src/shared/*` take plain
  data and return plain data, with every effect injected by the caller.
- **DP4** — Read-only with respect to Claude Code: one file opened for reading, never written,
  moved or repaired.
- **DP5** — Never guess which session was meant: an exact id, an exact path, or `latest`.
  Anything else fails loudly with candidates.
- **DP6** — Fidelity over decoration: keep user text, assistant text, tool calls and results;
  strip thinking, sidechains, API-error placeholders, bookkeeping entries and meta injections.
  Invent nothing.
- **DP7** — Tool identity is translated and the translation is declared: mapped names and
  argument shapes, or a visible lossy placeholder, never a plausible-looking lie.
- **DP8** — Every resumed session says where it is: a boundary notice at the tail names the
  source, states that pi's prompt and tools are now in force, and lists pi's runtime tools.
- **DP9** — Bounded injection: head and tail kept under a character budget, the middle replaced
  by an omission marker that states what was dropped. Truncation is reported, never silent.
- **DP10** — Idempotent and resumable: injection is keyed by Claude session id and recorded in
  the pi session; `--claude-force` is the escape hatch.
- **DP11** — Fail visibly, never half-resume: an error notification and no partial transcript;
  in `pi -p` failures go to stderr with a non-zero exit.
- **DP12** — No user data leaves the machine, none enters this repository. No network calls. No
  captured sessions in fixtures, tests, PR bodies, commit messages or docs.
- **DP13** — Tests are the specification: every mapping row, filter decision, error path and
  truncation boundary has a test that fails if the behaviour changes.
- **DP14** — CI gates every branch: `pull_request` with no branch filter, so stacked PRs are
  checked like any other.
- **DP15** — Reviewers are part of the toolchain: Cite findings are addressed before merge, or
  answered with a citation to the principle in dispute.

## Repository map

- `src/claude/locate.ts` — resolve a `--claude` spec to one readable session file or an error.
- `src/claude/parse.ts` — JSONL to a normalized, tool-agnostic transcript; tolerant, never throws.
- `src/claude/render.ts` — transcript to bounded text, with tool mapping and truncation.
- `src/claude/toolmap.ts` — the Claude-to-pi tool tables and the never-throwing mapper.
- `src/claude/boundary.ts` — the boundary notice injected after the transcript.
- `src/shared/truncate.ts` — character budgets and head/tail truncation helpers.
- `src/bridge/inject.ts` — orchestration: locate, parse, render, boundary, inject.
- `src/cli/flag.ts` — registration and parsing of `--claude`, `--claude-max-chars`,
  `--claude-force`.
- `src/index.ts` — the extension entry point and the only module allowed to import pi.
- `src/types.ts` — shared contracts. Read it before you change a signature; do not edit it
  casually: every module is written against it.
- `tests/unit/` — vitest specs, colocated by module, no model and no credentials.
- `tests/integration/` — end-to-end `pi -p --claude …` runs against a synthetic fixture.
- `.github/workflows/` — CI: unit tests plus typecheck on every PR (no base-branch filter) and
  on push to `main`.

Ownership rule: the pure conversion modules must not import pi (DP3). `src/index.ts` is the only
pi-aware module, and it only registers flags, calls the bridge and reports outcomes.

## Commands

```sh
npm install              # once; do not add dependencies
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (tests/unit)
npx vitest run tests/unit/render.test.ts        # one file
PI_CLAUDE_IT=1 npm run test:integration         # end-to-end, needs a model
```

Never run `npm install` to add a package. If a feature seems to need one, it belongs in another
package (DP1, DP2).

## Style

- Tabs, double quotes, strict TypeScript.
- ESM imports with an explicit `.ts` extension; `import type` for types.
- No new dependencies; tests use vitest and node built-ins only.
- No build artifacts, no transpiled output checked in.
- Tests live under `tests/unit/`, named after the module, with descriptive case names that read
  like the specification they enforce.

## Adding a Claude tool mapping

Mapping is data, not code paths (DP7, DR4). Add one row to `CLAUDE_TO_PI_TOOL` and, if argument
keys differ, one row to `CLAUDE_ARG_KEY_MAP`, then add the matching test row. Do not add a branch
to a converter. A tool with no pi equivalent must degrade to a declared placeholder that says so
— never throw, never impersonate a native call.

## Test policy

- Every behaviour change starts with a failing test (DP13).
- Fixtures are hand-written and synthetic: they may look like the format, but they contain no
  paths, prompts or code from a real machine (DP12). A captured session in a diff is a reject,
  not a nit — do not paste one into a test, a comment or a chat log either.
- Unit tests must pass without a model, a terminal or a Claude installation.
- Integration tests skip, loudly, when no model is configured.

## PR policy

- Conventional commit subjects; one commit per logical change.
- Open a draft PR first, get CI green, then mark it ready for review.
- Cite findings are addressed before merge, like a failing test (DP15).
- No real session data in a PR body, commit message, issue or fixture (DP12).
- Note in the PR body which DP numbers the change implements, and whether any principle needed
  amending.

## Before you push

1. `npm run typecheck` and `npm test` are green locally.
2. Each change in the diff maps to a DP; anything that does not is removed or the principle is
   amended in the same commit.
3. New behaviour has a test that would fail without it.
4. Every fixture is synthetic — no real paths, prompts or code (DP12).
5. No new dependency, no build step, no checked-in artifact (DP2).
6. No write to `~/.claude` and no network call anywhere in the diff (DP4, DP12).
7. Nothing guesses a session: exact id, exact path, or `latest` (DP5).
8. Truncation is reported and failures are loud, in both interactive and `-p` modes (DP9, DP11).
