import { describe, expect, it } from 'vitest';
import { publicOperationError } from '../src/security/public-operation-error.js';

describe('MCP error boundary', () => {
  it('never copies an arbitrary library error into the public message', () => {
    const raw = 'A12 NO fake@example.test <fake-id@example.test> /tmp/private-fixture fake-token';
    const publicError = publicOperationError(new Error(raw));
    expect(publicError.message).toBe('Mailbox operation failed.');
    expect(publicError.message).not.toContain('fake@example.test');
    expect(publicError.message).not.toContain('/tmp/private-fixture');
    expect(publicError.cause).toBeUndefined();
  });

  it.each([
    ['confirm=true is required', 'Operation requires explicit confirmation.'],
    ['No such destination folder', 'Source or destination unavailable.'],
    ['Cannot move into a label mailbox', 'Operation rejected by mailbox policy.'],
  ])('preserves a safe category for expected domain failures', (input, expected) => {
    expect(publicOperationError(new Error(input)).message).toBe(expected);
  });
});
