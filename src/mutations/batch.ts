/**
 * Shared batch-safety rules for every mutation tool. Enforced twice by
 * design: once at the zod input schema (fast, clear MCP-level errors) and
 * again here (defense in depth, so the limit holds even if a schema is ever
 * loosened or a mutation function is ever called from somewhere new).
 */
export const MAX_MUTATION_UIDS = 25;

export function dedupeUids(uids: readonly number[]): number[] {
  return Array.from(new Set(uids));
}

export function assertBatchSize(uids: readonly number[]): void {
  if (uids.length === 0) {
    throw new Error('uids must not be empty.');
  }
  if (uids.length > MAX_MUTATION_UIDS) {
    throw new Error(
      `At most ${MAX_MUTATION_UIDS} uids are allowed per mutation call (got ${uids.length}).`,
    );
  }
}
