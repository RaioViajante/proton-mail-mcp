/**
 * Send-intent receipt replay guard (0.5.1).
 *
 * ## The problem
 *
 * A `sendIntentReceipt` is valid for its full
 * `SEND_INTENT_RECEIPT_TTL_MS` (15 minutes) window and, on its own, can be
 * presented to `mail_send` more than once — nothing about signature/expiry/
 * intent-match verification (`src/security/send-intent-receipt.ts`) detects
 * "this exact receipt already caused a submission". A caller retrying the
 * same live `mail_send` call (double-click, a buggy client, a compromised
 * intermediate step) with the same receipt could otherwise submit the same
 * message twice over SMTP.
 *
 * ## The decision (explicit, not implied)
 *
 * This project's MCP server process is genuinely stateless between restarts
 * — no database, no file-backed session store — but it *is* one long-running
 * process for the lifetime of one Claude Code session, and that lifetime is
 * exactly the window a real replay is most likely to happen in (an agent or
 * user re-invoking the same tool call). A minimal, auditable, in-memory
 * single-use marker for each receipt's `id` closes that real-world case
 * without introducing a persistent database. This module is deliberately
 * that and nothing more: a `Map` keyed by the receipt's random nonce,
 * bounded to the TTL window, cleared on every process restart.
 *
 * ## What this does NOT protect against (stated, not hidden)
 *
 * - **A server restart.** A receipt consumed just before a restart is, from
 *   this module's point of view, unconsumed again afterwards. The signature/
 *   expiry checks still bound the damage to the remaining TTL window, but
 *   within that window a restart resets this guard.
 * - **Two server processes running concurrently** against the same Bridge
 *   account and the same Keychain-provisioned signing secret (e.g. two
 *   separate Claude Code sessions each spawning their own MCP process). Each
 *   process has its own in-memory map; neither knows about the other's
 *   consumption. This is a real, accepted gap — see SECURITY.md
 *   ("Send-intent receipt replay") — not something this module claims to
 *   solve. Running more than one instance of this server against the same
 *   account is out of scope for 0.5.1.
 *
 * This is why `mail_send`'s live path treats a receipt as authorizing **at
 * most one submission attempt, ever** (not one success): the id is consumed
 * the moment receipt verification passes, before any SMTP connection is
 * even attempted, so a second call with the same receipt is refused
 * regardless of what happened to the first attempt. A caller that wants to
 * retry after any outcome — including a `failed`/`uncertain` one — must call
 * `mail_send_preview` again for a fresh receipt. See SECURITY.md ("Duplicate
 * sends are worse than an uncertain result") for why this project accepts
 * that inconvenience over the alternative.
 */

interface ConsumedEntry {
  /** Absolute ms timestamp after which this entry may be pruned — always `issuedAt + SEND_INTENT_RECEIPT_TTL_MS`, i.e. exactly when the receipt itself would have expired anyway. */
  expiresAt: number;
}

/** Module-level, in-memory, per-process only — see the module doc above for exactly what this does and does not guarantee. */
const consumedReceiptIds = new Map<string, ConsumedEntry>();

function pruneExpired(now: number): void {
  for (const [id, entry] of consumedReceiptIds) {
    if (entry.expiresAt <= now) {
      consumedReceiptIds.delete(id);
    }
  }
}

export interface ReceiptNonceConsumption {
  /** True the first (and only ever) time a given `id` is presented; false on any subsequent attempt with the same `id`. */
  consumed: boolean;
}

/**
 * Atomically checks-and-marks one receipt id as used. Synchronous and
 * side-effect-free beyond the module-level map, so there is no `await`
 * between the check and the mark — no window for a concurrent call to race
 * past it. Call this exactly once, right after a `sendIntentReceipt` passes
 * every other validation check, and before doing anything else toward a
 * live SMTP submission.
 */
export function consumeReceiptNonce(
  id: string,
  expiresAt: number,
  now: number = Date.now(),
): ReceiptNonceConsumption {
  pruneExpired(now);
  if (consumedReceiptIds.has(id)) {
    return { consumed: false };
  }
  consumedReceiptIds.set(id, { expiresAt });
  return { consumed: true };
}

/** Test-only: clears all in-memory state so tests never leak consumption across cases. Never called from production code. */
export function resetReplayGuardForTests(): void {
  consumedReceiptIds.clear();
}
