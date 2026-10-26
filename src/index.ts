/**
 * pi extension entry point.
 *
 * The only module that touches the pi extension API: register the flags, on `session_start`
 * hand the runtime to the bridge, and report the outcome (DP3, DP8, DP11).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piClaudeResume(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		// TODO: wire registerClaudeFlags + readClaudeFlags + resumeClaudeSession.
	});
}
