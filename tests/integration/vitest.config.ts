import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Config for the opt-in end-to-end suite (DP13). It is separate from the root config so the
 * unit suite stays fast and model-free:
 *
 *   npx vitest run --config tests/integration/vitest.config.ts
 *
 * The root is the repository, so `include` is repo-relative; `tests/integration` appears in no
 * exclude list. Model-dependent tests skip unless `PI_CLAUDE_IT=1` (see `resume.test.ts`).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
	root: repoRoot,
	test: {
		include: ["tests/integration/**/*.test.ts"],
		environment: "node",
		testTimeout: 180_000,
		fileParallelism: false,
	},
});
