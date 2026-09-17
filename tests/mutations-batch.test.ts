import { describe, expect, it } from 'vitest';
import {
  MAX_MUTATION_UIDS,
  MAX_PERMANENT_DELETE_UIDS,
  assertBatchSize,
  dedupeUids,
} from '../src/mutations/batch.js';

describe('dedupeUids', () => {
  it('removes duplicate UIDs while preserving first-seen order', () => {
    expect(dedupeUids([10, 11, 10, 12, 11])).toEqual([10, 11, 12]);
  });

  it('leaves an already-unique array unchanged', () => {
    expect(dedupeUids([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('assertBatchSize', () => {
  it('rejects an empty array', () => {
    expect(() => assertBatchSize([])).toThrow(/must not be empty/i);
  });

  it(`accepts exactly ${MAX_MUTATION_UIDS} UIDs`, () => {
    const uids = Array.from({ length: MAX_MUTATION_UIDS }, (_, i) => i + 1);
    expect(() => assertBatchSize(uids)).not.toThrow();
  });

  it(`rejects more than ${MAX_MUTATION_UIDS} UIDs`, () => {
    const uids = Array.from({ length: MAX_MUTATION_UIDS + 1 }, (_, i) => i + 1);
    expect(() => assertBatchSize(uids)).toThrow(new RegExp(`At most ${MAX_MUTATION_UIDS}`));
  });

  it('accepts a single UID', () => {
    expect(() => assertBatchSize([1])).not.toThrow();
  });

  it(`accepts a custom, stricter max (e.g. ${MAX_PERMANENT_DELETE_UIDS} for mail_delete_permanently)`, () => {
    const uids = Array.from({ length: MAX_PERMANENT_DELETE_UIDS }, (_, i) => i + 1);
    expect(() => assertBatchSize(uids, MAX_PERMANENT_DELETE_UIDS)).not.toThrow();
  });

  it(`rejects more than the custom max (${MAX_PERMANENT_DELETE_UIDS})`, () => {
    const uids = Array.from({ length: MAX_PERMANENT_DELETE_UIDS + 1 }, (_, i) => i + 1);
    expect(() => assertBatchSize(uids, MAX_PERMANENT_DELETE_UIDS)).toThrow(
      new RegExp(`At most ${MAX_PERMANENT_DELETE_UIDS}`),
    );
  });
});
