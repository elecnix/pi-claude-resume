/**
 * Shared contracts for pi-claude-resume.
 *
 * Everything here is plain data and pure types: no imports from pi, no I/O, no side effects.
 * Modules across `src/claude`, `src/shared` and `src/bridge` are written against these shapes so
 * they can be tested without a model, a terminal, or a Claude installation (DP3).
 */

/** Custom message type carrying the rendered Claude Code transcript. */
export const TRANSCRIPT_CUSTOM_TYPE = "claude-resume.transcript";
/** Custom message type carrying the boundary notice that follows the transcript (DP8). */
export const BOUNDARY_CUSTOM_TYPE = "claude-resume.boundary";

/** `--claude <id|path|latest>` */
export const FLAG_CLAUDE = "claude";
/** `--claude-max-chars <n>` — overrides DP9's default budget. */
export const FLAG_CLAUDE_MAX_CHARS = "claude-max-chars";
/** `--claude-force` — re-inject even if this pi session already imported the id (DP10). */
export const FLAG_CLAUDE_FORCE = "claude-force";

/** Default total transcript budget, in characters (DP9). */
export const DEFAULT_MAX_TRANSCRIPT_CHARS = 120_000;
/** Default per-tool-result budget, in characters. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2_000;
/** Default per-tool-call-input budget, in characters. */
export const DEFAULT_MAX_TOOL_INPUT_CHARS = 1_000;

// ---------------------------------------------------------------------------
// Raw Claude Code session format (only the fields the bridge reads)
// ---------------------------------------------------------------------------

/** One JSONL line of `~/.claude/projects/<slug>/<uuid>.jsonl`. */
export interface ClaudeRawEntry {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	sessionId?: string;
	timestamp?: string;
	cwd?: string;
	gitBranch?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isApiErrorMessage?: boolean;
	subtype?: string;
	summary?: string;
	leafUuid?: string;
	aiTitle?: string;
	message?: ClaudeRawMessage;
	[key: string]: unknown;
}

export interface ClaudeRawMessage {
	role?: string;
	id?: string;
	model?: string;
	content?: string | ClaudeRawBlock[];
	stop_reason?: string | null;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export type ClaudeRawBlock =
	| { type: "text"; text?: string }
	| { type: "thinking"; thinking?: string; signature?: string }
	| { type: "redacted_thinking"; data?: string }
	| { type: "tool_use"; id?: string; name?: string; input?: unknown }
	| { type: "tool_result"; tool_use_id?: string; content?: unknown; is_error?: boolean }
	| { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Normalized conversation (tool-agnostic; pi tool names are attached later, DP7)
// ---------------------------------------------------------------------------

export interface ClaudeToolCall {
	/** Claude's tool_use id, preserved so results can be paired. */
	id: string;
	/** Tool name exactly as Claude Code recorded it, e.g. `Bash`. */
	claudeName: string;
	/** Raw arguments as Claude Code recorded them. */
	input: unknown;
}

export type ClaudeTurn =
	| { kind: "user"; text: string; timestamp?: string }
	/** Claude's own compaction summary, presented as context rather than as an assistant turn. */
	| { kind: "summary"; text: string; timestamp?: string }
	| {
			kind: "assistant";
			text: string;
			tools: ClaudeToolCall[];
			model?: string;
			timestamp?: string;
	  }
	| {
			kind: "tool_result";
			toolUseId: string;
			text: string;
			isError: boolean;
			timestamp?: string;
	  };

export interface ClaudeSessionMeta {
	/** Session id (the file name without `.jsonl`). */
	sessionId: string;
	/** Absolute path of the source file. Never copied into fixtures or docs (DP12). */
	path: string;
	cwd?: string;
	gitBranch?: string;
	/** Claude's own generated title, when the session carries one. */
	title?: string;
	firstTimestamp?: string;
	lastTimestamp?: string;
	models?: string[];
}

export interface ParseStats {
	rawLines: number;
	parsedEntries: number;
	malformedLines: number;
	skippedEntries: number;
	droppedSidechains: number;
	droppedMeta: number;
	droppedApiErrors: number;
}

export interface ClaudeTranscript {
	meta: ClaudeSessionMeta;
	turns: ClaudeTurn[];
	stats: ParseStats;
}

// ---------------------------------------------------------------------------
// Locating the source file (DP5)
// ---------------------------------------------------------------------------

export type LocateErrorCode = "invalid-spec" | "not-found" | "ambiguous" | "unreadable";

export interface LocateOptions {
	/** The raw `--claude` value: an id, an absolute path, or `latest`. */
	spec: string;
	/** Current working directory, used for the project-slug fast path and for `latest`. */
	cwd: string;
	/** Overrides `$HOME`; tests pass a temp directory. */
	homeDir?: string;
	/** Overrides `<homeDir>/.claude/projects`; tests pass a temp directory. */
	projectsRoot?: string;
}

export type LocateResult =
	| {
			ok: true;
			path: string;
			sessionId: string;
			/** Project directory the session was found in. */
			projectDir: string;
			source: "id" | "path" | "latest";
	  }
	| {
			ok: false;
			code: LocateErrorCode;
			message: string;
			/** Files that were plausible matches, for ambiguous specs. */
			candidates?: string[];
	  };

// ---------------------------------------------------------------------------
// Tool mapping (DP7, DR4)
// ---------------------------------------------------------------------------

export interface ToolMapping {
	/** pi tool name, or a declared placeholder name for an unmappable call. */
	piName: string;
	/** Arguments in pi's shape, best effort. */
	input: Record<string, unknown>;
	/** Human-readable notes about anything that could not be represented faithfully. */
	notes: string[];
}

/** Injected so the renderer can be tested without the real mapping table. */
export type ToolMapper = (claudeName: string, input: unknown) => ToolMapping;

// ---------------------------------------------------------------------------
// Rendering (DP9)
// ---------------------------------------------------------------------------

export interface RenderOptions {
	maxChars?: number;
	maxToolResultChars?: number;
	maxToolInputChars?: number;
	mapTool?: ToolMapper;
}

export interface RenderResult {
	/** The transcript block injected into the session. */
	text: string;
	chars: number;
	/** Approximate token count (`chars / 4`), for reporting only. */
	estimatedTokens: number;
	truncated: boolean;
	/** Number of turns removed entirely from the middle by the budget. */
	droppedTurns: number;
	/** Characters dropped from the middle, for the omission marker. */
	droppedChars: number;
}

// ---------------------------------------------------------------------------
// Boundary notice (DP8, DR2)
// ---------------------------------------------------------------------------

export interface BoundaryInput {
	meta: ClaudeSessionMeta;
	/** pi tool names active in this session, read at runtime. */
	piTools: readonly string[];
	/** Claude tool names that appear in the imported history, mapped or not. */
	claudeTools: readonly string[];
	rendered: RenderResult;
}

// ---------------------------------------------------------------------------
// Bridge orchestration
// ---------------------------------------------------------------------------

/** What the host (pi, or a fake in tests) can do for the bridge. */
export interface BridgeHost {
	/** Current working directory of the pi session. */
	cwd: string;
	homeDir?: string;
	projectsRoot?: string;
	/** pi tool names active in this session, for the boundary notice. */
	piTools: readonly string[];
	/** True when this pi session already imported `sessionId` (DP10). */
	hasInjected(sessionId: string): boolean;
	sendCustomMessage(message: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	}): void | Promise<void>;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface BridgeOptions {
	/** The raw `--claude` value. */
	spec: string;
	maxChars?: number;
	/** Bypass the idempotency check (DP10). */
	force?: boolean;
}

export interface BridgeResult {
	ok: boolean;
	sessionId?: string;
	sessionPath?: string;
	sourceCwd?: string;
	title?: string;
	messagesSent: number;
	turns?: number;
	chars?: number;
	estimatedTokens?: number;
	truncated?: boolean;
	error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export interface ClaudeFlagValues {
	spec?: string;
	maxChars?: number;
	force?: boolean;
}
