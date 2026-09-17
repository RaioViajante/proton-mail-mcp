import type { CopyResponseObject, ImapFlow } from 'imapflow';
import {
  type ReceiptRejectionReason,
  validateRestoreReceipt,
} from '../security/restore-receipt.js';
import { assertBatchSize, dedupeUids } from './batch.js';
import { fetchExistingUids } from './existence.js';
import {
  fetchPreservableFlags,
  flagsMissing,
  flagsUnexpected,
  preservableFlagsOf,
  PRESERVABLE_FLAGS,
  type PreservableFlag,
} from './flags.js';
import { applyLabel, labelPath } from './labels.js';
import {
  listLabelFolders,
  resolveLabelMembership,
  toSortedLabelNames,
} from './label-membership.js';
import {
  assertFolderExists,
  assertMoveDestinationAllowed,
  resolveMoveDestination,
  resolveSpecialFolders,
} from './policy.js';
import { createMutationResult, type MutationResult } from './result.js';
import { buildTransition, reconcileResultingUid } from './transitions.js';
import { classifyUncertainMove } from './uncertain-move.js';

/** Where a UID's preserved-state baseline came from (0.4.2). See module doc below. */
export type PreservationSource = 'restoreReceipt' | 'trashSnapshot' | 'unavailable';

export interface RestoreParams {
  uids: number[];
  /**
   * Destination folder. Required unless `restoreToOriginalSource` is used
   * (see below), in which case it must be omitted.
   */
  destinationFolder?: string | undefined;
  /**
   * EXTRA labels the caller explicitly wants guaranteed on the restored
   * message, in addition to — never instead of — the labels it already
   * carried in Trash. This project preserves the pre-move label set
   * automatically now; this parameter is no longer the only way labels
   * survive a restore. See `mutations/restore.ts` module doc.
   */
  labelsToRestore?: string[] | undefined;
  /**
   * Signed receipts (0.4.2) from `mail_trash`'s `restoreReceipts`, keyed by
   * the Trash-side UID they apply to. A UID with no matching entry here
   * falls back to `trashSnapshot` preservation (0.4.1 behavior, unchanged).
   * Each `receipt` is validated in full (structure, signature, identity)
   * before ever being trusted — see `validateRestoreReceipt` and
   * `receiptRejections` on the result.
   */
  restoreReceipts?: Array<{ uid: number; receipt: unknown }> | undefined;
  /**
   * HMAC signing secret for verifying receipts, from
   * `getReceiptSigningSecretOrUndefined()`. When `undefined`, any supplied
   * `restoreReceipts` entries are rejected (`signingSecretUnavailable`) —
   * never silently trusted unverified.
   */
  signingSecret?: Buffer | undefined;
  /**
   * When true, ignore `destinationFolder` (must be omitted) and instead
   * restore every matched UID to the `sourceFolder` recorded in its own
   * verified receipt. Scope note (documented limitation, not invented
   * behavior): only supported for a single-UID call — every matched UID
   * would need an individually verified receipt and, if they disagreed on
   * `sourceFolder`, an arbitrary batch-level tie-break, which this project
   * does not implement. See `resolveDestination` below.
   */
  restoreToOriginalSource?: boolean | undefined;
  dryRun: boolean;
  confirm: boolean;
  acknowledgeRestoreFromTrash: boolean;
}

export interface RestoreLabelOutcome {
  /** The original Trash-side UID the caller requested this restore for. */
  uid: number;
  label: string;
}
export interface RestoreLabelFailure extends RestoreLabelOutcome {
  reason: string;
}
export interface RestoreFlagOutcome {
  uid: number;
  flag: PreservableFlag;
}
export interface RestoreFlagFailure extends RestoreFlagOutcome {
  reason: string;
}
export interface RestoreLabelSnapshot {
  uid: number;
  labels: string[];
}
export interface RestoreFlagSnapshot {
  uid: number;
  flags: PreservableFlag[];
}
export interface RestorePreservationSourceEntry {
  uid: number;
  source: PreservationSource;
}
export interface RestoreStatePreservedEntry {
  uid: number;
  preserved: boolean;
}
export interface RestoreReceiptRejection {
  uid: number;
  reason: ReceiptRejectionReason;
}

export interface RestoreResult extends MutationResult {
  /** Alias of `changedUids`, named for this operation's own vocabulary. */
  moveRestored: number[];
  /**
   * Where each matched UID's preserved-state baseline came from (0.4.2).
   * `restoreReceipt` is the strong guarantee: a signed pre-Trash snapshot,
   * verified structure/signature/identity, immune to Trash's own state
   * decaying between `mail_trash` and this call. `trashSnapshot` is the
   * 0.4.1 fallback — Trash's current state, measured right now, which this
   * project does NOT treat as equivalent to the true original state (see
   * README.md "Async label loss: why Trash is not authoritative"; a message
   * can already have lost labels by the time this measurement happens).
   * `unavailable` means a receipt was supplied but rejected — fail closed,
   * meaning NEITHER the receipt NOR a trashSnapshot fallback is used for
   * that UID's repair; see `receiptRejections` for why.
   */
  preservationSource: RestorePreservationSourceEntry[];
  /**
   * True only for a UID whose baseline was `restoreReceipt`, whose
   * destination identity was confirmed, and whose repair had zero
   * `labelsFailed`/`flagsFailed` entries — the full round-trip guarantee
   * this project can actually back. A `trashSnapshot`-sourced UID is never
   * `true` here, even with a clean repair: this project cannot prove
   * `trashSnapshot` reflects state from before Trash, only state observed
   * during this call.
   */
  statePreserved: RestoreStatePreservedEntry[];
  /** One entry per UID whose supplied receipt failed validation. Reasons are stable codes — never receipt content. */
  receiptRejections?: RestoreReceiptRejection[];
  /**
   * Preservable flags (`\Seen`, `\Flagged`) used as this restore's baseline
   * for each matched UID — from the verified receipt when `preservationSource`
   * is `restoreReceipt`, from Trash's current state otherwise. Absent for a
   * UID whose `preservationSource` is `unavailable` (no trusted baseline).
   */
  originalFlags?: RestoreFlagSnapshot[];
  /** Same flags, re-measured in the destination folder after a live move — only for a destination identity confirmed without guessing. */
  flagsAfterMove?: RestoreFlagSnapshot[];
  /** Flags automatically re-added/removed to match `originalFlags` after a divergence was detected. */
  flagsRestored?: RestoreFlagOutcome[];
  flagsFailed?: RestoreFlagFailure[];
  /**
   * Labels used as this restore's baseline for each matched UID — see
   * `originalFlags` above for the same receipt-vs-trashSnapshot-vs-unavailable
   * semantics.
   */
  originalLabels?: RestoreLabelSnapshot[];
  /** Same labels, re-measured after a live move. */
  labelsAfterMove?: RestoreLabelSnapshot[];
  /** Labels automatically reapplied — the union of auto-detected missing labels and requested `labelsToRestore` extras. */
  labelsRestored?: RestoreLabelOutcome[];
  labelsFailed?: RestoreLabelFailure[];
  /** Labels present after the move that were NOT present before it. Reported only — never removed automatically. */
  labelsUnexpected?: RestoreLabelSnapshot[];
  /** The `labelsToRestore` extras this call was given, deduplicated. Absent when none were given. */
  labelsRequested?: string[];
  /**
   * True once any part of this call (the folder move, a post-move
   * verification fetch, or a label/flag repair) could not confirm the
   * message's destination identity or current state without guessing.
   * Absent for dry-run, since nothing executed yet to be uncertain about.
   */
  requiresRefresh?: boolean;
  /**
   * True whenever the live outcome deviated in any way from a full, clean
   * success — a folder-move error, an unresolved `requiresRefresh`, or a
   * failed flag/label repair. False only when the move completed, every
   * preservable flag and every original/extra label ended up exactly as
   * intended, with zero unresolved uncertainty. Absent for dry-run.
   */
  partialSuccess?: boolean;
}

interface ResolvedTrashMessage {
  uid: number;
  messageId: string | undefined;
  flags: PreservableFlag[];
}

async function resolveTrashMessages(
  client: ImapFlow,
  trashFolder: string,
  uids: readonly number[],
): Promise<ResolvedTrashMessage[]> {
  const requested = new Set(uids);
  const lock = await client.getMailboxLock(trashFolder, { readOnly: true });
  try {
    const resolved: ResolvedTrashMessage[] = [];
    for await (const message of client.fetch(
      [...uids],
      { uid: true, envelope: true, flags: true },
      { uid: true },
    )) {
      if (requested.has(message.uid)) {
        resolved.push({
          uid: message.uid,
          messageId: message.envelope?.messageId,
          flags: preservableFlagsOf(message.flags),
        });
      }
    }
    return resolved;
  } finally {
    lock.release();
  }
}

function finalizeLiveResult(result: RestoreResult): RestoreResult {
  result.partialSuccess =
    result.errors.length > 0 ||
    (result.labelsFailed?.length ?? 0) > 0 ||
    (result.flagsFailed?.length ?? 0) > 0 ||
    result.requiresRefresh === true;
  return result;
}

interface RepairOutcome<T> {
  restored: T[];
  failed: Array<T & { reason: string }>;
}

/**
 * Re-adds or re-removes one preservable flag for a set of already-confirmed
 * `(requestedUid, resultingUid)` pairs, in `destinationFolder`. Follows the
 * same write-lock revalidation every other mutation in this project
 * follows: a `resultingUid` confirmed moments ago during verification may
 * have vanished by the time this write executes. Never throws — a thrown
 * `messageFlagsAdd`/`messageFlagsRemove` (including a mid-repair
 * disconnect) is reported as `flagsFailed`, never left to crash the whole
 * restore after the folder move already succeeded.
 */
async function repairFlag(
  client: ImapFlow,
  destinationFolder: string,
  flag: PreservableFlag,
  targets: ReadonlyArray<{ requestedUid: number; resultingUid: number }>,
  add: boolean,
): Promise<RepairOutcome<RestoreFlagOutcome>> {
  const restored: RestoreFlagOutcome[] = [];
  const failed: RestoreFlagFailure[] = [];
  const requestedByResulting = new Map(targets.map((t) => [t.resultingUid, t.requestedUid]));

  const lock = await client.getMailboxLock(destinationFolder, { readOnly: false });
  try {
    const resultingUids = targets.map((t) => t.resultingUid);
    const stillPresent = await fetchExistingUids(client, resultingUids);
    const finalTargets = resultingUids.filter((uid) => stillPresent.has(uid));
    const staleTargets = resultingUids.filter((uid) => !stillPresent.has(uid));
    for (const staleUid of staleTargets) {
      const requestedUid = requestedByResulting.get(staleUid);
      if (requestedUid !== undefined) {
        failed.push({
          uid: requestedUid,
          flag,
          reason: 'Message was no longer found in the destination folder when repairing this flag.',
        });
      }
    }
    if (finalTargets.length === 0) {
      return { restored, failed };
    }

    const method = add
      ? client.messageFlagsAdd.bind(client)
      : client.messageFlagsRemove.bind(client);
    const ok = await method(finalTargets, [flag], { uid: true });
    for (const resultingUid of finalTargets) {
      const requestedUid = requestedByResulting.get(resultingUid);
      if (requestedUid === undefined) {
        continue;
      }
      if (ok) {
        restored.push({ uid: requestedUid, flag });
      } else {
        failed.push({ uid: requestedUid, flag, reason: 'IMAP server rejected the flag change.' });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown IMAP error.';
    for (const target of targets) {
      failed.push({ uid: target.requestedUid, flag, reason: message });
    }
  } finally {
    lock.release();
  }

  return { restored, failed };
}

interface UidBaseline {
  uid: number;
  labels: string[] | undefined;
  flags: PreservableFlag[] | undefined;
  source: PreservationSource;
  receiptSourceFolder: string | undefined;
}

/**
 * Resolves each matched UID's preserved-state baseline (0.4.2) — the
 * authoritative "what did this message look like before it was ever
 * trashed" this restore will repair towards. Order of preference:
 *
 * 1. A caller-supplied receipt for this UID, IF it validates in full
 *    (structure, signature, identity — see `validateRestoreReceipt`).
 *    `source: 'restoreReceipt'`.
 * 2. No receipt was supplied for this UID at all: fall back to measuring
 *    Trash's current state, exactly as 0.4.1 always did. `source:
 *    'trashSnapshot'` — a real measurement, just not proven to predate any
 *    async state loss Trash may already have suffered.
 * 3. A receipt WAS supplied but failed validation: fail closed.
 *    `source: 'unavailable'` — neither the (untrusted) receipt nor a
 *    trashSnapshot fallback is used; this project does not know what
 *    "original" means for this UID, and says so rather than guessing.
 */
function resolveBaselines(
  matchedUids: readonly number[],
  receiptsByUid: ReadonlyMap<number, unknown>,
  signingSecret: Buffer | undefined,
  messageIdByUid: ReadonlyMap<number, string | undefined>,
  trashLabelsByUid: ReadonlyMap<number, string[]>,
  trashFlagsByUid: ReadonlyMap<number, PreservableFlag[]>,
): { baselines: Map<number, UidBaseline>; rejections: RestoreReceiptRejection[] } {
  const baselines = new Map<number, UidBaseline>();
  const rejections: RestoreReceiptRejection[] = [];

  for (const uid of matchedUids) {
    const rawReceipt = receiptsByUid.get(uid);
    if (rawReceipt === undefined) {
      baselines.set(uid, {
        uid,
        labels: trashLabelsByUid.get(uid) ?? [],
        flags: trashFlagsByUid.get(uid) ?? [],
        source: 'trashSnapshot',
        receiptSourceFolder: undefined,
      });
      continue;
    }

    const validation = validateRestoreReceipt(rawReceipt, signingSecret, messageIdByUid.get(uid));
    if (!validation.valid) {
      rejections.push({ uid, reason: validation.reason });
      baselines.set(uid, {
        uid,
        labels: undefined,
        flags: undefined,
        source: 'unavailable',
        receiptSourceFolder: undefined,
      });
      continue;
    }

    baselines.set(uid, {
      uid,
      labels: Array.from(new Set(validation.receipt.originalLabels)).sort(),
      flags: validation.receipt.originalFlags,
      source: 'restoreReceipt',
      receiptSourceFolder: validation.receipt.sourceFolder,
    });
  }

  return { baselines, rejections };
}

/**
 * Restores explicit UIDs from Trash into an explicit destination folder.
 *
 * ## Durable restore receipts (0.4.2)
 *
 * A live finding against 0.4.1 showed Trash itself is not an authoritative
 * source for a message's pre-Trash state: Proton Bridge can drop labels
 * *asynchronously*, after `mail_trash`'s own immediate post-move check
 * already reported them intact — by the time a later `mail_restore_from_trash`
 * call measured Trash's "before" state, the labels were already gone, and
 * 0.4.1's automatic preservation had nothing left to restore. This version
 * accepts back the signed `restoreReceipts` `mail_trash` issues at move
 * time — captured before any possible async decay — and, once each one is
 * fully verified (structure, HMAC signature, and a keyed Message-ID
 * fingerprint match against the live Trash message — see
 * `src/security/restore-receipt.ts`), treats it as the authoritative
 * baseline in place of whatever Trash happens to show right now. A UID with
 * no matching receipt falls back to 0.4.1's `trashSnapshot` behavior; a UID
 * whose supplied receipt fails validation fails closed (`unavailable`) —
 * see `resolveBaselines` above and `preservationSource` /
 * `receiptRejections` on the result.
 *
 * ## State-preserving restore (0.4.1, retained unchanged)
 *
 * Before any move, this snapshots each matched message's baseline (per the
 * above) and its currently observed Trash label membership (always, for
 * `labelsAfterMove` diffing regardless of source); after a live move (and
 * only for a destination identity confirmed via the same
 * UIDPLUS-verified-then-Message-ID reconciliation every other transition in
 * this project uses — never a guess), it re-measures both and automatically
 * repairs any divergence from the baseline: a label that disappeared is
 * reapplied (never created), a flag that flipped is flipped back.
 * `labelsToRestore` means EXTRA labels the caller wants guaranteed, on top
 * of automatic preservation, unioned and deduplicated with it.
 *
 * The folder move and any repair are still separate IMAP operations, never
 * presented as atomic: a label/flag repair failure never rolls back the
 * move — the result reports the outcome explicitly via `labelsFailed`/
 * `flagsFailed`/`requiresRefresh`/`partialSuccess`, never hidden. Repair is
 * gated strictly on a confirmed, freshly-reverified destination identity —
 * an unconfirmed or vanished UID is never guessed at, and this project
 * never retries the folder move itself after an uncertain outcome (see
 * `mutations/uncertain-move.ts`).
 */
export async function restoreFromTrash(
  client: ImapFlow,
  {
    uids,
    destinationFolder: rawDestination,
    labelsToRestore,
    restoreReceipts,
    signingSecret,
    restoreToOriginalSource,
    dryRun,
    confirm,
    acknowledgeRestoreFromTrash,
  }: RestoreParams,
): Promise<RestoreResult> {
  if (!dryRun && (!confirm || !acknowledgeRestoreFromTrash)) {
    throw new Error(
      'confirm=true and acknowledgeRestoreFromTrash=true are both required together with ' +
        'dryRun=false for mail_restore_from_trash.',
    );
  }

  const deduped = dedupeUids(uids);
  assertBatchSize(deduped);

  if (restoreToOriginalSource) {
    if (rawDestination !== undefined) {
      throw new Error('destinationFolder must be omitted when restoreToOriginalSource is true.');
    }
    if (deduped.length !== 1) {
      throw new Error(
        'restoreToOriginalSource is only supported for a single UID per call (documented scope ' +
          'limitation — see mutations/restore.ts).',
      );
    }
  } else if (rawDestination === undefined) {
    throw new Error('destinationFolder is required unless restoreToOriginalSource is true.');
  }

  const folders = await client.list();
  const special = resolveSpecialFolders(folders);
  if (!special.trash) {
    throw new Error('Could not find a Trash folder on this account.');
  }
  const delimiter = folders[0]?.delimiter ?? '/';

  // labelsToRestore are EXTRAS only (0.4.1): validated to exist and rejected
  // up front, before any mutation — dry-run or live — rather than deferred
  // to a post-hoc labelsFailed report. Never created automatically.
  const dedupedExtras = Array.from(new Set(labelsToRestore ?? []));
  for (const label of dedupedExtras) {
    if (!folders.some((folder) => folder.path === labelPath(label))) {
      throw new Error(
        `labelsToRestore label "${label}" does not exist; it is never created automatically. ` +
          'Create it first with mail_create_label, or omit it.',
      );
    }
  }

  // Destination resolution/validation for the normal (explicit
  // destinationFolder) case happens here — before Trash is ever touched —
  // exactly as it did pre-0.4.2, so a bad destination still fails fast
  // without a wasted Trash resolution. restoreToOriginalSource defers this
  // until a verified receipt's sourceFolder is available; see below.
  let destinationFolder: string | undefined;
  if (!restoreToOriginalSource) {
    destinationFolder = resolveMoveDestination(special, rawDestination as string, delimiter);
    assertMoveDestinationAllowed(special, destinationFolder);
    assertFolderExists(folders, destinationFolder, 'destination folder');
  }

  const result = createMutationResult('mail_restore_from_trash', dryRun, uids) as RestoreResult;
  result.moveRestored = [];
  result.preservationSource = [];
  result.statePreserved = [];
  if (dedupedExtras.length > 0) {
    result.labelsRequested = dedupedExtras;
  }

  const resolved = await resolveTrashMessages(client, special.trash, deduped);
  const resolvedSet = new Set(resolved.map((message) => message.uid));
  result.matchedUids = deduped.filter((uid) => resolvedSet.has(uid));
  result.missingUids = deduped.filter((uid) => !resolvedSet.has(uid));

  if (result.matchedUids.length === 0) {
    return result;
  }

  const labelFolders = listLabelFolders(folders, delimiter);
  const messageIdByUid = new Map(resolved.map((message) => [message.uid, message.messageId]));
  const trashFlagsByUid = new Map(resolved.map((message) => [message.uid, message.flags]));

  // Captured before any mutation, unconditionally (dry-run or live): what
  // labels each matched message currently carries in Trash. This is always
  // computed — it's the trashSnapshot fallback baseline AND the point of
  // comparison for labelsAfterMove/labelsUnexpected regardless of which
  // preservationSource a UID ends up using.
  const beforeMembership = await resolveLabelMembership(
    client,
    labelFolders,
    result.matchedUids.map((uid) => messageIdByUid.get(uid)),
  );
  const trashLabelsByUid = new Map<number, string[]>();
  for (const uid of result.matchedUids) {
    const messageId = messageIdByUid.get(uid);
    const paths = messageId
      ? (beforeMembership.get(messageId) ?? new Set<string>())
      : new Set<string>();
    trashLabelsByUid.set(uid, toSortedLabelNames(paths, delimiter));
  }

  const receiptsByUid = new Map<number, unknown>();
  for (const entry of restoreReceipts ?? []) {
    if (!receiptsByUid.has(entry.uid)) {
      receiptsByUid.set(entry.uid, entry.receipt);
    }
  }
  const { baselines, rejections } = resolveBaselines(
    result.matchedUids,
    receiptsByUid,
    signingSecret,
    messageIdByUid,
    trashLabelsByUid,
    trashFlagsByUid,
  );
  if (rejections.length > 0) {
    result.receiptRejections = rejections;
  }

  const originalLabelsByUid = new Map<number, string[]>();
  const originalFlagsByUid = new Map<number, PreservableFlag[]>();
  result.originalFlags = [];
  result.originalLabels = [];
  for (const uid of result.matchedUids) {
    const baseline = baselines.get(uid);
    result.preservationSource.push({ uid, source: baseline?.source ?? 'unavailable' });
    if (baseline?.labels !== undefined) {
      originalLabelsByUid.set(uid, baseline.labels);
      result.originalLabels.push({ uid, labels: baseline.labels });
    }
    if (baseline?.flags !== undefined) {
      originalFlagsByUid.set(uid, baseline.flags);
      result.originalFlags.push({ uid, flags: baseline.flags });
    }
  }

  // restoreToOriginalSource destination resolution: the sole matched uid's
  // verified receipt sourceFolder, resolved and validated through the exact
  // same policy an explicit destinationFolder would go through — a receipt
  // never forces a destination that bypasses it.
  if (restoreToOriginalSource) {
    const onlyUid = result.matchedUids[0];
    const baseline = onlyUid !== undefined ? baselines.get(onlyUid) : undefined;
    if (!baseline || baseline.source !== 'restoreReceipt' || !baseline.receiptSourceFolder) {
      throw new Error(
        'restoreToOriginalSource requires a fully verified restoreReceipt for the matched UID, ' +
          'with its sourceFolder — none was available.',
      );
    }
    destinationFolder = resolveMoveDestination(special, baseline.receiptSourceFolder, delimiter);
    assertMoveDestinationAllowed(special, destinationFolder);
    assertFolderExists(folders, destinationFolder, 'destination folder');
  }
  const resolvedDestinationFolder = destinationFolder as string;

  if (dryRun) {
    return result;
  }

  let moveResponse: CopyResponseObject | false | undefined;
  let uncertainUids: number[] = [];
  let threwException = false;

  const writeLock = await client.getMailboxLock(special.trash, { readOnly: false });
  try {
    // Revalidate immediately after acquiring the write lock: a UID resolved
    // moments ago under the read-only lock may have been moved/deleted by
    // another client in the gap. Selection can only shrink here, never grow.
    const stillPresent = await fetchExistingUids(client, result.matchedUids);
    const staleUids = result.matchedUids.filter((uid) => !stillPresent.has(uid));
    if (staleUids.length > 0) {
      result.matchedUids = result.matchedUids.filter((uid) => stillPresent.has(uid));
      result.missingUids = [...result.missingUids, ...staleUids];
      const staleSet = new Set(staleUids);
      result.originalFlags = result.originalFlags.filter((entry) => !staleSet.has(entry.uid));
      result.originalLabels = result.originalLabels.filter((entry) => !staleSet.has(entry.uid));
      result.preservationSource = result.preservationSource.filter(
        (entry) => !staleSet.has(entry.uid),
      );
    }

    if (result.matchedUids.length === 0) {
      return result;
    }

    try {
      moveResponse = await client.messageMove(result.matchedUids, resolvedDestinationFolder, {
        uid: true,
      });
    } catch (error) {
      // The command may have reached the server before the connection or
      // response was lost — never assume a clean failure (see
      // mutations/uncertain-move.ts).
      threwException = true;
      const classification = await classifyUncertainMove(
        client,
        special.trash,
        resolvedDestinationFolder,
        result.matchedUids.map((uid) => ({ uid, messageId: messageIdByUid.get(uid) })),
      );
      uncertainUids = classification.uncertain;
      result.changedUids = classification.moved;
      for (const uid of classification.notMoved) {
        result.errors.push({
          uid,
          message: error instanceof Error ? error.message : 'Unknown IMAP error.',
        });
      }
      for (const uid of classification.uncertain) {
        result.errors.push({
          uid,
          message:
            'The restore command failed or the connection dropped, and it could not be confirmed ' +
            'read-only whether the message actually moved. Re-check with mail_search before ' +
            'retrying — this was not retried automatically.',
        });
      }
      moveResponse = undefined;
    }
    if (moveResponse) {
      result.changedUids = [...result.matchedUids];
    } else if (!threwException) {
      for (const uid of result.matchedUids) {
        result.errors.push({ uid, message: 'IMAP server rejected the restore.' });
      }
    }
  } finally {
    writeLock.release();
  }

  result.moveRestored = [...result.changedUids];
  result.requiresRefresh = uncertainUids.length > 0;

  if (result.changedUids.length === 0) {
    return finalizeLiveResult(result);
  }

  try {
    // Resolve post-move UID transitions — server UIDPLUS mapping, verified,
    // then Message-ID correlation, never a guess.
    const uidMap = moveResponse ? moveResponse.uidMap : undefined;
    const transitions = [];
    const confirmed: Array<{ requestedUid: number; resultingUid: number }> = [];
    for (const uid of result.changedUids) {
      const resultingUid = await reconcileResultingUid(
        client,
        resolvedDestinationFolder,
        uid,
        uidMap,
        messageIdByUid.get(uid),
      );
      transitions.push(
        buildTransition(uid, special.trash, resolvedDestinationFolder, false, resultingUid),
      );
      if (resultingUid !== undefined) {
        confirmed.push({ requestedUid: uid, resultingUid });
      } else {
        result.requiresRefresh = true;
      }
    }
    result.transitions = transitions;

    // Label measurement is Message-ID correlation alone — safe to compute
    // for every changed UID regardless of whether its destination identity
    // was confirmed, and regardless of preservationSource.
    const afterMembership = await resolveLabelMembership(
      client,
      labelFolders,
      result.changedUids.map((uid) => messageIdByUid.get(uid)),
    );
    result.labelsAfterMove = [];
    result.labelsUnexpected = [];
    const labelsMissingByUid = new Map<number, string[]>();
    for (const uid of result.changedUids) {
      const messageId = messageIdByUid.get(uid);
      const afterPaths = messageId
        ? (afterMembership.get(messageId) ?? new Set<string>())
        : new Set<string>();
      const afterLabels = toSortedLabelNames(afterPaths, delimiter);
      result.labelsAfterMove.push({ uid, labels: afterLabels });

      const originalLabels = originalLabelsByUid.get(uid);
      if (originalLabels === undefined) {
        // preservationSource 'unavailable': no trusted baseline to diff
        // against — never claim something is "missing" or "unexpected"
        // when this project doesn't actually know what was expected.
        continue;
      }
      const afterSet = new Set(afterLabels);
      labelsMissingByUid.set(
        uid,
        originalLabels.filter((label) => !afterSet.has(label)),
      );
      const originalSet = new Set(originalLabels);
      const unexpected = afterLabels.filter((label) => !originalSet.has(label));
      if (unexpected.length > 0) {
        result.labelsUnexpected.push({ uid, labels: unexpected });
      }
    }

    // Flag measurement needs a confirmed resultingUid — flags are a
    // property of one specific mailbox/UID pair, not correlatable purely by
    // Message-ID. A uid whose identity wasn't confirmed, or whose
    // destination copy has vanished by verification time, is never guessed
    // at: it is left unmeasured and unrepaired, requiresRefresh instead.
    result.flagsAfterMove = [];
    const flagsMissingByUid = new Map<number, PreservableFlag[]>();
    const flagsUnexpectedByUid = new Map<number, PreservableFlag[]>();
    const verified: Array<{ requestedUid: number; resultingUid: number }> = [];
    for (const { requestedUid, resultingUid } of confirmed) {
      const fetched = await fetchPreservableFlags(client, resolvedDestinationFolder, resultingUid);
      if (fetched === undefined) {
        result.requiresRefresh = true;
        continue;
      }
      verified.push({ requestedUid, resultingUid });
      result.flagsAfterMove.push({ uid: requestedUid, flags: fetched });

      const original = originalFlagsByUid.get(requestedUid);
      if (original === undefined) {
        // preservationSource 'unavailable' — measured, never repaired.
        continue;
      }
      const missing = flagsMissing(original, fetched);
      const unexpected = flagsUnexpected(original, fetched);
      if (missing.length > 0) {
        flagsMissingByUid.set(requestedUid, missing);
      }
      if (unexpected.length > 0) {
        flagsUnexpectedByUid.set(requestedUid, unexpected);
      }
    }

    // AUTOMATIC REPAIR — only for uids in `verified` (confirmed destination
    // identity) AND whose preservationSource is trusted enough to have a
    // baseline at all (originalFlagsByUid/originalLabelsByUid only contain
    // entries for 'restoreReceipt'/'trashSnapshot' — 'unavailable' UIDs
    // were never added to either map, so they naturally fall out of every
    // repair computation below without needing an extra branch).
    const labelsRestored: RestoreLabelOutcome[] = [];
    const labelsFailed: RestoreLabelFailure[] = [];
    const flagsRestored: RestoreFlagOutcome[] = [];
    const flagsFailed: RestoreFlagFailure[] = [];

    for (const flag of PRESERVABLE_FLAGS) {
      const toAdd = verified.filter((target) =>
        (flagsMissingByUid.get(target.requestedUid) ?? []).includes(flag),
      );
      const toRemove = verified.filter((target) =>
        (flagsUnexpectedByUid.get(target.requestedUid) ?? []).includes(flag),
      );
      if (toAdd.length > 0) {
        const outcome = await repairFlag(client, resolvedDestinationFolder, flag, toAdd, true);
        flagsRestored.push(...outcome.restored);
        flagsFailed.push(...outcome.failed);
      }
      if (toRemove.length > 0) {
        const outcome = await repairFlag(client, resolvedDestinationFolder, flag, toRemove, false);
        flagsRestored.push(...outcome.restored);
        flagsFailed.push(...outcome.failed);
      }
    }

    // Labels to reapply = union of auto-detected missing labels and
    // requested extras, deduplicated per uid, applied only to `verified`
    // uids — extras are never applied to a uid whose identity wasn't
    // confirmed either.
    const labelsToApplyByUid = new Map<number, Set<string>>();
    for (const { requestedUid } of verified) {
      const need = new Set<string>(labelsMissingByUid.get(requestedUid) ?? []);
      for (const extra of dedupedExtras) {
        need.add(extra);
      }
      if (need.size > 0) {
        labelsToApplyByUid.set(requestedUid, need);
      }
    }
    const uidsByLabel = new Map<string, number[]>();
    for (const [requestedUid, labels] of labelsToApplyByUid) {
      for (const label of labels) {
        uidsByLabel.set(label, [...(uidsByLabel.get(label) ?? []), requestedUid]);
      }
    }

    if (uidsByLabel.size > 0) {
      // Re-list immediately before reapplying: confirms each label still
      // exists as a mailbox right now, not from the listing fetched at the
      // top of this call. Labels are never auto-created — including a
      // label a valid receipt says was originally present but has since
      // been deleted from the account entirely.
      const freshFolders = await client.list();
      const resultingUidByRequestedUid = new Map(
        verified.map((target) => [target.requestedUid, target.resultingUid]),
      );
      for (const [label, requestedUids] of uidsByLabel) {
        const labelExists = freshFolders.some((folder) => folder.path === labelPath(label));
        if (!labelExists) {
          for (const requestedUid of requestedUids) {
            labelsFailed.push({
              uid: requestedUid,
              label,
              reason: 'Label mailbox no longer exists; not reapplied automatically.',
            });
          }
          continue;
        }

        const resultingUids = requestedUids.map(
          (requestedUid) => resultingUidByRequestedUid.get(requestedUid) as number,
        );
        const resultingToRequestedUid = new Map(
          requestedUids.map((requestedUid) => [
            resultingUidByRequestedUid.get(requestedUid) as number,
            requestedUid,
          ]),
        );
        try {
          const applyResult = await applyLabel(client, {
            folder: resolvedDestinationFolder,
            label,
            uids: resultingUids,
            dryRun: false,
          });
          for (const resultingUid of [...applyResult.changedUids, ...applyResult.skippedUids]) {
            const requestedUid = resultingToRequestedUid.get(resultingUid);
            if (requestedUid !== undefined) {
              labelsRestored.push({ uid: requestedUid, label });
            }
          }
          for (const error of applyResult.errors) {
            const requestedUid = resultingToRequestedUid.get(error.uid);
            if (requestedUid !== undefined) {
              labelsFailed.push({ uid: requestedUid, label, reason: error.message });
            }
          }
          for (const missingUid of applyResult.missingUids) {
            const requestedUid = resultingToRequestedUid.get(missingUid);
            if (requestedUid !== undefined) {
              labelsFailed.push({
                uid: requestedUid,
                label,
                reason: 'Message was not found in the destination folder when applying the label.',
              });
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error applying label.';
          for (const requestedUid of requestedUids) {
            labelsFailed.push({ uid: requestedUid, label, reason: message });
          }
        }
      }
    }

    // Uids whose identity was never confirmed/verified still had labels to
    // reconcile (auto-detected missing, or requested extras) — reported as
    // failed rather than silently skipped, never guessed at.
    const verifiedRequestedUids = new Set(verified.map((target) => target.requestedUid));
    for (const uid of result.changedUids) {
      if (verifiedRequestedUids.has(uid)) {
        continue;
      }
      const need = new Set<string>(labelsMissingByUid.get(uid) ?? []);
      for (const extra of dedupedExtras) {
        need.add(extra);
      }
      for (const label of need) {
        labelsFailed.push({
          uid,
          label,
          reason:
            'Destination identity not confirmed (requiresRefresh); label not applied automatically.',
        });
      }
    }

    result.labelsRestored = labelsRestored;
    result.labelsFailed = labelsFailed;
    result.flagsRestored = flagsRestored;
    result.flagsFailed = flagsFailed;

    // statePreserved (0.4.2): the full round-trip guarantee this project can
    // actually back — restoreReceipt-sourced, identity-confirmed, and zero
    // repair failures for that specific uid. trashSnapshot and unavailable
    // are never true here, even with a clean repair — see the field's doc
    // comment on RestoreResult above.
    const labelsFailedUids = new Set(labelsFailed.map((entry) => entry.uid));
    const flagsFailedUids = new Set(flagsFailed.map((entry) => entry.uid));
    for (const uid of result.matchedUids) {
      const source = baselines.get(uid)?.source ?? 'unavailable';
      const preserved =
        source === 'restoreReceipt' &&
        verifiedRequestedUids.has(uid) &&
        !labelsFailedUids.has(uid) &&
        !flagsFailedUids.has(uid);
      result.statePreserved.push({ uid, preserved });
    }
  } catch (error) {
    // A reconnect/failure anywhere in verification or repair must never
    // swallow a folder move that already succeeded — report the
    // uncertainty and return what was accomplished, never re-throw past
    // this point and never retry the move.
    result.requiresRefresh = true;
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown error during post-move verification/repair.';
    for (const uid of result.changedUids) {
      result.errors.push({ uid, message: `Post-move verification/repair incomplete: ${message}` });
    }
    for (const uid of result.matchedUids) {
      if (!result.statePreserved.some((entry) => entry.uid === uid)) {
        result.statePreserved.push({ uid, preserved: false });
      }
    }
  }

  return finalizeLiveResult(result);
}
