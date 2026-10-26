# Design Principles

**This file is the review gate. Every change to this repository — code, tests, docs, CI —
must be checked against it, and a change that violates a principle must either be reworked or
amend this file in the same commit (with the reason written down). A reviewer who cannot map a
diff to these principles and their decision records should reject it.**

The principles are numbered (`DP1`, `DP2`, …) so commits, reviews and issues can cite them
(`DP7`). Decision records (`DR1`, `DR2`, …) explain *why* a non-obvious choice was made, so a
future contributor does not silently undo it.

## DP1 — One job: resume a Claude Code session inside pi

The extension exists to answer one question: *given a Claude Code session id, continue that
conversation in pi under pi's own system prompt and tools.* It is not a general session
converter, not a sync daemon, not a bidirectional bridge, and not a session browser. Features
that do not serve `--claude <session-id>` belong in another package.

## DP2 — Pi-native and compilation-free

The extension is plain TypeScript loaded by pi's own loader (`jiti`). No build step, no bundle,
no transpiled artifact checked in, no runtime dependency that pi does not already supply. A user
installs it with `pi install git:github.com/elecnix/pi-claude-resume` and it runs.

## DP3 — The conversion core is pure, injectable and pi-free

`src/claude/*` and `src/shared/*` may not import `@earendil-works/*` and may not touch the network,
`~/.claude`, or the pi runtime directly. They take plain data in and return plain data out, with
every effect (filesystem, clock, notification) passed in by the caller. This is what makes a
"shitload of unit tests" possible without a model, a terminal, or a Claude installation.

`src/index.ts` is the only module allowed to know about the pi extension API, and it does nothing
except register the flag, hand pi's runtime to `src/bridge/inject.ts`, and report outcomes.

## DP4 — Read-only with respect to Claude Code

Claude Code's session store is read, never written, moved, truncated or "repaired". The bridge
opens one file (`~/.claude/projects/<slug>/<uuid>.jsonl`) read-only and never writes anywhere
except pi's own session through pi's own API. A Claude user must be able to keep using Claude
Code against the same store while the bridge is installed.

## DP5 — Never guess which session was meant

`--claude <spec>` resolves an exact session id, an exact path, or the literal `latest` for the
current working directory. Anything else fails loudly with the candidates it found. Silently
picking "the most recent session" for a partial or malformed id would resume the wrong
conversation, which is worse than resuming none. (See DR1.)

## DP6 — Fidelity over decoration

The reconstructed history preserves what the model needs to continue: user messages, assistant
text, tool calls with their pi-side tool names and arguments, and tool results. It strips what is
worthless or harmful across a provider change: thinking blocks and their Anthropic signatures,
image blobs without a resolvable source, sidechain entries, API-error placeholders, bookkeeping
entries (mode, permission-mode, file-history-snapshot, api-request-*) and meta injections.
Nothing is invented — a fact that is not in the source session does not appear in the output.

## DP7 — Tool identity is translated, and translation is declared

A resumed transcript must not claim the model called a tool that does not exist in pi. Claude
tool names and argument shapes are mapped to pi's (`Bash` → `bash`, `Read` → `read`,
`Edit` → `edit` with pi's `edits[]` array, `Grep`/`Glob` → `bash` with a real command, …).
Where a faithful mapping is impossible the call is rendered as a declared, lossy placeholder
that says so — never as a silently plausible call. The mapping table is data, tested one row at
a time. Command text the mapping generates (`Grep` → a quoted `rg` line) is inert data recorded in
the transcript for the model to read; the extension never executes it, and a placeholder carries
a no-op command that names the original tool.

## DP8 — Every resumed session says where it is

The last injected message is the boundary notice: the conversation moved from Claude Code to pi,
the transcript above came from Claude Code, pi's system prompt and pi's tool list are the ones now
in force, and the next message is the user's. It lists the tools pi actually has active in this
session, read at runtime — not a hardcoded list that drifts. (See DR2.)

## DP9 — Bounded injection

A Claude session can be arbitrarily large; a model context is not. The injected transcript is
capped (default 120 000 characters), keeping the head (the original task) and the tail (the most
recent state) and replacing the middle with an explicit omission marker that states how much was
dropped. Per-tool-result and per-tool-input caps apply on top. Truncation is reported in the
result and visible in the transcript, never silent.

## DP10 — Idempotent and resumable

Re-running pi with the same `--claude` id against a pi session that already carries the imported
transcript must not duplicate history. Injection is keyed by Claude session id and recorded in
the pi session itself, so pi's own `--continue`/`--resume` keeps working without re-importing.
`--claude-force` is the documented escape hatch.

## DP11 — Fail visibly, never half-resume

A session that cannot be located, parsed, or rendered leaves the pi session untouched apart from
one error notification. The bridge never injects a partial transcript and never starts a turn
with an apology in place of context. In non-interactive mode (`pi -p`) the failure is written to
stderr and the process exits non-zero.

## DP12 — No user data leaves the machine, and none enters this repository

The bridge makes no network calls. Test fixtures are synthetic: hand-written entries that
resemble the format and contain nothing from a real session — no paths, no prompts, no code from
the author's machine. PR bodies, issues, commit messages and docs describe the format, never a
real conversation. A diff containing a captured session is a reject, not a nit.

## DP13 — Tests are the specification

Every mapping row, every filtering decision, every error path and every truncation boundary has a
unit test that fails if the behaviour changes. Unit tests need no credentials and finish in
seconds. End-to-end `pi -p --claude …` tests exercise a real resume against a synthetic fixture and
skip, loudly, when no model is configured. A change without tests is unfinished.

## DP14 — CI gates every branch, because stacks are how work lands

CI runs on `pull_request` with no branch filter, so a stacked PR whose base is another feature
branch is checked exactly like one against `main`. Unit tests and the type-check are required
checks; `main` is also checked on push. Adding a `branches:` filter to `pull_request` silently
skips stacked PRs, so a test asserts the workflow stays unfiltered.

## DP15 — Reviewers are part of the toolchain

`elecnix/cite` reviews every pull request and its findings are addressed before merge, the same
way a failing test is. A review comment that contradicts these principles is answered with a
citation to the principle it disagrees with — or with an amendment to this file.

The prose is linted too: `vale --config=.vale.ini .` runs on every pull request, because a
misspelling or a doubled word in the documentation is a defect of the same kind as a failing test,
not a matter of taste.

## Decision records

### DR1 — Exact ids only, `latest` is explicit

Claude Code's own `--resume` takes a session id or opens a picker; it does not accept prefixes.
Mirroring that keeps behaviour predictable, and an explicit `latest` keyword covers the one case
where "the newest session for this directory" is genuinely what the user means. `latest` is scoped
to the project directory for the current working directory and widens to the whole store only when
that directory does not exist at all; an existing but empty directory is a `not-found`, not an
invitation to borrow another project's conversation. Prefix matching was rejected because two
sessions in the same project can differ by one character in the last few bytes of a UUID.

### DR2 — The boundary notice is a custom message, not a rewrite of the system prompt

Pi's system prompt is authoritative and is rebuilt per run by pi itself; an extension that
appended text to it would produce a session whose prompt no longer matches the tools pi
declares. A custom message at the tail of the imported history carries the same information where
the model will definitely read it, survives compaction ordering, and is visible in the transcript
when the user wants to audit what was injected.

### DR3 — History is injected as a rendered transcript, not as native pi session entries

Pi's extension API exposes custom messages (`pi.sendMessage`) and custom entries
(`pi.appendEntry`) but not arbitrary native history insertion: `SessionManager.appendMessage` is
not reachable from an extension context (`ReadonlySessionManager`), and `switchSession()` is
command-only by design, because calling it from `session_start` deadlocks the runtime. Writing a
pi session file on the side and re-pointing pi at it was rejected: it duplicates pi's session
format, breaks on version bumps, and bypasses pi's own persistence.

The consequence is accepted and made visible: the resumed history is text the model reads, not
tool-call blocks it can replay. `DESIGN_PRINCIPLES.md` DP6 bounds what that text may contain, DP7
makes the tool translation explicit, and DP8 tells the model what it is looking at.

### DR4 — The Claude tool-name mapping is data, not code paths

Mapping lives in two exported tables (`CLAUDE_TO_PI_TOOL`, `CLAUDE_ARG_KEY_MAP`) consumed by one
function. Claude Code adds tools faster than pi does; a new tool must be a one-line table entry
with a test, not a new branch in a converter, and an unmapped tool must degrade to a declared
placeholder rather than throw.
