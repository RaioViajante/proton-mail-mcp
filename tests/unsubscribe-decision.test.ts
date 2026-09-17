import { describe, expect, it } from 'vitest';
import { computeUnsubscribeDecision, toPublicPreview } from '../src/unsubscribe/decision.js';
import type {
  RawUnsubscribeHeaders,
  ResolvedUnsubscribeMessage,
} from '../src/unsubscribe/headers.js';

function resolved(
  overrides: Partial<RawUnsubscribeHeaders> = {},
  fromDomain = 'list.example.com',
): ResolvedUnsubscribeMessage {
  return {
    uid: 1,
    messageId: '<abc@list.example.com>',
    fromDomain,
    headers: {
      listId: undefined,
      listUnsubscribe: undefined,
      listUnsubscribePost: undefined,
      authenticationResults: undefined,
      dkimSignaturePresent: false,
      ...overrides,
    },
  };
}

const VERIFIED_AUTH = 'mx.proton.me; dkim=pass header.d=list.example.com; dmarc=pass';

describe('computeUnsubscribeDecision — mechanism parsing', () => {
  it('classifies a valid HTTPS one-click header pair as eligible when authenticated', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://list.example.com/u?id=1>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
        authenticationResults: VERIFIED_AUTH,
      }),
    );
    expect(decision.mechanism).toBe('rfc8058-https-one-click');
    expect(decision.oneClick).toBe(true);
    expect(decision.authenticationStatus).toBe('verified');
    expect(decision.executionEligibility).toBe('eligible');
    expect(decision.targetHost).toBe('list.example.com');
  });

  it('classifies mailto + HTTPS (no List-Unsubscribe-Post) as supported but not one-click', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://list.example.com/u?id=1>, <mailto:unsub@list.example.com>',
        authenticationResults: VERIFIED_AUTH,
      }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.oneClick).toBe(false);
    expect(decision.supported).toBe(true);
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('classifies a mailto-only header as mailto, never executable', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ listUnsubscribe: '<mailto:unsub@list.example.com>' }),
    );
    expect(decision.mechanism).toBe('mailto');
    expect(decision.oneClick).toBe(false);
    expect(decision.executionEligibility).toBe('ineligible');
    expect(decision.targetHost).toBeNull();
  });

  it('classifies a plain HTTP-only header as http-non-one-click', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ listUnsubscribe: '<http://list.example.com/u?id=1>' }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.targetHost).toBeNull();
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('classifies an absent List-Unsubscribe header as none', () => {
    const decision = computeUnsubscribeDecision(resolved());
    expect(decision.mechanism).toBe('none');
    expect(decision.supported).toBe(false);
  });

  it('is ineligible when List-Unsubscribe-Post is absent', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://list.example.com/u?id=1>',
        authenticationResults: VERIFIED_AUTH,
      }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.executionEligibility).toBe('ineligible');
    expect(decision.reasons.some((r) => /List-Unsubscribe-Post header is absent/.test(r))).toBe(
      true,
    );
  });

  it('is ineligible when List-Unsubscribe-Post has an invalid value', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://list.example.com/u?id=1>',
        listUnsubscribePost: 'something-else',
        authenticationResults: VERIFIED_AUTH,
      }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('treats a malformed URI as unsupported for one-click', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.targetHost).toBeNull();
  });

  it('refuses to pick between multiple HTTPS URIs', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://a.example.com/u>, <https://b.example.com/u>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
        authenticationResults: VERIFIED_AUTH,
      }),
    );
    expect(decision.mechanism).toBe('http-non-one-click');
    expect(decision.targetHost).toBeNull();
    expect(decision.reasons.some((r) => /Multiple HTTPS/.test(r))).toBe(true);
  });
});

describe('computeUnsubscribeDecision — authentication status', () => {
  const eligibleHeaders = {
    listUnsubscribe: '<https://list.example.com/u?id=1>',
    listUnsubscribePost: 'List-Unsubscribe=One-Click',
  };

  it('is unavailable with no Authentication-Results and no DKIM-Signature', () => {
    const decision = computeUnsubscribeDecision(resolved(eligibleHeaders));
    expect(decision.authenticationStatus).toBe('unavailable');
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('is evidence-present-but-not-cryptographically-verified with only a DKIM-Signature header', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ ...eligibleHeaders, dkimSignaturePresent: true }),
    );
    expect(decision.authenticationStatus).toBe(
      'evidence-present-but-not-cryptographically-verified',
    );
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('is verified on a dmarc=pass result alone', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ ...eligibleHeaders, authenticationResults: 'mx.proton.me; dmarc=pass' }),
    );
    expect(decision.authenticationStatus).toBe('verified');
    expect(decision.executionEligibility).toBe('eligible');
  });

  it('is verified on dkim=pass only when the signing domain aligns with the From domain', () => {
    const decision = computeUnsubscribeDecision(
      resolved(
        {
          ...eligibleHeaders,
          authenticationResults: 'mx.proton.me; dkim=pass header.d=list.example.com',
        },
        'list.example.com',
      ),
    );
    expect(decision.authenticationStatus).toBe('verified');
  });

  it('is NOT verified on dkim=pass for an unrelated signing domain', () => {
    const decision = computeUnsubscribeDecision(
      resolved(
        {
          ...eligibleHeaders,
          authenticationResults: 'mx.proton.me; dkim=pass header.d=unrelated.example',
        },
        'list.example.com',
      ),
    );
    expect(decision.authenticationStatus).toBe(
      'evidence-present-but-not-cryptographically-verified',
    );
    expect(decision.executionEligibility).toBe('ineligible');
  });

  it('is failed on an explicit dkim=fail result', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ ...eligibleHeaders, authenticationResults: 'mx.proton.me; dkim=fail' }),
    );
    expect(decision.authenticationStatus).toBe('failed');
    expect(decision.executionEligibility).toBe('ineligible');
  });
});

describe('toPublicPreview — sanitization', () => {
  it('never leaks the target URL, query string, or raw header values', () => {
    const decision = computeUnsubscribeDecision(
      resolved({
        listUnsubscribe: '<https://list.example.com/u?id=SECRET-TOKEN-123>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
        authenticationResults: 'mx.proton.me; dkim=pass header.d=list.example.com; dmarc=pass',
      }),
    );
    const preview = toPublicPreview('INBOX', decision);
    const serialized = JSON.stringify(preview);

    expect(serialized).not.toContain('SECRET-TOKEN-123');
    expect(serialized).not.toContain('id=');
    expect(serialized).not.toContain('/u?');
    expect(serialized).not.toContain('mailto:');
    expect(preview.targetHost).toBe('list.example.com');
    expect(Object.keys(preview).sort()).toEqual(
      [
        'authenticationStatus',
        'executionEligibility',
        'folder',
        'listIdPresent',
        'mechanism',
        'oneClick',
        'operation',
        'reasons',
        'supported',
        'targetHost',
        'uid',
      ].sort(),
    );
  });

  it('never exposes a recipient/mailto address even when mailto is the only mechanism', () => {
    const decision = computeUnsubscribeDecision(
      resolved({ listUnsubscribe: '<mailto:very-secret-recipient@list.example.com>' }),
    );
    const preview = toPublicPreview('INBOX', decision);
    expect(JSON.stringify(preview)).not.toContain('very-secret-recipient');
  });
});
