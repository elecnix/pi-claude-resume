# pi-claude-resume

A [pi](https://pi.dev) coding-agent extension that adds `--claude <session-id>`.
It continues a Claude Code conversation inside pi, under pi's own system prompt and pi's own
tools: the old conversation is read from Claude Code's local session store, rendered as a
transcript, and injected into the pi session before your first message. Claude Code keeps
working normally in the same project — the extension only ever reads its files.

## Install

```sh
pi install git:github.com/elecnix/pi-claude-resume
```

For local development, load the extension straight from a checkout (no install step, no build):

```sh
pi -e ./src/index.ts
```

## Usage

### Find the session id

Claude Code stores one JSONL file per session under a per-project directory:

```sh
ls ~/.claude/projects/<slug>/
```

The project slug is the working directory with its path separators (and dots) replaced by `-`
(`/home/you/code/app` becomes `-home-you-code-app`). The session id is the file name without
the `.jsonl` extension.

- If `CLAUDE_CONFIG_DIR` is set, the store is read from `$CLAUDE_CONFIG_DIR/projects` instead of
  `~/.claude/projects` — the same variable Claude Code honours to relocate its config directory.

### Pass it to pi

`--claude` accepts exactly three forms, and nothing else:

| Form | Example | Meaning |
| --- | --- | --- |
| Session id | `--claude <session-id>` | That exact session, no prefix matching |
| Path | `--claude /abs/path/<session-id>.jsonl` | That exact file |
| `latest` | `--claude latest` | The newest session for the current directory (widened to the whole store only when that directory has no sessions) |

A partial, truncated or otherwise unknown id fails with the candidates that were found instead
of silently resuming the "most recent" session (DP5, DR1).

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--claude <id\|path\|latest>` | — | Session to import |
| `--claude-max-chars <n>` | `120000` | Total character budget for the injected transcript (DP9) |
| `--claude-force` | off | Re-import even if this pi session already imported that Claude session (DP10) |

### Non-interactive use

```sh
pi -p --claude <session-id> "continue where we left off"
```

In `-p` mode a failure to locate, parse or render the session is written to stderr and the
process exits non-zero; nothing is half-injected (DP11).

## What gets imported

| Source material | Result |
| --- | --- |
| User and assistant text | Imported as transcript text |
| Tool calls | Imported, with pi tool names and pi-shaped arguments (DP7) |
| Tool results | Imported, paired with their call, per-result capped |
| Claude Code compaction summaries | Imported and marked as a summary; they are context, not an assistant turn |
| Thinking blocks and their signatures | Dropped |
| Sidechain entries (sub-agent traffic) | Dropped |
| Meta and system-reminder injections | Dropped |
| API-error placeholders | Dropped |
| Bookkeeping entries (mode, permission-mode, file-history snapshots, api-request records) | Dropped |

Claude-only tools that pi does not have are not dressed up to look native: the call is rendered
as a declared, visibly lossy placeholder that names the original tool (DP7).

## How it works

- **Locate** (`src/claude/locate.ts`) — resolve the `--claude` spec to one readable file inside
  `~/.claude/projects/`, or fail with a reason and candidates.
- **Parse** (`src/claude/parse.ts`) — read the JSONL line by line into a normalized,
  tool-agnostic transcript, counting what was skipped and why.
- **Render** (`src/claude/render.ts`) — write that transcript as bounded text, mapping Claude
  tool calls to pi tool calls and truncating under budget (DP6, DP7, DP9).
- **Inject** (`src/bridge/inject.ts`) — send the rendered transcript as a custom message, then
  the boundary notice, then hand control back to you (DP8, DP10).

The history is injected as a rendered transcript plus a boundary notice, **not** as native pi
session entries. pi's extension API exposes custom messages and custom entries but not arbitrary
native history insertion, so the imported turns are text the model can read and continue from —
not replayable tool-call blocks (DR3). Everything about the format is bounded by that choice, and
the design principles say so out loud rather than implying more (DP6, DP7, DP8).

The boundary notice is the last injected message. It states that the transcript above came from
Claude Code, that pi's system prompt and pi's tool list are the ones now in force, and that the
next message is yours; it also lists the tools pi actually has active in this session, read at
runtime (DP8, DR2).

## Limits

- The injected transcript is bounded: 120 000 characters by default, keeping the head (the
  original task) and the tail (the most recent state). The middle is replaced with an omission
  marker stating how much was dropped, and the result reports the truncation. Individual tool
  results (2 000 characters) and tool inputs (1 000 characters) are capped on top of that (DP9).
- Tool mapping is lossy for anything Claude Code has and pi does not. A placeholder is honest
  about the loss; it is not a faithful reproduction (DP7).
- Imported turns are transcript text, so pi cannot replay them as tool-call blocks (DR3).
- One import per pi session per Claude session id. Reusing the same `--claude` value in a pi
  session that already imported it is a no-op, which keeps `pi --continue` and `pi --resume`
  working; `--claude-force` re-imports anyway (DP10).
- Images are not replayed: an attachment without a resolvable local source is not reconstructed
  (DP6).

## Privacy

- Read-only on `~/.claude`. The extension opens one session file for reading and writes nothing
  back; it never moves, truncates or "repairs" Claude Code's store (DP4).
- No network calls. Nothing leaves the machine, and nothing about your sessions is collected
  (DP12).
- Test fixtures in this repository are hand-written and synthetic. They describe the format and
  contain no paths, prompts or code from any real machine (DP12).

## Development

```sh
npm install
npm run typecheck        # tsc --noEmit
npm test                 # unit tests, no model or credentials needed
npx vitest run tests/unit/<file>.test.ts   # one file
```

The end-to-end suite resumes a synthetic fixture through a real `pi -p --claude …` run. It needs
a configured model and is skipped, loudly, when none is available:

```sh
PI_CLAUDE_IT=1 npm run test:integration
```

[DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) is the review gate: every change is checked against
DP1–DP15 before merge, and a change that violates a principle is either reworked or amends that
file in the same commit. See [AGENTS.md](AGENTS.md) for agent-facing instructions.

## CI

- Unit tests and `tsc --noEmit` run on every pull request, against any base branch, so stacked
  PRs are checked exactly like ones against `main`; `main` is also checked on push (DP14).
- Vale lints the prose of every Markdown file on every pull request, with the configuration in
  `.vale.ini`; a misspelling fails the check (DP15).
- Every pull request is reviewed by the Cite reviewer, and its findings are addressed before
  merge the same way a failing test is (DP15).

## License

MIT. See [LICENSE](LICENSE).
