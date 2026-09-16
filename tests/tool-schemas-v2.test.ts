import { describe, expect, it } from 'vitest';
import { inputSchema as applyLabelSchema } from '../src/tools/apply-label.js';
import { inputSchema as archiveSchema } from '../src/tools/archive.js';
import { inputSchema as createFolderSchema } from '../src/tools/create-folder.js';
import { inputSchema as createLabelSchema } from '../src/tools/create-label.js';
import { inputSchema as markReadSchema } from '../src/tools/mark-read.js';
import { inputSchema as markSpamSchema } from '../src/tools/mark-spam.js';
import { inputSchema as markUnreadSchema } from '../src/tools/mark-unread.js';
import { inputSchema as moveSchema } from '../src/tools/move.js';
import { inputSchema as removeLabelSchema } from '../src/tools/remove-label.js';

const uidBasedSchemas = {
  mail_mark_read: markReadSchema,
  mail_mark_unread: markUnreadSchema,
  mail_archive: archiveSchema,
} as const;

describe.each(Object.entries(uidBasedSchemas))('%s input schema', (_name, schema) => {
  it('defaults dryRun to true', () => {
    const result = schema.parse({ folder: 'INBOX', uids: [1] });
    expect(result.dryRun).toBe(true);
  });

  it('rejects an empty uids array', () => {
    expect(schema.safeParse({ folder: 'INBOX', uids: [] }).success).toBe(false);
  });

  it('rejects more than 25 uids', () => {
    const uids = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(schema.safeParse({ folder: 'INBOX', uids }).success).toBe(false);
  });

  it('accepts exactly 25 uids', () => {
    const uids = Array.from({ length: 25 }, (_, i) => i + 1);
    expect(schema.safeParse({ folder: 'INBOX', uids }).success).toBe(true);
  });

  it('rejects a non-integer uid', () => {
    expect(schema.safeParse({ folder: 'INBOX', uids: [1.5] }).success).toBe(false);
  });

  it('rejects a non-positive uid', () => {
    expect(schema.safeParse({ folder: 'INBOX', uids: [0] }).success).toBe(false);
    expect(schema.safeParse({ folder: 'INBOX', uids: [-1] }).success).toBe(false);
  });

  it('requires a folder', () => {
    expect(schema.safeParse({ uids: [1] }).success).toBe(false);
  });

  it('accepts an explicit dryRun: false', () => {
    const result = schema.parse({ folder: 'INBOX', uids: [1], dryRun: false });
    expect(result.dryRun).toBe(false);
  });
});

describe('mail_move input schema', () => {
  it('defaults dryRun to true and requires both folders', () => {
    const result = moveSchema.parse({
      sourceFolder: 'INBOX',
      destinationFolder: 'Projects',
      uids: [1],
    });
    expect(result.dryRun).toBe(true);
  });

  it('rejects more than 25 uids', () => {
    const uids = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(
      moveSchema.safeParse({ sourceFolder: 'INBOX', destinationFolder: 'Projects', uids }).success,
    ).toBe(false);
  });

  it('requires sourceFolder and destinationFolder', () => {
    expect(moveSchema.safeParse({ uids: [1] }).success).toBe(false);
    expect(moveSchema.safeParse({ sourceFolder: 'INBOX', uids: [1] }).success).toBe(false);
  });
});

describe('mail_mark_spam input schema', () => {
  it('defaults dryRun to true and both confirmations to false', () => {
    const result = markSpamSchema.parse({ folder: 'INBOX', uids: [1] });
    expect(result.dryRun).toBe(true);
    expect(result.confirm).toBe(false);
    expect(result.acknowledgeFutureFiltering).toBe(false);
  });

  it('accepts explicit live intent with both confirmations', () => {
    const result = markSpamSchema.parse({
      folder: 'INBOX',
      uids: [1],
      dryRun: false,
      confirm: true,
      acknowledgeFutureFiltering: true,
    });
    expect(result.dryRun).toBe(false);
    expect(result.confirm).toBe(true);
    expect(result.acknowledgeFutureFiltering).toBe(true);
  });

  it('rejects more than 25 uids', () => {
    const uids = Array.from({ length: 26 }, (_, i) => i + 1);
    expect(markSpamSchema.safeParse({ folder: 'INBOX', uids }).success).toBe(false);
  });
});

describe('mail_apply_label / mail_remove_label input schema', () => {
  for (const [name, schema] of [
    ['mail_apply_label', applyLabelSchema],
    ['mail_remove_label', removeLabelSchema],
  ] as const) {
    it(`${name}: requires folder, label, and uids`, () => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ folder: 'INBOX', uids: [1] }).success).toBe(false);
      expect(schema.safeParse({ folder: 'INBOX', label: 'Work' }).success).toBe(false);
    });

    it(`${name}: defaults dryRun to true`, () => {
      const result = schema.parse({ folder: 'INBOX', label: 'Work', uids: [1] });
      expect(result.dryRun).toBe(true);
    });

    it(`${name}: rejects more than 25 uids`, () => {
      const uids = Array.from({ length: 26 }, (_, i) => i + 1);
      expect(schema.safeParse({ folder: 'INBOX', label: 'Work', uids }).success).toBe(false);
    });

    it(`${name}: rejects an empty label`, () => {
      expect(schema.safeParse({ folder: 'INBOX', label: '', uids: [1] }).success).toBe(false);
    });
  }
});

describe('mail_create_folder input schema', () => {
  it('requires a name', () => {
    expect(createFolderSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(createFolderSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('defaults dryRun to true and allows an optional parent', () => {
    const result = createFolderSchema.parse({ name: 'Receipts' });
    expect(result.dryRun).toBe(true);
    expect(result.parent).toBeUndefined();
  });

  it('accepts a parent', () => {
    const result = createFolderSchema.parse({ name: 'Receipts', parent: 'Projects' });
    expect(result.parent).toBe('Projects');
  });
});

describe('mail_create_label input schema', () => {
  it('requires a name and defaults dryRun to true', () => {
    expect(createLabelSchema.safeParse({}).success).toBe(false);
    expect(createLabelSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createLabelSchema.parse({ name: 'News' })).toEqual({ name: 'News', dryRun: true });
  });

  it('accepts explicit live intent but no parent/nesting parameter', () => {
    expect(createLabelSchema.parse({ name: 'News', dryRun: false }).dryRun).toBe(false);
    expect(createLabelSchema.safeParse({ name: 'News', parent: 'Other' }).success).toBe(false);
  });
});
