import { describe, expect, it } from 'vitest';
import { MAX_MUTATION_UIDS, MAX_PERMANENT_DELETE_UIDS } from '../src/mutations/batch.js';
import { PERMANENT_DELETE_CONFIRMATION_PHRASE } from '../src/mutations/permanent-delete.js';
import { inputSchema as deletePermanentlySchema } from '../src/tools/delete-permanently.js';
import { inputSchema as restoreSchema } from '../src/tools/restore-from-trash.js';
import { inputSchema as trashSchema } from '../src/tools/trash.js';

describe('mail_trash input schema', () => {
  it('defaults dryRun to true and both confirmations to false', () => {
    const result = trashSchema.parse({ sourceFolder: 'INBOX', uids: [1] });
    expect(result.dryRun).toBe(true);
    expect(result.confirm).toBe(false);
    expect(result.acknowledgeTrashMove).toBe(false);
  });

  it('accepts explicit live intent with both confirmations', () => {
    const result = trashSchema.parse({
      sourceFolder: 'INBOX',
      uids: [1],
      dryRun: false,
      confirm: true,
      acknowledgeTrashMove: true,
    });
    expect(result.dryRun).toBe(false);
    expect(result.confirm).toBe(true);
    expect(result.acknowledgeTrashMove).toBe(true);
  });

  it('rejects an empty uids array', () => {
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids: [] }).success).toBe(false);
  });

  it(`rejects more than ${MAX_MUTATION_UIDS} uids`, () => {
    const uids = Array.from({ length: MAX_MUTATION_UIDS + 1 }, (_, i) => i + 1);
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids }).success).toBe(false);
  });

  it(`accepts exactly ${MAX_MUTATION_UIDS} uids`, () => {
    const uids = Array.from({ length: MAX_MUTATION_UIDS }, (_, i) => i + 1);
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids }).success).toBe(true);
  });

  it('rejects a non-integer or non-positive uid (no wildcard/sentinel value accepted)', () => {
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids: [1.5] }).success).toBe(false);
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids: [0] }).success).toBe(false);
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids: [-1] }).success).toBe(false);
    expect(trashSchema.safeParse({ sourceFolder: 'INBOX', uids: ['*'] }).success).toBe(false);
  });

  it('requires sourceFolder', () => {
    expect(trashSchema.safeParse({ uids: [1] }).success).toBe(false);
  });
});

describe('mail_restore_from_trash input schema', () => {
  it('defaults dryRun to true and both confirmations to false, labelsToRestore optional', () => {
    const result = restoreSchema.parse({ uids: [1], destinationFolder: 'INBOX' });
    expect(result.dryRun).toBe(true);
    expect(result.confirm).toBe(false);
    expect(result.acknowledgeRestoreFromTrash).toBe(false);
    expect(result.labelsToRestore).toBeUndefined();
  });

  it('accepts explicit live intent with labelsToRestore', () => {
    const result = restoreSchema.parse({
      uids: [1],
      destinationFolder: 'INBOX',
      labelsToRestore: ['Work', 'Personal'],
      dryRun: false,
      confirm: true,
      acknowledgeRestoreFromTrash: true,
    });
    expect(result.labelsToRestore).toEqual(['Work', 'Personal']);
  });

  it('requires uids and destinationFolder', () => {
    expect(restoreSchema.safeParse({}).success).toBe(false);
    expect(restoreSchema.safeParse({ uids: [1] }).success).toBe(false);
    expect(restoreSchema.safeParse({ destinationFolder: 'INBOX' }).success).toBe(false);
  });

  it(`rejects more than ${MAX_MUTATION_UIDS} uids`, () => {
    const uids = Array.from({ length: MAX_MUTATION_UIDS + 1 }, (_, i) => i + 1);
    expect(restoreSchema.safeParse({ uids, destinationFolder: 'INBOX' }).success).toBe(false);
  });

  it('rejects an empty label string in labelsToRestore', () => {
    expect(
      restoreSchema.safeParse({ uids: [1], destinationFolder: 'INBOX', labelsToRestore: [''] })
        .success,
    ).toBe(false);
  });
});

describe('mail_delete_permanently input schema', () => {
  it('defaults dryRun to true, both confirmations to false, confirmationPhrase to empty', () => {
    const result = deletePermanentlySchema.parse({ sourceFolder: 'Trash', uids: [1] });
    expect(result.dryRun).toBe(true);
    expect(result.confirm).toBe(false);
    expect(result.acknowledgePermanentDeletion).toBe(false);
    expect(result.confirmationPhrase).toBe('');
  });

  it('accepts explicit live intent with the exact confirmation phrase', () => {
    const result = deletePermanentlySchema.parse({
      sourceFolder: 'Trash',
      uids: [1],
      dryRun: false,
      confirm: true,
      acknowledgePermanentDeletion: true,
      confirmationPhrase: PERMANENT_DELETE_CONFIRMATION_PHRASE,
    });
    expect(result.confirmationPhrase).toBe(PERMANENT_DELETE_CONFIRMATION_PHRASE);
  });

  it(`rejects more than ${MAX_PERMANENT_DELETE_UIDS} uids`, () => {
    const uids = Array.from({ length: MAX_PERMANENT_DELETE_UIDS + 1 }, (_, i) => i + 1);
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids }).success).toBe(false);
  });

  it(`accepts exactly ${MAX_PERMANENT_DELETE_UIDS} uids`, () => {
    const uids = Array.from({ length: MAX_PERMANENT_DELETE_UIDS }, (_, i) => i + 1);
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids }).success).toBe(true);
  });

  it('rejects an empty uids array and a non-positive/non-integer uid', () => {
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids: [] }).success).toBe(
      false,
    );
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids: [0] }).success).toBe(
      false,
    );
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids: [1.5] }).success).toBe(
      false,
    );
    expect(deletePermanentlySchema.safeParse({ sourceFolder: 'Trash', uids: ['*'] }).success).toBe(
      false,
    );
  });

  it('requires sourceFolder', () => {
    expect(deletePermanentlySchema.safeParse({ uids: [1] }).success).toBe(false);
  });
});
