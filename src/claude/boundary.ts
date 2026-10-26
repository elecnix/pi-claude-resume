/**
 * The boundary notice injected after the imported history (DP8, DR2).
 */
import type { BoundaryInput } from "../types.ts";

/** Build the notice that tells the model it is in pi now and which tools it has. */
export function buildBoundaryMessage(input: BoundaryInput): string {
	throw new Error("not implemented: buildBoundaryMessage");
}
