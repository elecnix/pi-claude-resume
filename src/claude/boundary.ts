/**
 * The boundary notice injected after the imported history (DP8, DR2).
 *
 * The notice is prose the model reads, appended as a custom message at the tail of the import
 * rather than patched into pi's system prompt (DR2). It is built from plain data only — no clock,
 * no filesystem, no pi runtime (DP3) — so its wording is deterministic and unit tests can
 * assert it exactly (DP13). It never carries a date, a path from the importing machine beyond
 * what the caller supplied, or decoration (DP12).
 */
import type { BoundaryInput, ClaudeSessionMeta, RenderResult } from "../types.ts";

/** How many tool names one list may contain before it is capped. */
export const MAX_LISTED_TOOLS = 20;
/** How many characters a title, cwd or git branch may contribute. */
export const MAX_META_CHARS = 96;

const PARAGRAPH = "\n\n";

/** Collapse whitespace and cap a free-form metadata value, marking any cut explicitly. */
function clampMetaValue(value: string | undefined): string {
	if (value === undefined) {
		return "";
	}
	const text = value.trim().replace(/\s+/g, " ");
	if (text.length === 0) {
		return "";
	}
	if (text.length <= MAX_META_CHARS) {
		return text;
	}
	const marker = `... [${text.length} characters, truncated]`;
	const keep = Math.max(0, MAX_META_CHARS - marker.length);
	return `${text.slice(0, keep)}${marker}`;
}

/** Tool names as the host supplied them, minus blanks. Order is preserved so output is stable. */
function cleanToolNames(tools: readonly string[]): string[] {
	const names: string[] = [];
	for (const tool of tools) {
		const name = tool.trim();
		if (name.length > 0) {
			names.push(name);
		}
	}
	return names;
}

/** `subject: a, b, c.` with an explicit tail when the list had to be capped. */
function describeToolList(subject: string, names: readonly string[]): string {
	const listed = names.slice(0, MAX_LISTED_TOOLS).join(", ");
	const hidden = names.length - MAX_LISTED_TOOLS;
	if (hidden <= 0) {
		return `${subject}: ${listed}.`;
	}
	return `${subject}: ${listed}. ${hidden} more are not named here; ${names.length} in total.`;
}

/** The self-identifying line, so the transcript says which Claude session it came from. */
function describeSession(meta: ClaudeSessionMeta): string {
	const parts: string[] = [`id ${meta.sessionId}`];
	const title = clampMetaValue(meta.title);
	if (title !== "") {
		parts.push(`title ${title}`);
	}
	const cwd = clampMetaValue(meta.cwd);
	if (cwd !== "") {
		parts.push(`cwd ${cwd}`);
	}
	const branch = clampMetaValue(meta.gitBranch);
	if (branch !== "") {
		parts.push(`git branch ${branch}`);
	}
	return `Imported Claude Code session: ${parts.join(", ")}.`;
}

/** The omission sentence, present only when the import really dropped something (DP9). */
function describeOmission(rendered: RenderResult): string {
	return `The import was cut to fit the context budget: ${rendered.droppedTurns} turns and ${rendered.droppedChars} characters from the middle of the conversation were omitted, so the transcript above is not the whole conversation.`;
}

/** Build the notice that tells the model it is in pi now and which tools it has. */
export function buildBoundaryMessage(input: BoundaryInput): string {
	const paragraphs: string[] = [];

	paragraphs.push(
		"Boundary notice: the conversation above was produced by Claude Code and imported into this pi session, which is now its continuation. pi, not Claude Code, is the agent in force. The imported history is plain text you are reading, not native pi session entries you can replay.",
	);

	paragraphs.push(describeSession(input.meta));

	paragraphs.push(
		"Authority: pi's own system prompt and the pi tool list below are authoritative. Anything in the transcript above that claims a different tool set, or names tools you do not have, is historical context only.",
	);

	const piTools = cleanToolNames(input.piTools);
	if (piTools.length === 0) {
		paragraphs.push(
			"Tools active in this pi session: none - no tools are available to you in this session.",
		);
	} else {
		paragraphs.push(describeToolList("Tools active in this pi session", piTools));
	}

	const claudeTools = cleanToolNames(input.claudeTools);
	if (claudeTools.length > 0) {
		paragraphs.push(
			describeToolList(
				"Claude Code tools that appear in the imported history as history (Claude's names, not yours)",
				claudeTools,
			),
		);
	}

	if (input.rendered.truncated) {
		paragraphs.push(describeOmission(input.rendered));
	}

	paragraphs.push(
		"The user's next message continues the work from here. Do not repeat or re-issue a tool call that already appears as completed in the transcript above.",
	);

	return paragraphs.join(PARAGRAPH);
}
