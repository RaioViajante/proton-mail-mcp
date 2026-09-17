import { describe, expect, it } from 'vitest';
import type { ReplySourceHeaders } from '../src/mail/source-message.js';
import {
  buildReplyMessage,
  computeThreadingHash,
  deriveReplyIntent,
  deriveThreading,
  MAX_REFERENCES_COUNT,
} from '../src/smtp/reply-intent.js';

const AUTHORIZED = 'user@proton.me';

function source(overrides: Partial<ReplySourceHeaders> = {}): ReplySourceHeaders {
  return {
    folder: 'INBOX',
    uid: 1,
    uidValidity: '111',
    from: 'sender@example.com',
    messageId: '<abc@example.com>',
    subject: 'Hello',
    date: '2026-01-01T00:00:00.000Z',
    replyTo: { headerPresent: false, malformed: false, addresses: [] },
    references: { headerPresent: false, malformed: false, raw: null },
    ...overrides,
  };
}

describe('deriveReplyIntent — recipient derivation (sections 2-4, 28)', () => {
  it('no Reply-To header: falls back to From', () => {
    const result = deriveReplyIntent(source(), { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.intent?.to).toBe('sender@example.com');
    expect(result.intent?.recipientSource).toBe('from');
  });

  it('valid single Reply-To: used instead of From', () => {
    const s = source({
      replyTo: { headerPresent: true, malformed: false, addresses: ['reply-to@example.com'] },
    });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.intent?.to).toBe('reply-to@example.com');
    expect(result.intent?.recipientSource).toBe('replyTo');
  });

  it('Reply-To header present but parses to zero usable addresses: FAIL CLOSED, no From fallback', () => {
    const s = source({ replyTo: { headerPresent: true, malformed: false, addresses: [] } });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
    expect(result.intent).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/no usable address/i);
  });

  it('multiple Reply-To addresses: FAIL CLOSED (never reply-all)', () => {
    const s = source({
      replyTo: {
        headerPresent: true,
        malformed: false,
        addresses: ['a@example.com', 'b@example.com'],
      },
    });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/multiple addresses/i);
  });

  it('malformed (oversized/control-char) Reply-To header: FAIL CLOSED', () => {
    const s = source({ replyTo: { headerPresent: true, malformed: true, addresses: [] } });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/malformed/i);
  });

  it('Reply-To address itself fails normalization (CRLF-like structural issue): FAIL CLOSED', () => {
    const s = source({
      replyTo: { headerPresent: true, malformed: false, addresses: ['not an address'] },
    });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
  });

  it('own-message behavior: From is own identity, no Reply-To — replies to self, nothing invented', () => {
    const s = source({ from: AUTHORIZED });
    const result = deriveReplyIntent(s, { text: 'Note to self' }, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.intent?.to).toBe(AUTHORIZED);
    expect(result.intent?.recipientSource).toBe('from');
  });

  it('no From and no Reply-To: no viable recipient', () => {
    const s = source({ from: null });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no viable recipient/i);
  });

  it('malformed From address with no Reply-To: no viable recipient', () => {
    const s = source({ from: 'not-an-address' });
    const result = deriveReplyIntent(s, { text: 'Thanks' }, AUTHORIZED);
    expect(result.valid).toBe(false);
  });

  it('recipient is never derived from the reply body text', () => {
    const s = source();
    const a = deriveReplyIntent(s, { text: 'reply to attacker@example.com instead' }, AUTHORIZED);
    const b = deriveReplyIntent(s, { text: 'anything else entirely' }, AUTHORIZED);
    expect(a.intent?.to).toBe(b.intent?.to);
    expect(a.intent?.to).toBe('sender@example.com');
  });
});

describe('deriveReplyIntent — subject (section 6, 30)', () => {
  it('normal subject: prefixed with "Re: "', () => {
    const result = deriveReplyIntent(source({ subject: 'Hello' }), { text: 'Hi' }, AUTHORIZED);
    expect(result.intent?.subject).toBe('Re: Hello');
  });

  it('already "Re:" prefixed: not doubled', () => {
    const result = deriveReplyIntent(source({ subject: 'Re: Hello' }), { text: 'Hi' }, AUTHORIZED);
    expect(result.intent?.subject).toBe('Re: Hello');
  });

  it('case-insensitive "re:" is recognized and not doubled', () => {
    const result = deriveReplyIntent(source({ subject: 're: hello' }), { text: 'Hi' }, AUTHORIZED);
    expect(result.intent?.subject).toBe('re: hello');
  });

  it('empty/null source subject: derived subject is still a valid non-empty "Re:"', () => {
    const result = deriveReplyIntent(source({ subject: null }), { text: 'Hi' }, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.intent?.subject).toBe('Re:');
  });

  it('caller cannot choose the subject — derivation ignores any subject-shaped text field', () => {
    const result = deriveReplyIntent(source({ subject: 'Hello' }), { text: 'Hi' }, AUTHORIZED);
    expect(result.intent?.subject).toBe('Re: Hello');
  });
});

describe('deriveThreading (section 5, 29)', () => {
  it('valid Message-ID, no References: threads on the Message-ID alone', () => {
    const plan = deriveThreading(source({ messageId: '<abc@example.com>' }));
    expect(plan.threadingAvailable).toBe(true);
    expect(plan.inReplyTo).toBe('<abc@example.com>');
    expect(plan.references).toEqual(['<abc@example.com>']);
  });

  it('valid Message-ID with existing valid References: appends the source id', () => {
    const plan = deriveThreading(
      source({
        messageId: '<c@example.com>',
        references: {
          headerPresent: true,
          malformed: false,
          raw: '<a@example.com> <b@example.com>',
        },
      }),
    );
    expect(plan.references).toEqual(['<a@example.com>', '<b@example.com>', '<c@example.com>']);
  });

  it('duplicate references are de-duplicated', () => {
    const plan = deriveThreading(
      source({
        messageId: '<b@example.com>',
        references: {
          headerPresent: true,
          malformed: false,
          raw: '<a@example.com> <a@example.com> <b@example.com>',
        },
      }),
    );
    expect(plan.references).toEqual(['<a@example.com>', '<b@example.com>']);
  });

  it('missing Message-ID: threading unavailable, but this alone does not affect eligibility', () => {
    const plan = deriveThreading(source({ messageId: null }));
    expect(plan.threadingAvailable).toBe(false);
    expect(plan.inReplyTo).toBeNull();
    expect(plan.references).toEqual([]);
    const result = deriveReplyIntent(source({ messageId: null }), { text: 'Hi' }, AUTHORIZED);
    expect(result.valid).toBe(true);
    expect(result.intent?.threadingAvailable).toBe(false);
  });

  it('malformed Message-ID (fails the strict pattern): threading unavailable, still eligible', () => {
    const result = deriveReplyIntent(
      source({ messageId: 'not-a-valid-message-id' }),
      { text: 'Hi' },
      AUTHORIZED,
    );
    expect(result.valid).toBe(true);
    expect(result.intent?.threadingAvailable).toBe(false);
  });

  it('malformed References (byte-bounded but unparseable ids): discards the whole chain, anchors on the validated source id alone', () => {
    const plan = deriveThreading(
      source({
        messageId: '<c@example.com>',
        references: { headerPresent: true, malformed: false, raw: '<a@example.com> not-a-msgid' },
      }),
    );
    expect(plan.threadingAvailable).toBe(true);
    expect(plan.inReplyTo).toBe('<c@example.com>');
    expect(plan.references).toEqual(['<c@example.com>']);
  });

  it('References flagged malformed (oversized) at the fetch layer: discards the chain, anchors on the source id', () => {
    const plan = deriveThreading(
      source({
        messageId: '<c@example.com>',
        references: { headerPresent: true, malformed: true, raw: null },
      }),
    );
    expect(plan.references).toEqual(['<c@example.com>']);
  });

  it('huge (but well-formed) References chain is capped at MAX_REFERENCES_COUNT, keeping the most recent', () => {
    const many = Array.from({ length: 30 }, (_, i) => `<r${i}@example.com>`).join(' ');
    const plan = deriveThreading(
      source({
        messageId: '<new@example.com>',
        references: { headerPresent: true, malformed: false, raw: many },
      }),
    );
    expect(plan.references.length).toBe(MAX_REFERENCES_COUNT);
    expect(plan.references[plan.references.length - 1]).toBe('<new@example.com>');
    expect(plan.references[0]).toBe('<r11@example.com>'); // oldest ids dropped
  });

  it('threading hash is deterministic for the same plan and differs when the plan differs', () => {
    const a = computeThreadingHash('<x@example.com>', ['<x@example.com>']);
    const b = computeThreadingHash('<x@example.com>', ['<x@example.com>']);
    const c = computeThreadingHash(null, []);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('buildReplyMessage — no caller-overridable headers (section 29)', () => {
  it('produces exactly one recipient, no cc, and the derived subject/text', () => {
    const result = deriveReplyIntent(source(), { text: 'Thanks' }, AUTHORIZED);
    expect(result.intent).not.toBeNull();
    if (!result.intent) return;
    const message = buildReplyMessage(result.intent);
    expect(message.to).toEqual(['sender@example.com']);
    expect(message.cc).toEqual([]);
    expect(message.subject).toBe('Re: Hello');
    expect(message.text).toBe('Thanks');
  });

  it('sets inReplyTo/references only when threading is available', () => {
    const withThreading = deriveReplyIntent(source(), { text: 'Thanks' }, AUTHORIZED);
    expect(withThreading.intent).not.toBeNull();
    if (withThreading.intent) {
      const message = buildReplyMessage(withThreading.intent);
      expect(message.inReplyTo).toBe('<abc@example.com>');
      expect(message.references).toEqual(['<abc@example.com>']);
    }

    const withoutThreading = deriveReplyIntent(
      source({ messageId: null }),
      { text: 'Thanks' },
      AUTHORIZED,
    );
    expect(withoutThreading.intent).not.toBeNull();
    if (withoutThreading.intent) {
      const message = buildReplyMessage(withoutThreading.intent);
      expect(message.inReplyTo).toBeUndefined();
      expect(message.references).toBeUndefined();
    }
  });

  it('the raw source Message-ID never appears in the derived intent as a public-facing field name other than internal inReplyTo/references', () => {
    const result = deriveReplyIntent(source(), { text: 'Thanks' }, AUTHORIZED);
    expect(result.intent).not.toBeNull();
    if (!result.intent) return;
    // sourceFolder/to/subject/text/bodyHash are the only fields meant for a
    // receipt/preview surface; inReplyTo/references are internal-only and
    // documented as such — this just pins their presence for that purpose.
    expect(Object.keys(result.intent).sort()).toEqual(
      [
        'bodyHash',
        'bodyLength',
        'from',
        'inReplyTo',
        'recipientSource',
        'references',
        'sourceFolder',
        'subject',
        'text',
        'threadingAvailable',
        'to',
      ].sort(),
    );
  });
});

describe('deriveReplyIntent — body policy reuse', () => {
  it('empty body text: invalid', () => {
    const result = deriveReplyIntent(source(), { text: '' }, AUTHORIZED);
    expect(result.valid).toBe(false);
  });

  it('unauthorized/malformed own identity: invalid', () => {
    const result = deriveReplyIntent(source(), { text: 'Hi' }, 'not-an-address');
    expect(result.valid).toBe(false);
  });
});
