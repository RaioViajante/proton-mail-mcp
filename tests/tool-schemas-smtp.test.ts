import { describe, expect, it } from 'vitest';
import { MAX_SEND_RECIPIENTS } from '../src/smtp/policy.js';
import { inputSchema as sendPreviewSchema } from '../src/tools/send-preview.js';
import { inputSchema as sendSchema } from '../src/tools/send.js';

describe('mail_send_preview input schema', () => {
  it('accepts a minimal valid request', () => {
    const result = sendPreviewSchema.safeParse({
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Hello',
    });
    expect(result.success).toBe(true);
  });

  it('requires at least one "to" recipient', () => {
    expect(sendPreviewSchema.safeParse({ to: [], subject: 'Hi', text: 'Hello' }).success).toBe(
      false,
    );
  });

  it('requires subject and text', () => {
    expect(sendPreviewSchema.safeParse({ to: ['a@example.com'] }).success).toBe(false);
  });

  it('accepts optional from and cc', () => {
    const result = sendPreviewSchema.safeParse({
      from: 'user@proton.me',
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Hi',
      text: 'Hello',
    });
    expect(result.success).toBe(true);
  });

  it('has no bcc field at all (0.5.0 scope)', () => {
    const result = sendPreviewSchema.safeParse({
      to: ['a@example.com'],
      bcc: ['secret@example.com'],
      subject: 'Hi',
      text: 'Hello',
    });
    // zod object (non-strict) ignores unknown keys rather than rejecting —
    // the guarantee this test pins down is that bcc is simply never read
    // anywhere downstream, not that it causes a parse error.
    expect(result.success).toBe(true);
    if (result.success) {
      expect('bcc' in result.data).toBe(false);
    }
  });
});

describe('mail_send input schema', () => {
  it('defaults dryRun to true and both confirmations to false', () => {
    const result = sendSchema.parse({ to: ['a@example.com'], subject: 'Hi', text: 'Hello' });
    expect(result.dryRun).toBe(true);
    expect(result.confirm).toBe(false);
    expect(result.acknowledgeExternalSend).toBe(false);
  });

  it('accepts explicit live intent with a sendIntentReceipt', () => {
    const result = sendSchema.parse({
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Hello',
      sendIntentReceipt: {
        v: 1,
        from: 'a',
        to: [],
        cc: [],
        subject: 'x',
        bodyHash: 'x',
        issuedAt: 'x',
        signature: 'x',
      },
      dryRun: false,
      confirm: true,
      acknowledgeExternalSend: true,
    });
    expect(result.dryRun).toBe(false);
    expect(result.confirm).toBe(true);
    expect(result.acknowledgeExternalSend).toBe(true);
  });

  it('requires at least one "to" recipient', () => {
    expect(sendSchema.safeParse({ to: [], subject: 'Hi', text: 'Hello' }).success).toBe(false);
  });

  it('requires subject and text', () => {
    expect(sendSchema.safeParse({ to: ['a@example.com'] }).success).toBe(false);
  });

  it('mentions the recipient ceiling in its cc description', () => {
    const description = sendSchema.shape.cc.description ?? '';
    expect(description).toContain(String(MAX_SEND_RECIPIENTS));
  });
});
