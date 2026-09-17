import type { ImapFlow, ListResponse } from 'imapflow';
import { LABELS_CONTAINER } from './policy.js';

/**
 * Proton labels are separate `Labels/<name>` mailboxes (see
 * `mutations/labels.ts`) — a message carries a label if and only if a
 * Message-ID-correlated copy of it currently exists in that mailbox. There is
 * no IMAP flag or single fetch that reports "all labels this message has";
 * the only way to enumerate them is to check membership in every label
 * mailbox individually. Used by `mutations/trash.ts` to capture
 * `originalLabels` / `labelsAfterTrash` — this project must never assume
 * labels survive a folder move (Trash included), only measure it.
 */
export function listLabelFolders(
  folders: readonly ListResponse[],
  delimiter: string,
): ListResponse[] {
  const prefix = `${LABELS_CONTAINER}${delimiter}`;
  return folders
    .filter((folder) => folder.path === LABELS_CONTAINER || folder.path.startsWith(prefix))
    .filter((folder) => folder.path !== LABELS_CONTAINER);
}

export function labelNameFromPath(path: string, delimiter: string): string {
  const prefix = `${LABELS_CONTAINER}${delimiter}`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * For each given Message-ID, resolves the set of label folder paths that
 * currently contain a correlated copy. Opens each label mailbox at most
 * once (read-only), regardless of how many message IDs are being checked
 * against it — cost is O(labelFolders) locks and O(labelFolders * messageIds)
 * SEARCH calls, bounded by the mutation batch limit (max 25 messages) and the
 * account's own label count.
 *
 * Returns a Map keyed by messageId (skips undefined IDs — nothing to
 * correlate). Never reads subject/body; SEARCH is always by `Message-ID`
 * header, the same correlation primitive `mutations/labels.ts` already uses.
 */
export async function resolveLabelMembership(
  client: ImapFlow,
  labelFolders: readonly ListResponse[],
  messageIds: readonly (string | undefined)[],
): Promise<Map<string, Set<string>>> {
  const ids = Array.from(new Set(messageIds.filter((id): id is string => Boolean(id))));
  const result = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  if (ids.length === 0 || labelFolders.length === 0) {
    return result;
  }

  for (const labelFolder of labelFolders) {
    const lock = await client.getMailboxLock(labelFolder.path, { readOnly: true });
    try {
      for (const id of ids) {
        const uids = await client.search({ header: { 'message-id': id } }, { uid: true });
        if (uids && uids.length > 0) {
          result.get(id)?.add(labelFolder.path);
        }
      }
    } finally {
      lock.release();
    }
  }

  return result;
}

/** Converts a Set of label paths into sorted logical names, for a sanitized public result. */
export function toSortedLabelNames(paths: ReadonlySet<string>, delimiter: string): string[] {
  return Array.from(paths, (path) => labelNameFromPath(path, delimiter)).sort();
}
