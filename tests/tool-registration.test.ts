import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { registerApplyLabelTool } from '../src/tools/apply-label.js';
import { registerArchiveTool } from '../src/tools/archive.js';
import { registerCreateFolderTool } from '../src/tools/create-folder.js';
import { registerCreateLabelTool } from '../src/tools/create-label.js';
import { registerGetMessageTool } from '../src/tools/get-message.js';
import { registerListFoldersTool } from '../src/tools/list-folders.js';
import { registerListMessagesTool } from '../src/tools/list-messages.js';
import { registerMarkReadTool } from '../src/tools/mark-read.js';
import { registerMarkSpamTool } from '../src/tools/mark-spam.js';
import { registerMarkUnreadTool } from '../src/tools/mark-unread.js';
import { registerMoveTool } from '../src/tools/move.js';
import { registerRemoveLabelTool } from '../src/tools/remove-label.js';
import { registerSearchMailTool } from '../src/tools/search-mail.js';
import { registerTriageIntelligenceTools } from '../src/tools/triage-intelligence.js';
import { registerUnsubscribePreviewTool } from '../src/tools/unsubscribe-preview.js';
import { registerUnsubscribeTool } from '../src/tools/unsubscribe.js';

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

const EXPECTED_READ_ONLY_NAMES = [
  'mail_get_message',
  'mail_list_folders',
  'mail_list_messages',
  'mail_search',
  'mail_unsubscribe_preview',
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

// Verbs that must NEVER appear in ANY tool name in this project, V1 or V2 —
// see README.md "V2 NÃO pode conter" / SECURITY.md. "unsubscribe" was
// removed from this list in 0.3.0: it is now supported, but ONLY through
// mail_unsubscribe_preview / mail_unsubscribe's narrow, RFC 8058-only,
// consent-gated path — see SECURITY.md ("External HTTP side effect").
const BANNED_NAME_PATTERN =
  /^mail_(delete|trash|expunge|smtp|send(?:_|$)|reply|forward|permanent|block[_-]?list|allow[_-]?list|draft.?send)/i;

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

describe('the full tool surface', () => {
  const allRegistrars = [
    ...readOnlyRegistrars,
    ...mutationRegistrars,
    registerTriageIntelligenceTools,
  ];

  it('is exactly 20 tools, matching V1 (5) + V2/V2.6 (10) + V2.5 (5)', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20); // no accidental duplicate names
  });

  it('contains no tool whose name suggests a banned/destructive operation', () => {
    for (const register of allRegistrars) {
      const [registration] = captureRegistrations(register);
      expect(registration?.name).not.toMatch(BANNED_NAME_PATTERN);
    }
  });

  it('has no SMTP, send, reply, or forward tool registered anywhere', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    for (const forbidden of [
      /^mail_smtp/i,
      /^mail_send(?:_|$)/i,
      /^mail_reply/i,
      /^mail_forward/i,
    ]) {
      expect(names.some((name) => forbidden.test(name))).toBe(false);
    }
  });

  it('has no delete, trash, or expunge tool registered anywhere', () => {
    const names = allRegistrars.flatMap((register) =>
      captureRegistrations(register).map((call) => call.name),
    );
    for (const forbidden of ['delete', 'trash', 'expunge']) {
      expect(names.some((name) => name.toLowerCase().includes(forbidden))).toBe(false);
    }
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
