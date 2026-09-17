/**
 * Shared batch-safety rules for every mutation tool. Enforced twice by
 * design: once at the zod input schema (fast, clear MCP-level errors) and
 * again here (defense in depth, so the limit holds even if a schema is ever
 * loosened or a mutation function is ever called from somewhere new).
 */
export const MAX_MUTATION_UIDS = 25;

/**
 * Stricter ceiling for mail_delete_permanently (0.4.0): irreversible, so the
 * batch is capped far below the general mutation limit. See
 * `mutations/permanent-delete.ts`.
 */
export const MAX_PERMANENT_DELETE_UIDS = 5;

export function dedupeUids(uids: readonly number[]): number[] {
  return Array.from(new Set(uids));
}

export function assertBatchSize(uids: readonly number[], max: number = MAX_MUTATION_UIDS): void {
  if (uids.length === 0) {
    throw new Error('uids must not be empty.');
  }
  if (uids.length > max) {
    throw new Error(`At most ${max} uids are allowed per mutation call (got ${uids.length}).`);
  }
}
