import { describe, expect, it } from 'vitest';
import {
  messageDtoSchema,
  messageEditSchema,
  messageHistoryQuerySchema,
  messagePageSchema,
  messageReceiptsDtoSchema,
  messageReceiptsQuerySchema,
  messageSendResultSchema,
  messageSyncPageSchema,
  readPositionDtoSchema,
  readUpdateSchema,
  syncHelloSchema,
  syncPullSchema,
  syncReadySchema,
  wsErrorPayloadSchema,
} from '../src/index.js';

const clientMsgId = '3f7a2b1c-0d4e-5a6b-8c9d-0e1f2a3b4c5d';

const messageFixture = {
  id: '9007199254740993',
  groupId: '12',
  seq: 106,
  senderId: '44',
  clientMsgId,
  kind: 'text',
  body: '把脚手架再检查一遍',
  taskId: null,
  refMessageId: null,
  meta: null,
  createdAt: '2026-09-13T12:00:00+08:00',
  editedAt: null,
  deletedAt: null,
  deletedBy: null,
  updatedAt: '2026-09-13T12:00:00+08:00',
};

describe('message contracts', () => {
  it('carries updatedAt because spec 4.3.4 resolves out-of-order events with it', () => {
    const parsed = messageDtoSchema.parse(messageFixture);
    expect(parsed.updatedAt).toBe('2026-09-13T12:00:00+08:00');
    expect(() => messageDtoSchema.parse({ ...messageFixture, updatedAt: undefined })).toThrow();
    expect(() => messageDtoSchema.parse({ ...messageFixture, updatedAt: '2026-09-13 12:00' })).toThrow();
  });

  it('keeps BIGINT ids as strings so the browser never truncates them', () => {
    expect(messageDtoSchema.parse(messageFixture).id).toBe('9007199254740993');
    // Number('...') rather than a bare literal: writing 9007199254740993 directly
    // in source is already rounded by the parser before the schema ever sees it,
    // which is the exact hazard this rule exists to point at. Asserted, not assumed.
    const lossy = Number('9007199254740993');
    expect(Number.isSafeInteger(lossy)).toBe(false);
    expect(() => messageDtoSchema.parse({ ...messageFixture, id: lossy })).toThrow();
    expect(messageDtoSchema.parse(messageFixture).seq).toBe(106);
  });

  it('allows a null sender for system messages but not a null body-and-seq pair', () => {
    expect(messageDtoSchema.parse({ ...messageFixture, senderId: null, kind: 'system' }).senderId).toBeNull();
    expect(() => messageDtoSchema.parse({ ...messageFixture, seq: null })).toThrow();
    expect(() => messageDtoSchema.parse({ ...messageFixture, seq: -1 })).toThrow();
  });

  it('requires clientMsgId to be a real UUID - retries must be able to reuse it', () => {
    expect(messageDtoSchema.parse(messageFixture).clientMsgId).toBe(clientMsgId);
    expect(messageDtoSchema.parse({ ...messageFixture, clientMsgId: null }).clientMsgId).toBeNull();
    expect(() => messageDtoSchema.parse({ ...messageFixture, clientMsgId: 'tmp-1' })).toThrow();
    expect(() => messageDtoSchema.parse({ ...messageFixture, clientMsgId: 123 })).toThrow();
  });

  it('defaults attachments, mentions and the dedupe flag instead of leaving them undefined', () => {
    const parsed = messageDtoSchema.parse(messageFixture);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.mentions).toEqual([]);
    expect(messageSendResultSchema.parse({ message: parsed }).deduplicated).toBe(false);
    expect(messageSendResultSchema.parse({ message: parsed, deduplicated: true }).deduplicated).toBe(true);
  });

  it('refuses an empty or absurdly long edit body', () => {
    expect(messageEditSchema.parse({ messageId: '5', body: '改一下' }).body).toBe('改一下');
    expect(() => messageEditSchema.parse({ messageId: '5', body: '' })).toThrow();
    expect(() => messageEditSchema.parse({ messageId: '5', body: 'x'.repeat(4001) })).toThrow();
  });
});

describe('sync contracts', () => {
  it('accepts the hello watermark list and rejects a negative syncedSeq', () => {
    expect(syncHelloSchema.parse({ groups: [{ groupId: '12', syncedSeq: 0 }] }).groups[0]?.syncedSeq).toBe(0);
    expect(() => syncHelloSchema.parse({ groups: [{ groupId: '12', syncedSeq: -1 }] })).toThrow();
    expect(() => syncHelloSchema.parse({ groups: [{ groupId: 12, syncedSeq: 1 }] })).toThrow();
  });

  it('sends the contract version down with sync:ready so an old client can warn', () => {
    expect(syncReadySchema.parse({
      groups: [{ groupId: '12', lastSeq: 106 }],
      contractVersion: 'a1b2c3d4',
      online: [],
    }).contractVersion).toBe('a1b2c3d4');
    expect(() => syncReadySchema.parse({ groups: [] })).toThrow();
  });

  it('requires the presence snapshot, because an omitted one reads as everybody offline', () => {
    expect(syncReadySchema.parse({
      groups: [{ groupId: '12', lastSeq: 106 }],
      contractVersion: 'a1b2c3d4',
      online: ['77', '78'],
    }).online).toEqual(['77', '78']);
    // Empty is a valid answer - nobody is online. Missing is not: it would leave a
    // client that cannot tell "no one" from "the server did not say", and the
    // second of those renders every dot as offline. decisions/0009 section two.
    expect(() =>
      syncReadySchema.parse({ groups: [], contractVersion: 'a1b2c3d4' }),
    ).toThrow();
  });

  it('caps a pull page at the 200 the spec fixes', () => {
    expect(syncPullSchema.parse({ groupId: '12', sinceSeq: 4 }).limit).toBe(200);
    expect(syncPullSchema.parse({ groupId: '12', sinceSeq: 4, limit: 200 }).limit).toBe(200);
    expect(() => syncPullSchema.parse({ groupId: '12', sinceSeq: 4, limit: 5000 })).toThrow();
    expect(() => syncPullSchema.parse({ groupId: '12', sinceSeq: 0, limit: 0 })).toThrow();
  });

  it('lets asOfSeq outrun an empty page, which is how a client skips a hole', () => {
    const page = messageSyncPageSchema.parse({ items: [], asOfSeq: 105, hasMore: false });
    expect(page.items).toEqual([]);
    expect(page.asOfSeq).toBe(105);
    expect(() => messageSyncPageSchema.parse({ items: [], asOfSeq: -1, hasMore: false })).toThrow();
  });

  it('only pages messages that satisfy the full DTO', () => {
    expect(messagePageSchema.parse({
      items: [messageDtoSchema.parse(messageFixture)],
      nextCursor: '105',
      hasMore: true,
    }).items[0]?.seq).toBe(106);
    expect(() => messagePageSchema.parse({ items: [{ id: '1' }], nextCursor: null, hasMore: false })).toThrow();
  });

  it('keeps history paging separate from sync paging - they are different shapes', () => {
    expect(messageHistoryQuerySchema.parse({}).limit).toBe(50);
    expect(messageHistoryQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(() => messageHistoryQuerySchema.parse({ limit: 101 })).toThrow();
    expect(messageHistoryQuerySchema.parse({ beforeSeq: '105' }).beforeSeq).toBe(105);
  });
});

describe('read position and receipt contracts', () => {
  it('accepts a partial read update from either surface', () => {
    expect(readUpdateSchema.parse({ groupId: '12' })).toEqual({ groupId: '12' });
    expect(readUpdateSchema.parse({ groupId: '12', lastReadSeq: 106 }).lastReadSeq).toBe(106);
    expect(readUpdateSchema.parse({ groupId: '12', mentionsReadSeq: 3 }).mentionsReadSeq).toBe(3);
    expect(() => readUpdateSchema.parse({ groupId: '12', lastReadSeq: 'x' })).toThrow();
  });

  it('never lets a position go negative', () => {
    expect(readPositionDtoSchema.parse({ lastReadSeq: 0, mentionsReadSeq: 0 }).lastReadSeq).toBe(0);
    expect(() => readPositionDtoSchema.parse({ lastReadSeq: -1, mentionsReadSeq: 0 })).toThrow();
  });

  it('keeps readers optional so detail=0 stays cheap', () => {
    expect(messageReceiptsDtoSchema.parse({ readCount: 3, totalMembers: 8 }).readers).toBeUndefined();
    const detailed = messageReceiptsDtoSchema.parse({
      readCount: 1,
      totalMembers: 8,
      readers: [{ userId: '44', displayName: '工友甲', lastReadSeq: 106 }],
    });
    expect(detailed.readers?.[0]?.displayName).toBe('工友甲');
  });

  it('takes the receipt tier from a strict two-value flag, not from coercion', () => {
    expect(messageReceiptsQuerySchema.parse({}).detail).toBe(0);
    expect(messageReceiptsQuerySchema.parse({ detail: '0' }).detail).toBe(0);
    expect(messageReceiptsQuerySchema.parse({ detail: '1' }).detail).toBe(1);
    // Coercion would turn both of these into the cheap tier and hide a broken client.
    expect(() => messageReceiptsQuerySchema.parse({ detail: '' })).toThrow();
    expect(() => messageReceiptsQuerySchema.parse({ detail: '2' })).toThrow();
  });

  it('maps a WS ack failure onto the shared error-code enum', () => {
    expect(wsErrorPayloadSchema.parse({
      error: { code: 'DELETE_WINDOW_EXPIRED', message: 'delete window expired' },
    }).error.code).toBe('DELETE_WINDOW_EXPIRED');
    expect(() => wsErrorPayloadSchema.parse({ error: { code: 'NOPE', message: 'x' } })).toThrow();
  });
});
