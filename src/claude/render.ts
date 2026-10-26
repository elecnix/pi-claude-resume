/**
 * Render a normalized transcript into bounded text for injection (DP6, DP9).
 *
 * The result is plain text the model reads (DR3), so it follows three rules:
 *
 * - DP6: nothing is invented. A fact that is not in the normalized transcript does not appear,
 *   thinking blocks and bookkeeping entries never made it this far, and tool calls carry pi's
 *   names and arguments as translated by the mapper (DP7).
 * - DP9: every truncation is visible. Per-payload caps cut a single tool input or result and
 *   say how much they dropped; the whole-transcript budget drops whole middle turns and writes
 *   one marker stating how many turns and characters that cost.
 * - DP13: the output is deterministic. No clock, no randomness, no locale-dependent formatting:
 *   timestamps are copied verbatim from the source and `JSON.stringify` keeps argument order.
 */
import {
	DEFAULT_MAX_TOOL_INPUT_CHARS,
	DEFAULT_MAX_TOOL_RESULT_CHARS,
	DEFAULT_MAX_TRANSCRIPT_CHARS,
} from "../types.ts";
import type {
	ClaudeSessionMeta,
	ClaudeToolCall,
	ClaudeTranscript,
	ClaudeTurn,
	RenderOptions,
	RenderResult,
	ToolMapper,
} from "../types.ts";
import { normalizeBudget, truncateMiddle, truncatePayload } from "../shared/truncate.ts";
import { PI_CORE_TOOLS, mapToolCall } from "./toolmap.ts";

/** Blocks are separated by one blank line, so the injected text stays scannable. */
const BLOCK_SEPARATOR = "\n\n";
const UNKNOWN_TIMESTAMP = "unknown";
const NO_ASSISTANT_TEXT = "(no text)";
const UNKNOWN_TOOL_CALL = "unknown tool call";
const UNSUPPORTED_INPUT = '"[unserializable input]"';

interface RenderTurnContext {
	maxToolResultChars: number;
	maxToolInputChars: number;
	mapTool: ToolMapper;
	/** pi tool names active in this session; a mapped call outside this list is marked (DP7). */
	activeTools: readonly string[];
}

interface RenderedTurn {
	text: string;
	/** True when a per-payload cap changed this turn's text (DP9: reported, not silent). */
	payloadTruncated: boolean;
}

function hasText(value: string | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function timestampLabel(turn: { timestamp?: string }): string {
	return hasText(turn.timestamp) ? turn.timestamp : UNKNOWN_TIMESTAMP;
}

function renderHeader(meta: ClaudeSessionMeta): string {
	const lines = [`# Claude Code session ${meta.sessionId}`];
	if (hasText(meta.title)) lines.push(`- title: ${meta.title}`);
	if (hasText(meta.cwd)) lines.push(`- cwd: ${meta.cwd}`);
	if (hasText(meta.gitBranch)) lines.push(`- git branch: ${meta.gitBranch}`);
	const models = (meta.models ?? []).filter(hasText);
	if (models.length > 0) lines.push(`- model(s): ${models.join(", ")}`);
	if (hasText(meta.firstTimestamp)) lines.push(`- session started: ${meta.firstTimestamp}`);
	return lines.join("\n");
}

/** Serialize one tool input and apply its per-call cap; never throws (DP11). */
function renderToolInput(input: unknown, maxChars: number): { text: string; truncated: boolean } {
	let json: string;
	try {
		const serialized = JSON.stringify(input === undefined ? {} : input);
		json = serialized === undefined ? "{}" : serialized;
	} catch {
		// Circular or otherwise non-serializable input: declare it instead of blowing up.
		json = UNSUPPORTED_INPUT;
	}
	const text = truncatePayload(json, maxChars);
	return { text, truncated: text !== json };
}

function renderToolCalls(
	tools: readonly ClaudeToolCall[],
	ctx: RenderTurnContext,
): { lines: string[]; payloadTruncated: boolean } {
	const lines: string[] = [];
	let payloadTruncated = false;
	for (const tool of tools) {
		const mapping = ctx.mapTool(tool.claudeName, tool.input);
		const input = renderToolInput(mapping.input, ctx.maxToolInputChars);
		payloadTruncated ||= input.truncated;
		// One blank line before each call keeps a multi-call turn readable.
		lines.push("", `- tool ${mapping.piName}(${input.text})`);
		const notes = mapping.notes.filter((note) => typeof note === "string" && note.trim().length > 0);
		// DP7: a name pi knows but this session does not have must not read as a call the model can
		// repeat. `subagent` and `intercom` are the common cases: Claude Code had them, a bare pi
		// install does not, and the transcript has to say so rather than pretend they are native.
		if (!ctx.activeTools.includes(mapping.piName)) {
			const called = tool.claudeName === "" ? "tool" : tool.claudeName;
			notes.push(
				`${mapping.piName} is not an active tool in this pi session: this ${called} call happened in Claude Code and is not available here.`,
			);
		}
		if (notes.length > 0) lines.push(`  notes: ${notes.join("; ")}`);
	}
	return { lines, payloadTruncated };
}

function renderTurn(turn: ClaudeTurn, ctx: RenderTurnContext): RenderedTurn {
	switch (turn.kind) {
		case "user": {
			const lines = [`## User (${timestampLabel(turn)})`];
			if (hasText(turn.text)) lines.push(turn.text);
			return { text: lines.join("\n"), payloadTruncated: false };
		}
		case "assistant": {
			const body = hasText(turn.text) ? turn.text : NO_ASSISTANT_TEXT;
			const tools = renderToolCalls(turn.tools, ctx);
			const lines = [`## Assistant (${timestampLabel(turn)})`, body, ...tools.lines];
			return { text: lines.join("\n"), payloadTruncated: tools.payloadTruncated };
		}
		case "tool_result": {
			// The Claude tool_use id is the pairing key: it is what tells the reader which call
			// produced this result, and it survives the Claude -> pi tool-name translation.
			const target = hasText(turn.toolUseId) ? turn.toolUseId : UNKNOWN_TOOL_CALL;
			const status = turn.isError ? "error" : "ok";
			const body = truncatePayload(turn.text, ctx.maxToolResultChars);
			const lines = [`## Tool result (${timestampLabel(turn)})`, `- for ${target}: ${status}`];
			if (hasText(body)) lines.push(body);
			return { text: lines.join("\n"), payloadTruncated: body !== turn.text };
		}
		case "summary": {
			// Claude's own compaction summary: context, not an assistant utterance (DP6).
			const lines = [`## Summary (${timestampLabel(turn)})`];
			if (hasText(turn.text)) lines.push(turn.text);
			return { text: lines.join("\n"), payloadTruncated: false };
		}
	}
}

interface Assembled {
	text: string;
	droppedTurns: number;
	droppedChars: number;
}

/**
 * Join the header, `headCount` leading turns, the omission marker and `tailCount` trailing
 * turns. Turns are dropped as whole blocks and the marker reports their exact count and size.
 */
function assemble(
	header: string,
	blocks: readonly string[],
	headCount: number,
	tailCount: number,
): Assembled {
	const dropped = blocks.slice(headCount, blocks.length - tailCount);
	const droppedTurns = dropped.length;
	const droppedChars = dropped.reduce((sum, block) => sum + block.length, 0);
	const parts: string[] = [header, ...blocks.slice(0, headCount)];
	if (droppedTurns > 0) {
		parts.push(`[... ${droppedTurns} turns (${droppedChars} characters) omitted ...]`);
	}
	if (tailCount > 0) parts.push(...blocks.slice(blocks.length - tailCount));
	return { text: parts.join(BLOCK_SEPARATOR), droppedTurns, droppedChars };
}

function finalize(text: string, truncated: boolean, droppedTurns: number, droppedChars: number): RenderResult {
	const chars = text.length;
	return {
		text,
		chars,
		estimatedTokens: Math.ceil(chars / 4),
		truncated,
		droppedTurns,
		droppedChars,
	};
}

/**
 * Render the transcript. Deterministic: no clock, no randomness.
 *
 * Budget invariant (DP9): the result is at most `maxChars` characters, with one documented
 * exception. When even the smallest keep set — header, first turn, marker, last turn — busts the
 * budget, the hard cap truncates the middle of that text and the omission *marker* it inserts is
 * not charged to the budget, so the final text can be up to one marker longer than `maxChars`.
 * `droppedChars` stays exact in that case: it counts every character removed, by the whole-turn
 * drop and by the hard cap alike.
 */
export function renderTranscript(transcript: ClaudeTranscript, options: RenderOptions = {}): RenderResult {
	const maxChars = normalizeBudget(options.maxChars, DEFAULT_MAX_TRANSCRIPT_CHARS);
	const ctx: RenderTurnContext = {
		maxToolResultChars: normalizeBudget(options.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS),
		maxToolInputChars: normalizeBudget(options.maxToolInputChars, DEFAULT_MAX_TOOL_INPUT_CHARS),
		// The real mapping table lives in toolmap.ts; tests inject a fake so this file can be
		// specified without it (DP3, DR4).
		mapTool: options.mapTool ?? mapToolCall,
		// The runtime list when the caller has one, pi's own built-ins otherwise; the adapter
		// always has one (`pi.getActiveTools()`), so the fallback only serves direct callers.
		activeTools: options.piTools ?? PI_CORE_TOOLS,
	};

	const header = renderHeader(transcript.meta);
	const rendered = transcript.turns.map((turn) => renderTurn(turn, ctx));
	const blocks = rendered.map((turn) => turn.text);
	const payloadTruncated = rendered.some((turn) => turn.payloadTruncated);

	const full = [header, ...blocks].join(BLOCK_SEPARATOR);
	if (full.length <= maxChars) {
		return finalize(full, payloadTruncated, 0, 0);
	}

	// Whole-turn dropping (DP9): keep the first turn (the original task) and the last turn (the
	// most recent state), then grow inwards from both ends while the result still fits.
	const total = blocks.length;
	let headCount = total > 0 ? 1 : 0;
	let tailCount = total > 1 ? 1 : 0;
	let assembled = assemble(header, blocks, headCount, tailCount);
	if (total > 2) {
		let grew = true;
		while (grew) {
			grew = false;
			// Prefer recent context on a tie, then the opening context.
			if (headCount + tailCount < total) {
				const candidate = assemble(header, blocks, headCount, tailCount + 1);
				if (candidate.text.length <= maxChars) {
					tailCount += 1;
					assembled = candidate;
					grew = true;
				}
			}
			if (headCount + tailCount < total) {
				const candidate = assemble(header, blocks, headCount + 1, tailCount);
				if (candidate.text.length <= maxChars) {
					headCount += 1;
					assembled = candidate;
					grew = true;
				}
			}
		}
	}

	let text = assembled.text;
	let droppedChars = assembled.droppedChars;
	if (text.length > maxChars) {
		// Degenerate case: even one turn at each end busts the budget. Per-payload caps bound
		// tool traffic, but a single huge user message cannot be dropped without losing the
		// conversation, so the hard budget wins here and that cut stays visible too — and, like
		// every other cut, it is counted in what the result reports (DP9).
		const hardCap = truncateMiddle(text, maxChars);
		text = hardCap.text;
		droppedChars += hardCap.droppedChars;
	}
	return finalize(text, true, assembled.droppedTurns, droppedChars);
}
