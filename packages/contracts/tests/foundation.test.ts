import { describe, expect, it } from 'vitest';
import {
  errorEnvelopeSchema,
  cursorPageSchema,
  messageSendSchema,
  syncPageSchema,
} from '../src/index.js';

describe('shared contract foundation', () => {
  it('keeps entity ids as strings while sequence values stay numbers', () => {
    const parsed = messageSendSchema.parse({
      groupId: '12',
      clientMsgId: '3f7a2b1c-0d4e-5a6b-8c9d-0e1f2a3b4c5d',
      kind: 'text',
      body: 'hello',
    });

    expect(parsed.groupId).toBe('12');
    expect(() => messageSendSchema.parse({ ...parsed, groupId: 12 })).toThrow();
  });

  it('refuses a clientMsgId that is not a UUID - retries must be able to reuse it', () => {
    expect(() => messageSendSchema.parse({ groupId: '12', clientMsgId: 'client-1', kind: 'text' })).toThrow();
    expect(() => messageSendSchema.parse({ groupId: '12', clientMsgId: '', kind: 'text' })).toThrow();
  });

  it('distinguishes cursor pages from sync pages', () => {
    expect(cursorPageSchema.parse({ items: [], nextCursor: null, hasMore: false })).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(syncPageSchema.parse({ items: [], asOfSeq: 105, hasMore: false }).asOfSeq).toBe(105);
    expect(() => cursorPageSchema.parse({ items: [], asOfSeq: 105, hasMore: false })).toThrow();
  });

  it('requires the request id in every error envelope', () => {
    expect(
      errorEnvelopeSchema.parse({
        error: {
          code: 'INVALID_ARGUMENT',
          message: 'invalid request',
          requestId: 'request-1',
        },
      }).error.requestId,
    ).toBe('request-1');

    expect(() =>
      errorEnvelopeSchema.parse({
        error: { code: 'INVALID_ARGUMENT', message: 'invalid request' },
      }),
    ).toThrow();
  });

  it('accepts every error code the server mapping can emit', () => {
    // These two are defined in the backend spec (3.5 and 8.1) but were missing from the enum,
    // so the server could throw codes the shared contract rejected.
    for (const code of ['CANNOT_REVIEW_OWN_SUBMISSION', 'RATE_LIMITED']) {
      expect(
        errorEnvelopeSchema.parse({
          error: { code, message: 'x', requestId: 'request-1' },
        }).error.code,
      ).toBe(code);
    }
  });
});
