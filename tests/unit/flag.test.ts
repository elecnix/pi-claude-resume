/**
 * Tests for the pi entry point and the `--claude*` flag layer.
 *
 * Everything here is synthetic (DP12): fake pi APIs, fake session entries, invented session ids.
 * The bridge is mocked, so these tests pin the adapter contract (DP3, DP8, DP10, DP11) rather than
 * the conversion itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/bridge/inject.ts", () => ({
	resumeClaudeSession: vi.fn(),
}));

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeClaudeSession } from "../../src/bridge/inject.ts";
import { parseMaxChars, readClaudeFlags, registerClaudeFlags } from "../../src/cli/flag.ts";
import piClaudeResume from "../../src/index.ts";
import {
	FLAG_CLAUDE,
	FLAG_CLAUDE_FORCE,
	FLAG_CLAUDE_MAX_CHARS,
	TRANSCRIPT_CUSTOM_TYPE,
	type BridgeHost,
	type BridgeResult,
} from "../../src/types.ts";

type FlagValues = Record<string, boolean | string | undefined>;
type Mode = "tui" | "print" | "json" | "rpc";

const SYNTHETIC_SESSION_ID = "00000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Registration {
	name: string;
	options: Record<string, unknown>;
}

function createPi(options: { flags?: FlagValues; tools?: string[] } = {}) {
	const flags = options.flags ?? {};
	const registrations: Registration[] = [];
	const getFlagCalls: string[] = [];
	const sentMessages: Array<Record<string, unknown>> = [];
	const activeTools = options.tools ?? ["bash", "read", "edit"];
	let sessionStartHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;
	// The handler runs against the context handed to `invoke`, so a test can drive one factory
	// through several pi sessions.
	let currentCtx: ExtensionContext | undefined;

	const pi = {
		registerFlag(name: string, flagOptions: Record<string, unknown>) {
			registrations.push({ name, options: flagOptions });
		},
		getFlag(name: string) {
			getFlagCalls.push(name);
			return flags[name];
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "session_start") sessionStartHandler = handler;
			return () => {};
		},
		getActiveTools: () => [...activeTools],
		sendMessage: (message: Record<string, unknown>) => {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	const invoke = async (ctx: ExtensionContext): Promise<void> => {
		if (!sessionStartHandler) throw new Error("session_start handler was never registered");
		currentCtx = ctx;
		await sessionStartHandler({ type: "session_start", reason: "startup" }, currentCtx);
	};

	return { pi, registrations, getFlagCalls, sentMessages, invoke };
}

function createCtx(options: { mode?: Mode; cwd?: string; entries?: unknown[] } = {}) {
	const notified: Array<{ message: string; level?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") !== "print",
		cwd: options.cwd ?? "/fixtures/synthetic-project",
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => {
				notified.push({ message, level });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
		},
		sessionManager: { getEntries: () => options.entries ?? [] },
	} as unknown as ExtensionContext;
	return { ctx, notified, statuses };
}

function okResult(overrides: Partial<BridgeResult> = {}): BridgeResult {
	return {
		ok: true,
		sessionId: SYNTHETIC_SESSION_ID,
		messagesSent: 2,
		turns: 3,
		chars: 1234,
		truncated: false,
		...overrides,
	};
}

function failResult(code: string, message: string): BridgeResult {
	return { ok: false, messagesSent: 0, error: { code, message } };
}

const resumeMock = vi.mocked(resumeClaudeSession);

beforeEach(() => {
	resumeMock.mockReset();
	resumeMock.mockResolvedValue(okResult());
});

/** The host the entry point handed to the bridge in the most recent call. */
function lastHost(): BridgeHost {
	const call = resumeMock.mock.calls.at(-1);
	if (!call) throw new Error("resumeClaudeSession was never called");
	return call[0];
}

// ---------------------------------------------------------------------------
// Flag registration
// ---------------------------------------------------------------------------

describe("registerClaudeFlags", () => {
	it("registers exactly the three --claude flags", () => {
		const registered: Registration[] = [];
		registerClaudeFlags((name, options) => registered.push({ name, options }));

		expect(registered.map((r) => r.name)).toEqual([
			FLAG_CLAUDE,
			FLAG_CLAUDE_MAX_CHARS,
			FLAG_CLAUDE_FORCE,
		]);
	});

	it("registers --claude as a string flag with its description", () => {
		const registered: Registration[] = [];
		registerClaudeFlags((name, options) => registered.push({ name, options }));
		const flag = registered.find((r) => r.name === FLAG_CLAUDE);

		expect(flag?.options).toEqual({
			type: "string",
			description: "Resume a Claude Code session: --claude <session-id|path|latest>",
		});
	});

	it("registers --claude-max-chars as a string flag with its description", () => {
		const registered: Registration[] = [];
		registerClaudeFlags((name, options) => registered.push({ name, options }));
		const flag = registered.find((r) => r.name === FLAG_CLAUDE_MAX_CHARS);

		expect(flag?.options.type).toBe("string");
		expect(flag?.options.description).toBe(
			"Character budget for the imported transcript (default 120000)",
		);
	});

	it("registers --claude-force as a boolean flag with its description", () => {
		const registered: Registration[] = [];
		registerClaudeFlags((name, options) => registered.push({ name, options }));
		const flag = registered.find((r) => r.name === FLAG_CLAUDE_FORCE);

		expect(flag?.options.type).toBe("boolean");
		expect(flag?.options.description).toBe(
			"Re-import even if this pi session already imported that Claude session",
		);
	});
});

// ---------------------------------------------------------------------------
// readClaudeFlags / parseMaxChars
// ---------------------------------------------------------------------------

describe("readClaudeFlags", () => {
	const read = (values: FlagValues) => readClaudeFlags((name) => values[name]);

	it("returns nothing when no flag is present", () => {
		expect(read({})).toEqual({ spec: undefined, maxChars: undefined, force: false });
	});

	it("treats an empty --claude value as absent", () => {
		expect(read({ [FLAG_CLAUDE]: "" }).spec).toBeUndefined();
	});

	it("treats a whitespace-only --claude value as absent", () => {
		expect(read({ [FLAG_CLAUDE]: "   \t " }).spec).toBeUndefined();
	});

	it("trims the --claude value and parses the other two flags", () => {
		expect(
			read({
				[FLAG_CLAUDE]: "  00000000-0000-4000-8000-000000000001\n",
				[FLAG_CLAUDE_MAX_CHARS]: " 5000 ",
				[FLAG_CLAUDE_FORCE]: true,
			}),
		).toEqual({ spec: SYNTHETIC_SESSION_ID, maxChars: 5000, force: true });
	});

	it('accepts the string "true" for --claude-force', () => {
		expect(read({ [FLAG_CLAUDE_FORCE]: "true" }).force).toBe(true);
	});

	it("does not treat false or the string \"false\" as force", () => {
		expect(read({ [FLAG_CLAUDE_FORCE]: false }).force).toBe(false);
		expect(read({ [FLAG_CLAUDE_FORCE]: "false" }).force).toBe(false);
		expect(read({ [FLAG_CLAUDE_FORCE]: "1" }).force).toBe(false);
	});

	it("keeps the spec but drops an invalid --claude-max-chars", () => {
		for (const invalid of ["12abc", "1.5", "-3", "0", "1e6", "  ", "Infinity"]) {
			const values = read({ [FLAG_CLAUDE]: "latest", [FLAG_CLAUDE_MAX_CHARS]: invalid });
			expect(values.spec).toBe("latest");
			expect(values.maxChars).toBeUndefined();
		}
	});

	it("parses a valid --claude-max-chars", () => {
		expect(read({ [FLAG_CLAUDE_MAX_CHARS]: "120000" }).maxChars).toBe(120000);
	});
});

describe("parseMaxChars", () => {
	it("returns undefined for absent or non-numeric input", () => {
		for (const raw of [
			undefined,
			true,
			false,
			"",
			"   ",
			"0",
			"-3",
			"1.5",
			"12abc",
			"1e6",
			"+12",
			"Infinity",
			"9".repeat(400),
		]) {
			expect(parseMaxChars(raw)).toBeUndefined();
		}
	});

	it("parses positive decimal integers, tolerating surrounding whitespace", () => {
		expect(parseMaxChars("1")).toBe(1);
		expect(parseMaxChars("120000")).toBe(120000);
		expect(parseMaxChars(" 5000 ")).toBe(5000);
	});
});

// ---------------------------------------------------------------------------
// Entry point wiring
// ---------------------------------------------------------------------------

describe("piClaudeResume", () => {
	it("registers the flags when the factory runs", () => {
		const { pi, registrations } = createPi();
		piClaudeResume(pi);
		expect(registrations.map((r) => r.name)).toEqual([
			FLAG_CLAUDE,
			FLAG_CLAUDE_MAX_CHARS,
			FLAG_CLAUDE_FORCE,
		]);
	});

	it("does not read flag values until session_start fires", () => {
		const { pi, getFlagCalls } = createPi();
		piClaudeResume(pi);
		expect(getFlagCalls).toEqual([]);
	});

	it("does nothing at all without --claude", async () => {
		const { pi, invoke } = createPi();
		const { ctx, notified, statuses } = createCtx();
		piClaudeResume(pi);

		await invoke(ctx);

		expect(resumeMock).not.toHaveBeenCalled();
		expect(notified).toEqual([]);
		expect(statuses).toEqual([]);
	});

	it("does nothing when --claude is blank", async () => {
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "  " } });
		const { ctx, notified } = createCtx();
		piClaudeResume(pi);

		await invoke(ctx);

		expect(resumeMock).not.toHaveBeenCalled();
		expect(notified).toEqual([]);
	});

	it("reads the flags and passes them to the bridge at session_start", async () => {
		const { pi, invoke, getFlagCalls } = createPi({
			flags: {
				[FLAG_CLAUDE]: ` ${SYNTHETIC_SESSION_ID} `,
				[FLAG_CLAUDE_MAX_CHARS]: "9000",
				[FLAG_CLAUDE_FORCE]: true,
			},
		});
		const { ctx } = createCtx();
		piClaudeResume(pi);

		await invoke(ctx);

		expect(getFlagCalls).toEqual([FLAG_CLAUDE, FLAG_CLAUDE_MAX_CHARS, FLAG_CLAUDE_FORCE]);
		expect(resumeMock).toHaveBeenCalledTimes(1);
		expect(resumeMock.mock.calls[0]?.[1]).toEqual({
			spec: SYNTHETIC_SESSION_ID,
			maxChars: 9000,
			force: true,
		});
	});

	it("builds the host from ctx.cwd and pi's active tools", async () => {
		const { pi, invoke } = createPi({
			flags: { [FLAG_CLAUDE]: "latest" },
			tools: ["bash", "read"],
		});
		const { ctx } = createCtx({ cwd: "/fixtures/synthetic-project" });
		piClaudeResume(pi);

		await invoke(ctx);

		const host = lastHost();
		expect(host.cwd).toBe("/fixtures/synthetic-project");
		expect(host.piTools).toEqual(["bash", "read"]);
	});

	it("forwards custom messages through pi.sendMessage", async () => {
		const { pi, invoke, sentMessages } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx } = createCtx();
		piClaudeResume(pi);

		await invoke(ctx);
		await lastHost().sendCustomMessage({
			customType: TRANSCRIPT_CUSTOM_TYPE,
			content: "synthetic transcript",
			display: false,
			details: { sessionId: SYNTHETIC_SESSION_ID },
		});

		expect(sentMessages).toEqual([
			{
				customType: TRANSCRIPT_CUSTOM_TYPE,
				content: "synthetic transcript",
				display: false,
				details: { sessionId: SYNTHETIC_SESSION_ID },
			},
		]);
	});
});

// ---------------------------------------------------------------------------
// Outcome reporting
// ---------------------------------------------------------------------------

describe("outcome reporting", () => {
	it("sets the footer status and notifies on a successful import in tui mode", async () => {
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified, statuses } = createCtx({ mode: "tui" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).resolves.toBeUndefined();

		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.key).toBe("claude-resume");
		expect(statuses[0]?.text).toContain("2 messages");
		expect(notified).toHaveLength(1);
		expect(notified[0]?.level).toBe("info");
		expect(notified[0]?.message).toContain(SYNTHETIC_SESSION_ID);
	});

	it("mentions truncation in the notification when the transcript was capped", async () => {
		resumeMock.mockResolvedValue(okResult({ truncated: true, chars: 120_000 }));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified } = createCtx({ mode: "tui" });
		piClaudeResume(pi);

		await invoke(ctx);

		expect(notified[0]?.message).toContain("truncated");
	});

	it("notifies without footer status in print mode", async () => {
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified, statuses } = createCtx({ mode: "print" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).resolves.toBeUndefined();

		expect(statuses).toEqual([]);
		expect(notified).toHaveLength(1);
		expect(notified[0]?.level).toBe("info");
	});

	it("stays quiet apart from one info notification when already imported", async () => {
		resumeMock.mockResolvedValue(okResult({ messagesSent: 0 }));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified, statuses } = createCtx({ mode: "tui" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).resolves.toBeUndefined();

		expect(statuses).toEqual([]);
		expect(notified).toEqual([
			{
				message: `Claude session ${SYNTHETIC_SESSION_ID} already imported`,
				level: "info",
			},
		]);
	});

	it("notifies an error and does not throw on failure in tui mode", async () => {
		resumeMock.mockResolvedValue(failResult("not-found", "no session matches that id"));
		const { pi, invoke, sentMessages } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified, statuses } = createCtx({ mode: "tui" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).resolves.toBeUndefined();

		expect(notified).toEqual([{ message: "Claude resume failed: no session matches that id", level: "error" }]);
		expect(statuses).toEqual([]);
		expect(sentMessages).toEqual([]);
	});

	it("throws with the error code and message on failure in print mode", async () => {
		resumeMock.mockResolvedValue(failResult("not-found", "no session matches that id"));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified } = createCtx({ mode: "print" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).rejects.toThrow(
			"pi-claude-resume: not-found: no session matches that id",
		);
		expect(notified[0]?.level).toBe("error");
	});

	it("throws on failure in json mode too", async () => {
		resumeMock.mockResolvedValue(failResult("ambiguous", "two sessions match"));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx } = createCtx({ mode: "json" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).rejects.toThrow("pi-claude-resume: ambiguous: two sessions match");
	});

	it("turns an unexpected bridge throw into an error notification in tui mode", async () => {
		resumeMock.mockRejectedValue(new Error("synthetic explosion"));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx, notified } = createCtx({ mode: "tui" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).resolves.toBeUndefined();

		expect(notified).toEqual([
			{ message: "Claude resume failed: synthetic explosion", level: "error" },
		]);
	});

	it("rethrows an unexpected bridge throw in print mode", async () => {
		resumeMock.mockRejectedValue(new Error("synthetic explosion"));
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx } = createCtx({ mode: "print" });
		piClaudeResume(pi);

		await expect(invoke(ctx)).rejects.toThrow("pi-claude-resume: bridge-error: synthetic explosion");
	});
});

// ---------------------------------------------------------------------------
// Idempotency probe (DP10)
// ---------------------------------------------------------------------------

describe("host.hasInjected", () => {
	async function hostWith(entries: unknown[]): Promise<BridgeHost> {
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx } = createCtx({ entries });
		piClaudeResume(pi);
		await invoke(ctx);
		return lastHost();
	}

	it("matches a custom message entry carrying the same session id", async () => {
		const host = await hostWith([
			{
				type: "message",
				id: "entry-1",
				message: {
					role: "custom",
					customType: TRANSCRIPT_CUSTOM_TYPE,
					details: { sessionId: SYNTHETIC_SESSION_ID },
				},
			},
		]);

		expect(host.hasInjected(SYNTHETIC_SESSION_ID)).toBe(true);
	});

	it("matches pi's own custom_message entry shape", async () => {
		const host = await hostWith([
			{
				type: "custom_message",
				id: "entry-2",
				customType: TRANSCRIPT_CUSTOM_TYPE,
				details: { sessionId: SYNTHETIC_SESSION_ID },
			},
		]);

		expect(host.hasInjected(SYNTHETIC_SESSION_ID)).toBe(true);
	});

	it("ignores a transcript imported from a different session", async () => {
		const host = await hostWith([
			{
				type: "message",
				message: {
					role: "custom",
					customType: TRANSCRIPT_CUSTOM_TYPE,
					details: { sessionId: "00000000-0000-4000-8000-000000000002" },
				},
			},
		]);

		expect(host.hasInjected(SYNTHETIC_SESSION_ID)).toBe(false);
	});

	it("ignores custom messages of another custom type", async () => {
		const host = await hostWith([
			{
				type: "message",
				message: {
					role: "custom",
					customType: "claude-resume.boundary",
					details: { sessionId: SYNTHETIC_SESSION_ID },
				},
			},
			{ type: "message", message: { role: "user", content: "synthetic prompt" } },
		]);

		expect(host.hasInjected(SYNTHETIC_SESSION_ID)).toBe(false);
	});

	it("tolerates entries missing message, missing details, or of an unknown shape", async () => {
		const host = await hostWith([
			null,
			"a string entry",
			{ type: "message" },
			{ type: "message", message: null },
			{ type: "message", message: { role: "custom", customType: TRANSCRIPT_CUSTOM_TYPE } },
			{ type: "custom_message", customType: TRANSCRIPT_CUSTOM_TYPE },
			{ type: "usage", usage: { input: 1 } },
		]);

		expect(host.hasInjected(SYNTHETIC_SESSION_ID)).toBe(false);
	});

	it("returns false when the session manager cannot be read", async () => {
		const { pi, invoke } = createPi({ flags: { [FLAG_CLAUDE]: "latest" } });
		const { ctx } = createCtx();
		(ctx.sessionManager as unknown as { getEntries: () => unknown }).getEntries = () => {
			throw new Error("synthetic unreadable session");
		};
		piClaudeResume(pi);

		await invoke(ctx);

		expect(lastHost().hasInjected(SYNTHETIC_SESSION_ID)).toBe(false);
	});
});
