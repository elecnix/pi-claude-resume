/**
 * Unit tests for the bridge orchestration (DP1, DP10, DP11, DP13).
 *
 * The bridge composes four pure modules plus the host. Two of those modules (`locate`, `parse`)
 * are mocked here because they own the filesystem and the JSONL format; `render` and `boundary`
 * are mocked too: this file specifies the *order and failure behaviour* of the orchestration,
 * not the renderer or the notice, which have their own tests.
 *
 * Every fixture is hand-written and synthetic (DP12): invented ids, `/work/synthetic-project`,
 * invented prose. Nothing here came from a real Claude Code session.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeHost, ClaudeTranscript, ClaudeTurn, RenderResult } from "../../src/types.ts";

vi.mock("../../src/claude/locate.ts", () => ({
	claudeProjectSlug: vi.fn(),
	locateClaudeSession: vi.fn(),
}));
vi.mock("../../src/claude/parse.ts", () => ({
	parseClaudeSession: vi.fn(),
}));
vi.mock("../../src/claude/render.ts", () => ({
	renderTranscript: vi.fn(),
}));
vi.mock("../../src/claude/boundary.ts", () => ({
	buildBoundaryMessage: vi.fn(),
}));

import { buildBoundaryMessage } from "../../src/claude/boundary.ts";
import { locateClaudeSession } from "../../src/claude/locate.ts";
import { parseClaudeSession } from "../../src/claude/parse.ts";
import { renderTranscript } from "../../src/claude/render.ts";
import { resumeClaudeSession } from "../../src/bridge/inject.ts";
import { describeParseLoss } from "../../src/shared/diagnostics.ts";
import { BOUNDARY_CUSTOM_TYPE, TRANSCRIPT_CUSTOM_TYPE } from "../../src/types.ts";

const SESSION_ID = "0f9c1d2e-0000-4000-8000-000000000001";
const PROJECT_DIR = "/home/synthetic/.claude/projects/-work-synthetic-project";

/** Hand-written JSONL that merely resembles the format; contains no real conversation (DP12). */
const FIXTURE_RAW = [
	`{"type":"user","uuid":"turn-1","sessionId":"${SESSION_ID}","message":{"role":"user","content":"héllo from a synthetic fixture ✓"}}`,
	`{"type":"assistant","uuid":"turn-2","sessionId":"${SESSION_ID}","message":{"role":"assistant","content":[{"type":"text","text":"invented reply"}]}}`,
].join("\n");

const FIXTURE_TURNS: ClaudeTurn[] = [
	{ kind: "user", text: "summarise the synthetic fixture" },
	{
		kind: "assistant",
		text: "reading the fixture",
		tools: [
			{ id: "tool-1", claudeName: "Read", input: { file_path: "/work/synthetic-project/README.md" } },
			{ id: "tool-2", claudeName: "Bash", input: { command: "ls" } },
		],
	},
	{ kind: "tool_result", toolUseId: "tool-1", text: "synthetic file contents", isError: false },
	{
		kind: "assistant",
		text: "done",
		tools: [{ id: "tool-3", claudeName: "Read", input: { file_path: "/work/synthetic-project/README.md" } }],
	},
];

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

interface FakeHost {
	host: BridgeHost;
	sent: SentMessage[];
	/**
	 * A notifier the bridge must never call: notifications belong to the adapter, which knows the
	 * run mode (finding 3). The spy is attached to the fake host object even though `BridgeHost`
	 * no longer declares `notify`; if the bridge notified again, this spy would record it.
	 */
	notify: ReturnType<typeof vi.fn>;
	hasInjected: ReturnType<typeof vi.fn>;
}

function createHost(overrides: Partial<BridgeHost> = {}): FakeHost {
	const sent: SentMessage[] = [];
	const notify = vi.fn();
	const hasInjected = vi.fn((_sessionId: string) => false);
	const host = {
		cwd: "/work/synthetic-project",
		homeDir: "/home/synthetic",
		projectsRoot: "/home/synthetic/.claude/projects",
		piTools: ["bash", "read", "edit"],
		hasInjected,
		sendCustomMessage: vi.fn(async (message: SentMessage) => {
			sent.push(message);
		}),
		notify,
		...overrides,
	} as unknown as BridgeHost;
	return { host, sent, notify, hasInjected };
}

let tmpDir = "";

function sessionPath(sessionId = SESSION_ID): string {
	return join(tmpDir, `${sessionId}.jsonl`);
}

function syntheticTranscript(options: { sessionId?: string; path?: string; turns?: ClaudeTurn[] } = {}): ClaudeTranscript {
	const sessionId = options.sessionId ?? SESSION_ID;
	return {
		meta: {
			sessionId,
			path: options.path ?? sessionPath(sessionId),
			cwd: "/work/synthetic-project",
			gitBranch: "main",
			title: "Synthetic fixture session",
			firstTimestamp: "2024-01-01T00:00:00.000Z",
			lastTimestamp: "2024-01-01T00:05:00.000Z",
			models: ["claude-synthetic"],
		},
		turns: options.turns ?? FIXTURE_TURNS,
		stats: {
			rawLines: 6,
			parsedEntries: 5,
			malformedLines: 0,
			skippedEntries: 1,
			droppedSidechains: 0,
			droppedMeta: 0,
			droppedApiErrors: 0,
		},
	};
}

function syntheticRender(overrides: Partial<RenderResult> = {}): RenderResult {
	return {
		text: "## Claude Code transcript\nsynthetic rendered body",
		chars: 120,
		estimatedTokens: 30,
		truncated: false,
		droppedTurns: 0,
		droppedChars: 0,
		...overrides,
	};
}

function mockLocateOk(path: string, sessionId = SESSION_ID): void {
	vi.mocked(locateClaudeSession).mockReturnValue({
		ok: true,
		path,
		sessionId,
		projectDir: PROJECT_DIR,
		source: "id",
	});
}

function mockParse(transcript: ClaudeTranscript, warnings: string[] = []): void {
	vi.mocked(parseClaudeSession).mockReturnValue({ transcript, warnings });
}

/** Write a session file into the per-test temp directory and point `locate` at it. */
async function arrangeSession(
	raw: string = FIXTURE_RAW,
	transcript: ClaudeTranscript = syntheticTranscript(),
): Promise<string> {
	const path = transcript.meta.path;
	await writeFile(path, raw, "utf8");
	mockLocateOk(path);
	mockParse(transcript);
	return path;
}

function expectTwoMessages(sent: SentMessage[]): [SentMessage, SentMessage] {
	const [first, second] = sent;
	if (!first || !second) {
		throw new Error(`expected two injected messages, got ${sent.length}`);
	}
	return [first, second];
}

beforeEach(async () => {
	vi.clearAllMocks();
	tmpDir = await mkdtemp(join(tmpdir(), "pi-claude-resume-inject-"));
	vi.mocked(renderTranscript).mockReturnValue(syntheticRender());
	vi.mocked(buildBoundaryMessage).mockReturnValue("BOUNDARY NOTICE");
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("resumeClaudeSession — option validation", () => {
	it("rejects an empty spec with invalid-spec before touching the filesystem (DP5)", async () => {
		const { host, sent, notify } = createHost();

		const result = await resumeClaudeSession(host, { spec: "" });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("invalid-spec");
		expect(result.error?.message).toContain("expected a session id");
		expect(result.messagesSent).toBe(0);
		expect(locateClaudeSession).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only spec", async () => {
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: " \t\n " });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("invalid-spec");
		expect(locateClaudeSession).not.toHaveBeenCalled();
	});

	it("rejects a missing spec defensively", async () => {
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: undefined as unknown as string });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("invalid-spec");
		expect(locateClaudeSession).not.toHaveBeenCalled();
	});

	it("trims the spec before locating it", async () => {
		await arrangeSession();
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: `  ${SESSION_ID}\n` });

		expect(vi.mocked(locateClaudeSession)).toHaveBeenCalledWith(
			expect.objectContaining({ spec: SESSION_ID, cwd: "/work/synthetic-project" }),
		);
	});
});

describe("resumeClaudeSession — locate failures", () => {
	it("propagates not-found with the locator's message and sends nothing", async () => {
		vi.mocked(locateClaudeSession).mockReturnValue({
			ok: false,
			code: "not-found",
			message: "no Claude Code session matches that id in this project",
		});
		const { host, sent, notify } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({
			code: "not-found",
			message: "no Claude Code session matches that id in this project",
		});
		expect(result.messagesSent).toBe(0);
		expect(sent).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("propagates ambiguous", async () => {
		vi.mocked(locateClaudeSession).mockReturnValue({
			ok: false,
			code: "ambiguous",
			message: "two sessions match; pass one of the candidates",
			candidates: ["/a/one.jsonl", "/a/two.jsonl"],
		});
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: "latest" });

		expect(result.error?.code).toBe("ambiguous");
	});

	it("propagates unreadable from the locator", async () => {
		vi.mocked(locateClaudeSession).mockReturnValue({
			ok: false,
			code: "unreadable",
			message: "session file is not readable",
		});
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.error?.code).toBe("unreadable");
		expect(sent).toHaveLength(0);
	});

	it("propagates invalid-spec from the locator unchanged", async () => {
		vi.mocked(locateClaudeSession).mockReturnValue({
			ok: false,
			code: "invalid-spec",
			message: "a relative path is not a session spec",
		});
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: "./somewhere.jsonl" });

		expect(result.error?.code).toBe("invalid-spec");
		expect(parseClaudeSession).not.toHaveBeenCalled();
	});

	it("passes cwd, homeDir and projectsRoot from the host to the locator", async () => {
		const { host } = createHost();
		await arrangeSession();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(vi.mocked(locateClaudeSession)).toHaveBeenCalledWith({
			spec: SESSION_ID,
			cwd: "/work/synthetic-project",
			homeDir: "/home/synthetic",
			projectsRoot: "/home/synthetic/.claude/projects",
		});
	});
});

describe("resumeClaudeSession — idempotency (DP10)", () => {
	it("skips silently when the session was already injected", async () => {
		const path = await arrangeSession();
		const { host, sent, notify, hasInjected } = createHost();
		hasInjected.mockReturnValue(true);

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(true);
		expect(result.messagesSent).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.sessionId).toBe(SESSION_ID);
		expect(result.sessionPath).toBe(path);
		expect(sent).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
		expect(parseClaudeSession).not.toHaveBeenCalled();
		expect(renderTranscript).not.toHaveBeenCalled();
	});

	it("asks hasInjected about the located session id", async () => {
		await arrangeSession();
		const { host, hasInjected } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(hasInjected).toHaveBeenCalledWith(SESSION_ID);
	});

	it("keys both the idempotency probe and the recorded details on the located session id (DP10)", async () => {
		// A copied or forked session file: the entries still carry the id of the conversation the
		// file was copied from, so the file name and the entry field disagree.
		const fileId = "0f9c1d2e-0000-4000-8000-0000000000ff";
		const entryId = "0f9c1d2e-0000-4000-8000-000000000001";
		const transcript = syntheticTranscript({ sessionId: entryId, path: sessionPath(fileId) });
		await writeFile(transcript.meta.path, FIXTURE_RAW, "utf8");
		mockLocateOk(transcript.meta.path, fileId);
		mockParse(transcript);
		const { host, sent, hasInjected } = createHost();

		const result = await resumeClaudeSession(host, { spec: fileId });

		const [transcriptMessage] = expectTwoMessages(sent);
		const probeId = hasInjected.mock.calls[0]?.[0];
		const recordedId = (transcriptMessage.details as { sessionId?: string }).sessionId;
		// The probe and the record must agree, or the next run re-imports the same history.
		expect(probeId).toBe(fileId);
		expect(recordedId).toBe(probeId);
		expect(result.sessionId).toBe(probeId);
		expect(vi.mocked(buildBoundaryMessage).mock.calls[0]?.[0]?.meta.sessionId).toBe(probeId);
		expect(vi.mocked(renderTranscript).mock.calls[0]?.[0]?.meta.sessionId).toBe(probeId);
	});

	it("does not consult hasInjected when force is set", async () => {
		await arrangeSession();
		const { host, hasInjected, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID, force: true });

		expect(hasInjected).not.toHaveBeenCalled();
		expect(result.ok).toBe(true);
		expect(sent).toHaveLength(2);
	});

	it("injects anyway when force overrides an already-injected session", async () => {
		await arrangeSession();
		const { host, hasInjected, sent } = createHost();
		hasInjected.mockReturnValue(true);

		const result = await resumeClaudeSession(host, { spec: SESSION_ID, force: true });

		expect(result.ok).toBe(true);
		expect(result.messagesSent).toBe(2);
		expect(sent).toHaveLength(2);
	});
});

describe("resumeClaudeSession — read and parse failures (DP11)", () => {
	it("maps a read error to unreadable and never parses", async () => {
		const missing = sessionPath();
		mockLocateOk(missing);
		const { host, sent, notify } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("unreadable");
		expect(result.messagesSent).toBe(0);
		expect(parseClaudeSession).not.toHaveBeenCalled();
		expect(sent).toHaveLength(0);
		expect(notify).not.toHaveBeenCalled();
	});

	it("maps a session with no turns to empty-session", async () => {
		await arrangeSession(FIXTURE_RAW, syntheticTranscript({ turns: [] }));
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("empty-session");
		expect(result.error?.message).toContain("no conversation");
		expect(sent).toHaveLength(0);
		expect(renderTranscript).not.toHaveBeenCalled();
	});

	it("maps a throwing parser to internal", async () => {
		const path = sessionPath();
		await writeFile(path, FIXTURE_RAW, "utf8");
		mockLocateOk(path);
		vi.mocked(parseClaudeSession).mockImplementation(() => {
			throw new Error("parser exploded");
		});
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ code: "internal", message: "parser exploded" });
		expect(sent).toHaveLength(0);
	});

	it("maps a throwing hasInjected to internal", async () => {
		await arrangeSession();
		const { host } = createHost({
			hasInjected: () => {
				throw new Error("session store unavailable");
			},
		});

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ code: "internal", message: "session store unavailable" });
	});
});

describe("resumeClaudeSession — successful injection", () => {
	it("sends the transcript then the boundary, with the shared custom types", async () => {
		await arrangeSession();
		const { host, sent } = createHost();

		await expect(resumeClaudeSession(host, { spec: SESSION_ID })).resolves.toMatchObject({ ok: true });

		const [transcriptMessage, boundaryMessage] = expectTwoMessages(sent);
		expect(transcriptMessage.customType).toBe(TRANSCRIPT_CUSTOM_TYPE);
		expect(transcriptMessage.customType).toBe("claude-resume.transcript");
		expect(transcriptMessage.display).toBe(false);
		expect(boundaryMessage.customType).toBe(BOUNDARY_CUSTOM_TYPE);
		expect(boundaryMessage.customType).toBe("claude-resume.boundary");
		expect(boundaryMessage.display).toBe(true);
	});

	it("sends the rendered transcript text and the boundary notice as content", async () => {
		await arrangeSession();
		vi.mocked(renderTranscript).mockReturnValue(syntheticRender({ text: "RENDERED TRANSCRIPT TEXT" }));
		vi.mocked(buildBoundaryMessage).mockReturnValue("THE BOUNDARY NOTICE");
		const { host, sent } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		const [transcriptMessage, boundaryMessage] = expectTwoMessages(sent);
		expect(transcriptMessage.content).toBe("RENDERED TRANSCRIPT TEXT");
		expect(boundaryMessage.content).toBe("THE BOUNDARY NOTICE");
	});

	it("attaches the transcript details payload", async () => {
		const path = await arrangeSession();
		const { host, sent } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		const transcript = syntheticTranscript();
		const [transcriptMessage] = expectTwoMessages(sent);
		expect(transcriptMessage.details).toEqual({
			sessionId: SESSION_ID,
			sessionPath: path,
			chars: 120,
			truncated: false,
			droppedTurns: 0,
			// The parser's counters travel with the message so a later reader can audit the
			// import instead of trusting a summary (DP9, finding 2).
			parseStats: transcript.stats,
		});
		expect(Object.keys(transcriptMessage.details as Record<string, unknown>).sort()).toEqual([
			"chars",
			"droppedTurns",
			"parseStats",
			"sessionId",
			"sessionPath",
			"truncated",
		]);
	});

	it("carries the parse counts into the details and the result, and names them in the notification", async () => {
		const lossy = syntheticTranscript();
		lossy.stats = {
			rawLines: 20,
			parsedEntries: 4,
			malformedLines: 3,
			skippedEntries: 12,
			droppedSidechains: 1,
			droppedMeta: 0,
			droppedApiErrors: 0,
		};
		await arrangeSession(FIXTURE_RAW, lossy);
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		// A half-parsed session must not read as a clean import (DP9): the counts reach both the
		// message the model reads and the result the adapter reports.
		const [transcriptMessage] = expectTwoMessages(sent);
		expect(transcriptMessage.details).toMatchObject({ parseStats: lossy.stats });
		expect(result.parseStats).toEqual(lossy.stats);
	});

	it("does not claim a loss when the parse dropped nothing but bookkeeping", async () => {
		const clean = syntheticTranscript();
		clean.stats = {
			rawLines: 4,
			parsedEntries: 4,
			malformedLines: 0,
			skippedEntries: 0,
			droppedSidechains: 0,
			droppedMeta: 0,
			droppedApiErrors: 0,
		};
		await arrangeSession(FIXTURE_RAW, clean);
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.parseStats).toEqual(clean.stats);
		expect(describeParseLoss(clean.stats)).toEqual([]);
	});

	it("reports the truncation the renderer applied", async () => {
		await arrangeSession();
		vi.mocked(renderTranscript).mockReturnValue(
			syntheticRender({ chars: 400, estimatedTokens: 100, truncated: true, droppedTurns: 3, droppedChars: 5_000 }),
		);
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		const [transcriptMessage] = expectTwoMessages(sent);
		expect(transcriptMessage.details).toMatchObject({ truncated: true, droppedTurns: 3 });
		// The counts reach the adapter in the result, which is where the notification is written.
		expect(result.truncated).toBe(true);
		expect(result.droppedTurns).toBe(3);
		expect(result.droppedChars).toBe(5_000);
	});

	it("counts both messages", async () => {
		await arrangeSession();
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.messagesSent).toBe(2);
	});

	it("returns the session identity and the render statistics", async () => {
		const path = await arrangeSession();
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result).toMatchObject({
			ok: true,
			sessionId: SESSION_ID,
			sessionPath: path,
			sourceCwd: "/work/synthetic-project",
			title: "Synthetic fixture session",
			turns: FIXTURE_TURNS.length,
			chars: 120,
			estimatedTokens: 30,
			truncated: false,
			messagesSent: 2,
		});
		expect(result.error).toBeUndefined();
	});

	it("returns a JSON-serializable result", async () => {
		await arrangeSession();
		const { host } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("forwards maxChars to the renderer", async () => {
		await arrangeSession();
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID, maxChars: 5_000 });

		expect(vi.mocked(renderTranscript).mock.calls[0]?.[1]).toMatchObject({ maxChars: 5_000 });
	});

	it("leaves maxChars undefined so the renderer can apply its own default (DP9)", async () => {
		await arrangeSession();
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(vi.mocked(renderTranscript).mock.calls[0]?.[1]?.maxChars).toBeUndefined();
	});

	it("hands the renderer the parsed transcript and the tool mapper (DP7)", async () => {
		const transcript = syntheticTranscript();
		await arrangeSession(FIXTURE_RAW, transcript);
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		const [renderedTranscript, renderOptions] = vi.mocked(renderTranscript).mock.calls[0] ?? [];
		// The turns and stats are the parsed ones, untouched; only the identity is normalized to
		// the located file so the header and the boundary notice name the same session (DP10).
		expect(renderedTranscript?.turns).toBe(transcript.turns);
		expect(renderedTranscript?.stats).toBe(transcript.stats);
		expect(renderedTranscript?.meta.sessionId).toBe(SESSION_ID);
		expect(typeof renderOptions?.mapTool).toBe("function");
	});

	it("reads the located file once, as UTF-8, and parses exactly those bytes", async () => {
		const path = await arrangeSession();
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(vi.mocked(parseClaudeSession)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(parseClaudeSession)).toHaveBeenCalledWith(FIXTURE_RAW, {
			path,
			sessionId: SESSION_ID,
		});
	});

	it("gives the boundary the transcript meta, pi's tool list and the unique Claude tool names (DP8)", async () => {
		await arrangeSession();
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		const boundaryInput = vi.mocked(buildBoundaryMessage).mock.calls[0]?.[0];
		expect(boundaryInput?.meta.sessionId).toBe(SESSION_ID);
		expect(boundaryInput?.meta.path).toBe(sessionPath());
		expect(boundaryInput?.piTools).toEqual(["bash", "read", "edit"]);
		expect(boundaryInput?.claudeTools).toEqual(["Read", "Bash"]);
		expect(boundaryInput?.rendered.chars).toBe(120);
	});

	it("reports no Claude tools when the history has no tool calls", async () => {
		await arrangeSession(FIXTURE_RAW, syntheticTranscript({ turns: [{ kind: "user", text: "just a question" }] }));
		const { host } = createHost();

		await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(vi.mocked(buildBoundaryMessage).mock.calls[0]?.[0]?.claudeTools).toEqual([]);
	});

	it("falls back to the located id and path when the parse returned neither", async () => {
		const transcript = syntheticTranscript();
		transcript.meta.sessionId = "";
		transcript.meta.path = "";
		const path = sessionPath();
		await writeFile(path, FIXTURE_RAW, "utf8");
		mockLocateOk(path);
		mockParse(transcript);
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.sessionId).toBe(SESSION_ID);
		expect(result.sessionPath).toBe(path);
		expect(expectTwoMessages(sent)[0].details).toMatchObject({ sessionId: SESSION_ID, sessionPath: path });
	});
});

describe("resumeClaudeSession — notification ownership (DP11)", () => {
	it("reports a successful import in the result and notifies nobody itself", async () => {
		await arrangeSession();
		const { host, notify } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		// The adapter owns the notification because only it knows the run mode (finding 3).
		expect(notify).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			ok: true,
			sessionId: SESSION_ID,
			turns: FIXTURE_TURNS.length,
			chars: 120,
			truncated: false,
		});
	});

	it("reports a failure in the result and notifies nobody itself", async () => {
		vi.mocked(locateClaudeSession).mockReturnValue({
			ok: false,
			code: "not-found",
			message: "no session with that id",
		});
		const { host, notify } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(notify).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ code: "not-found", message: "no session with that id" });
	});

	it("notifies nobody when the injection itself failed", async () => {
		await arrangeSession();
		const { host, notify } = createHost({
			sendCustomMessage: async () => {
				throw new Error("pi refused the message");
			},
		});

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(notify).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("internal");
	});
});

describe("resumeClaudeSession — host callback failures (DP11)", () => {
	it("turns a rejected transcript send into an internal error and sends no second message", async () => {
		await arrangeSession();
		const attempted: SentMessage[] = [];
		const { host } = createHost({
			sendCustomMessage: async (message: SentMessage) => {
				attempted.push(message);
				throw new Error("pi refused the message");
			},
		});

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("internal");
		expect(result.error?.message).toContain("pi refused the message");
		expect(result.messagesSent).toBe(0);
		expect(attempted).toHaveLength(1);
		expect(attempted[0]?.customType).toBe(TRANSCRIPT_CUSTOM_TYPE);
	});

	it("reports messagesSent: 1 when only the boundary send is rejected", async () => {
		await arrangeSession();
		const delivered: SentMessage[] = [];
		const { host } = createHost({
			sendCustomMessage: async (message: SentMessage) => {
				if (delivered.length === 1) {
					throw new Error("pi refused the boundary");
				}
				delivered.push(message);
			},
		});

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("internal");
		expect(result.messagesSent).toBe(1);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.customType).toBe(TRANSCRIPT_CUSTOM_TYPE);
	});

	it("describes a thrown non-Error value", async () => {
		await arrangeSession();
		vi.mocked(buildBoundaryMessage).mockImplementation(() => {
			throw "boundary builder gave up";
		});
		const { host, sent } = createHost();

		const result = await resumeClaudeSession(host, { spec: SESSION_ID });

		expect(result.ok).toBe(false);
		expect(result.error).toEqual({ code: "internal", message: "boundary builder gave up" });
		expect(sent).toHaveLength(0);
	});

	it("never rejects, whatever the host and modules do", async () => {
		await arrangeSession();
		vi.mocked(renderTranscript).mockImplementation(() => {
			throw new TypeError("renderer exploded");
		});
		const { host } = createHost();

		await expect(resumeClaudeSession(host, { spec: SESSION_ID })).resolves.toMatchObject({
			ok: false,
			error: { code: "internal", message: "renderer exploded" },
		});
	});
});
