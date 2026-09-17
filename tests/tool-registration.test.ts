import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerApplyLabelTool } from '../src/tools/apply-label.js';
import { registerArchiveTool } from '../src/tools/archive.js';
import { registerCreateFolderTool } from '../src/tools/create-folder.js';
import { registerCreateLabelTool } from '../src/tools/create-label.js';
import { registerDeletePermanentlyTool } from '../src/tools/delete-permanently.js';
import { registerForwardPreviewTool } from '../src/tools/forward-preview.js';
import { registerForwardTool } from '../src/tools/forward.js';
import { registerGetMessageTool } from '../src/tools/get-message.js';
import { registerListFoldersTool } from '../src/tools/list-folders.js';
import { registerListMessagesTool } from '../src/tools/list-messages.js';
import { registerMarkReadTool } from '../src/tools/mark-read.js';
import { registerMarkSpamTool } from '../src/tools/mark-spam.js';
import { registerMarkUnreadTool } from '../src/tools/mark-unread.js';
import { registerMoveTool } from '../src/tools/move.js';
import { registerRemoveLabelTool } from '../src/tools/remove-label.js';
import { registerReplyPreviewTool } from '../src/tools/reply-preview.js';
import { registerReplyTool } from '../src/tools/reply.js';
import { registerRestoreFromTrashTool } from '../src/tools/restore-from-trash.js';
import { registerSearchMailTool } from '../src/tools/search-mail.js';
import { registerSendPreviewTool } from '../src/tools/send-preview.js';
import { registerSendTool } from '../src/tools/send.js';
import { registerTrashTool } from '../src/tools/trash.js';
import { registerTriageIntelligenceTools } from '../src/tools/triage-intelligence.js';
import { registerUnsubscribePreviewTool } from '../src/tools/unsubscribe-preview.js';
import { registerUnsubscribeTool } from '../src/tools/unsubscribe.js';
import { inputSchema as replyInputSchema } from '../src/tools/reply.js';
import { inputSchema as replyPreviewInputSchema } from '../src/tools/reply-preview.js';
import { inputSchema as forwardInputSchema } from '../src/tools/forward.js';
import { inputSchema as forwardPreviewInputSchema } from '../src/tools/forward-preview.js';

interface CapturedRegistration {
  name: string;
  config: { annotations?: Record<string, unknown> };
}

function captureRegistrations(register: (server: McpServer) => void): CapturedRegistration[] {
  const calls: CapturedRegistration[] = [];
  const fakeServer = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>) => {
      calls.push({ name, config });
    }),
  };
  register(fakeServer as unknown as McpServer);
  return calls;
}

// V1: strictly read-only, no tool here may mutate anything.
const readOnlyRegistrars = [
  registerListFoldersTool,
  registerListMessagesTool,
  registerSearchMailTool,
  registerGetMessageTool,
  registerUnsubscribePreviewTool,
];

// V2: mutation tools; every UID-based tool operates on explicit UIDs.
// mail_mark_spam and mail_unsubscribe are annotated destructive: spam
// because Proton may persistently filter its sender, unsubscribe because it
// is an external, irreversible-by-this-tool side effect.
const mutationRegistrars = [
  registerMarkReadTool,
  registerMarkUnreadTool,
  registerArchiveTool,
  registerMoveTool,
  registerMarkSpamTool,
  registerApplyLabelTool,
  registerRemoveLabelTool,
  registerCreateFolderTool,
  registerCreateLabelTool,
  registerUnsubscribeTool,
];
const intelligenceNames = [
  'mail_automation_candidates',
  'mail_domain_stats',
  'mail_mailing_list_candidates',
  'mail_sender_stats',
  'mail_triage_snapshot',
];

// V4 (0.4.0, "Safe Trash Lifecycle"): mail_trash and mail_delete_permanently
// are destructiveHint: true (recoverable-but-real-state-change, and
// irreversible-once-live respectively); mail_restore_from_trash is not.
// mail_delete_permanently's live execution is additionally, unconditionally
// feature-gated off in 0.4.0 — see mutations/permanent-delete.ts.
const trashLifecycleRegistrars = [
  registerTrashTool,
  registerRestoreFromTrashTool,
  registerDeletePermanentlyTool,
];
const EXPECTED_TRASH_LIFECYCLE_NAMES = [
  'mail_delete_permanently',
  'mail_restore_from_trash',
  'mail_trash',
];
const TRASH_LIFECYCLE_DESTRUCTIVE_HINT_EXPECTED = new Set([
  'mail_trash',
  'mail_delete_permanently',
]);

const EXPECTED_READ_ONLY_NAMES = [
  'mail_get_message',
  'mail_list_folders',
  'mail_list_messages',
  'mail_search',
  'mail_unsubscribe_preview',
];

// V5 (0.5.0, "SMTP Send Foundation"): mail_send_preview is read-only (zero
// SMTP connections); mail_send is not read-only but is deliberately NOT
// destructiveHint — sending mail doesn't destroy/mutate existing mailbox
// state, it's an external side effect (same MCP-semantics reasoning as
// mail_restore_from_trash). Live submission is unconditionally feature-gated
// off in 0.5.0 — see src/smtp/send.ts.
const smtpRegistrars = [registerSendPreviewTool, registerSendTool];
const EXPECTED_SMTP_NAMES = ['mail_send', 'mail_send_preview'];

// V5.2 (0.5.2, "Controlled Reply & Forward"): mail_reply_preview/
// mail_forward_preview are read-only (zero SMTP connections); mail_reply/
// mail_forward are not read-only but deliberately NOT destructiveHint —
// same MCP-semantics reasoning as mail_send. Live submission is
// unconditionally feature-gated off in 0.5.2 — see
// src/smtp/reply-send.ts, forward-send.ts, feature-gates.ts.
const replyForwardRegistrars = [
  registerReplyPreviewTool,
  registerReplyTool,
  registerForwardPreviewTool,
  registerForwardTool,
];
const EXPECTED_REPLY_FORWARD_NAMES = [
  'mail_forward',
  'mail_forward_preview',
  'mail_reply',
  'mail_reply_preview',
];

const EXPECTED_MUTATION_NAMES = [
  'mail_apply_label',
  'mail_archive',
  'mail_create_folder',
  'mail_create_label',
  'mail_mark_read',
  'mail_mark_spam',
  'mail_mark_unread',
  'mail_move',
  'mail_remove_label',
  'mail_unsubscribe',
];

const DESTRUCTIVE_HINT_EXPECTED = new Set(['mail_mark_spam', 'mail_unsubscribe']);

// Verbs that must NEVER appear in ANY tool name in this project — see
// README.md "V2 mutation limitations" / SECURITY.md. "unsubscribe" was
// removed from this list in 0.3.0 (mail_unsubscribe_preview /
// mail_unsubscribe's narrow, RFC 8058-only, consent-gated path);
// "delete"/"trash"/"permanent" were removed in 0.4.0 for the same reason:
// mail_trash, mail_restore_from_trash, and mail_delete_permanently are now
// supported, but ONLY through their own narrow, heavily-gated paths — see
// the "V4 — Safe Trash Lifecycle" tests below, which pin down the EXACT set
// of delete/trash-named tools allowed to exist. "send" was removed in 0.5.0
// for the same reason — mail_send / mail_send_preview now exist, but ONLY
// through their own narrow, plain-text-only, receipt-gated, feature-gated
// path — see the "V5 — SMTP Send Foundation" tests below, which pin down the
// EXACT set of send-named tools allowed to exist. "reply"/"forward" were
// removed from this list in 0.5.2 for the same reason — mail_reply(_preview)
// / mail_forward(_preview) now exist, but ONLY through their own narrow,
// no-reply-all, receipt-gated, feature-gated path — see the "V5.2" tests
// below, which pin down the EXACT set of reply/forward-named tools allowed
// to exist. "expunge" and a bare "smtp" prefix stay banned outright: no tool
// in this project is ever named after the raw IMAP command or a generic
// SMTP verb, ideally or in a gated form.
const BANNED_NAME_PATTERN = /^mail_(expunge|smtp|block[_-]?list|allow[_-]?list|draft.?send)/i;

describe('V1 read-only tool registration', () => {
  it('registers exactly the five documented read-only tool names', () => {
    const names = readOnlyRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual(EXPECTED_READ_ONLY_NAMES);
  });

  it('marks every V1 tool as read-only and non-destructive', () => {
    for (const register of readOnlyRegistrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(true);
      expect(registration?.config.annotations?.destructiveHint).toBe(false);
    }
  });
});

describe('V2 mutation tool registration', () => {
  it('registers exactly the ten documented mutation tool names', () => {
    const names = mutationRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual(EXPECTED_MUTATION_NAMES);
  });

  it('marks every V2 tool as NOT read-only', () => {
    for (const register of mutationRegistrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('marks every V2 tool non-destructive, except mail_mark_spam and mail_unsubscribe', () => {
    for (const register of mutationRegistrars) {
      const [registration] = captureRegistrations(register);
      const expected = DESTRUCTIVE_HINT_EXPECTED.has(registration?.name ?? '');
      expect(registration?.config.annotations?.destructiveHint).toBe(expected);
    }
  });

  it('mail_mark_spam is explicitly annotated destructiveHint: true', () => {
    const [registration] = captureRegistrations(registerMarkSpamTool);
    expect(registration?.config.annotations?.destructiveHint).toBe(true);
    expect(registration?.config.annotations?.readOnlyHint).toBe(false);
  });

  it('mail_unsubscribe is explicitly annotated destructiveHint: true', () => {
    const [registration] = captureRegistrations(registerUnsubscribeTool);
    expect(registration?.config.annotations?.destructiveHint).toBe(true);
    expect(registration?.config.annotations?.readOnlyHint).toBe(false);
  });
});

describe('V4 — Safe Trash Lifecycle tool registration', () => {
  it('registers exactly the three documented trash-lifecycle tool names', () => {
    const names = trashLifecycleRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual(EXPECTED_TRASH_LIFECYCLE_NAMES);
  });

  it('marks every V4 tool as NOT read-only', () => {
    for (const register of trashLifecycleRegistrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('marks mail_trash and mail_delete_permanently destructiveHint: true, mail_restore_from_trash false', () => {
    for (const register of trashLifecycleRegistrars) {
      const [registration] = captureRegistrations(register);
      const expected = TRASH_LIFECYCLE_DESTRUCTIVE_HINT_EXPECTED.has(registration?.name ?? '');
      expect(registration?.config.annotations?.destructiveHint).toBe(expected);
    }
  });
});

describe('V5 — SMTP Send Foundation tool registration', () => {
  it('registers exactly the two documented SMTP tool names', () => {
    const names = smtpRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual(EXPECTED_SMTP_NAMES);
  });

  it('mail_send_preview is read-only and non-destructive', () => {
    const [registration] = captureRegistrations(registerSendPreviewTool);
    expect(registration?.config.annotations?.readOnlyHint).toBe(true);
    expect(registration?.config.annotations?.destructiveHint).toBe(false);
  });

  it('mail_send is NOT read-only but is deliberately NOT destructiveHint either', () => {
    const [registration] = captureRegistrations(registerSendTool);
    expect(registration?.config.annotations?.readOnlyHint).toBe(false);
    expect(registration?.config.annotations?.destructiveHint).toBe(false);
  });
});

describe('V5.2 — Controlled Reply & Forward tool registration', () => {
  it('registers exactly the four documented reply/forward tool names', () => {
    const names = replyForwardRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.sort()).toEqual(EXPECTED_REPLY_FORWARD_NAMES);
  });

  it('mail_reply_preview and mail_forward_preview are read-only and non-destructive', () => {
    for (const register of [registerReplyPreviewTool, registerForwardPreviewTool]) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(true);
      expect(registration?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  it('mail_reply and mail_forward are NOT read-only but are deliberately NOT destructiveHint either', () => {
    for (const register of [registerReplyTool, registerForwardTool]) {
      const [registration] = captureRegistrations(register);
      expect(registration?.config.annotations?.readOnlyHint).toBe(false);
      expect(registration?.config.annotations?.destructiveHint).toBe(false);
    }
  });

  it('structural no-reply-all: mail_reply_preview/mail_reply schemas have no cc/bcc/custom-header fields', () => {
    for (const schema of [replyPreviewInputSchema, replyInputSchema]) {
      const shape = schema.shape as Record<string, unknown>;
      expect(shape.cc).toBeUndefined();
      expect(shape.bcc).toBeUndefined();
      expect(shape.headers).toBeUndefined();
      expect(shape.inReplyTo).toBeUndefined();
      expect(shape.references).toBeUndefined();
      expect(shape.from).toBeUndefined();
    }
  });

  it('structural: mail_forward_preview/mail_forward schemas have no cc/bcc fields and never derive recipients from the source', () => {
    for (const schema of [forwardPreviewInputSchema, forwardInputSchema]) {
      const shape = schema.shape as Record<string, unknown>;
      expect(shape.cc).toBeUndefined();
      expect(shape.bcc).toBeUndefined();
      expect(shape.from).toBeUndefined();
      expect(shape.to).toBeDefined(); // caller-supplied recipients ARE required
    }
  });

  it('mail_reply/mail_forward schemas have no caller-suppliable subject field (always derived)', () => {
    for (const schema of [replyInputSchema, forwardInputSchema]) {
      const shape = schema.shape as Record<string, unknown>;
      expect(shape.subject).toBeUndefined();
    }
  });
});

describe('the full tool surface', () => {
  const allRegistrars = [
    ...readOnlyRegistrars,
    ...mutationRegistrars,
    registerTriageIntelligenceTools,
    ...trashLifecycleRegistrars,
    ...smtpRegistrars,
    ...replyForwardRegistrars,
  ];

  it('is exactly 29 tools, matching V1 (5) + V2/V2.6 (10) + V2.5 (5) + V4 (3) + V5 (2) + V5.2 (4)', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names).toHaveLength(29);
    expect(new Set(names).size).toBe(29); // no accidental duplicate names
  });

  it('contains no tool whose name suggests a banned/destructive operation', () => {
    for (const register of allRegistrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.name).not.toMatch(BANNED_NAME_PATTERN);
    }
  });

  it('has no bare-SMTP tool registered anywhere, and the only reply/forward tools are the four documented V5.2 ones', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.some((name) => /^mail_smtp/i.test(name))).toBe(false);
    const replyOrForwardNamed = names.filter((name) => /^mail_(reply|forward)/i.test(name));
    expect(replyOrForwardNamed.sort()).toEqual(EXPECTED_REPLY_FORWARD_NAMES);
  });

  it('the only send-named tools are the two documented V5 tools', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    const sendNamed = names.filter((name) => /^mail_send(?:_|$)/i.test(name));
    expect(sendNamed.sort()).toEqual(EXPECTED_SMTP_NAMES);
  });

  it('has no expunge tool registered anywhere', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names.some((name) => name.toLowerCase().includes('expunge'))).toBe(false);
  });

  it('the only delete/trash-named tools are the three documented V4 lifecycle tools', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    const deleteOrTrashNamed = names.filter((name) => /delete|trash/i.test(name));
    expect(deleteOrTrashNamed.sort()).toEqual(EXPECTED_TRASH_LIFECYCLE_NAMES);
  });
});

describe('V2.5 read-only tool registration', () => {
  it('registers only the five analysis tools with read-only annotations', () => {
    const registrations = captureRegistrations(registerTriageIntelligenceTools);
    expect(registrations.map((registration) => registration.name).sort()).toEqual(
      intelligenceNames,
    );
    for (const registration of registrations) {
      expect(registration.config.annotations?.readOnlyHint).toBe(true);
      expect(registration.config.annotations?.destructiveHint).toBe(false);
    }
  });
});
