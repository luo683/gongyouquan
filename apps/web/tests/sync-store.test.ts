import { describe, expect, it } from 'vitest';
import type { MessageDto } from '@gongyouquan/contracts';
import { applyEvent, applyNew, applyPage, emptyGroup, orderedMessages, startReplay } from '../src/syncStore.js';

/**
 * Ids and seq are separate on purpose: ids are BIGINTs the client must never
 * coerce through Number(), and seq is the only ordering that is correct across a
 * replay.
 */
function message(overrides: Partial<MessageDto> & { id: string; seq: number }): MessageDto {
  return {
    groupId: '7',
    senderId: '1',
    clientMsgId: null,
    kind: 'text',
    body: `m${overrides.seq}`,
    taskId: null,
    refMessageId: null,
    attachments: [],
    mentions: [],
    meta: null,
    createdAt: '2026-09-13T12:00:00+08:00',
    editedAt: null,
    deletedAt: null,
    deletedBy: null,
    updatedAt: '2026-09-13T12:00:00+08:00',
    ...overrides,
  };
}

const T = (iso: string) => iso;

describe('client sync state machine (spec 4.3)', () => {
  it('applies a contiguous stream and keeps seq as the only sort key', () => {
    const group = emptyGroup(0);
    for (const seq of [2, 1, 3]) applyNew(group, message({ id: `id-${seq}`, seq }));
    expect(group.syncedSeq).toBe(3);
    expect(orderedMessages(group).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('buffers a gap instead of showing it as the end of history', () => {
    const group = emptyGroup(0);
    expect(applyNew(group, message({ id: 'a', seq: 3 }))).toEqual({ kind: 'held', reason: 'gap' });
    expect(group.syncedSeq).toBe(0);
    // Nothing renders at 3 while 1 and 2 are unknown; the buffer is not the view.
    expect(orderedMessages(group)).toEqual([]);

    applyNew(group, message({ id: 'b', seq: 1 }));
    applyNew(group, message({ id: 'c', seq: 2 }));
    expect(group.syncedSeq).toBe(3);
    expect(orderedMessages(group).map((m) => m.id)).toEqual(['b', 'c', 'a']);
    expect(group.pendingNew).toEqual([]);
  });

  it('drops a redelivery at or below syncedSeq by id (4.3.4 row three)', () => {
    const group = emptyGroup(0);
    applyNew(group, message({ id: 'x', seq: 1 }));
    const again = applyNew(group, message({ id: 'x', seq: 1 }));
    expect(again.kind).toBe('dropped');
    expect(group.messages.size).toBe(1);
    expect(group.syncedSeq).toBe(1);
  });

  it('walks through the whole 4.3.4 race table', () => {
    const group = emptyGroup(10);
    applyNew(group, message({ id: 'base', seq: 10 }));

    // seq == syncedSeq + 1 -> apply immediately
    expect(applyNew(group, message({ id: 'live', seq: 11 })).kind).toBe('applied');
    expect(group.syncedSeq).toBe(11);

    // seq > syncedSeq + 1 -> hold, do not apply
    group.pendingNew = [];
    const held = applyNew(group, message({ id: 'far', seq: 20 }));
    expect(held).toEqual({ kind: 'held', reason: 'gap' });
    expect(group.messages.has('far')).toBe(false);

    // seq <= syncedSeq -> dedupe by id and discard
    expect(applyNew(group, message({ id: 'live', seq: 11 })).kind).toBe('dropped');

    // edits and revokes are buffered while a replay is in flight, never dropped
    startReplay(group);
    expect(applyEvent(group, message({ id: 'live', seq: 11, body: '改', updatedAt: T('2026-09-13T12:05:00+08:00') })).kind)
      .toBe('held');
    expect(group.eventBuffer.length).toBe(1);
    // ...and the live copy is untouched until the replay ends
    expect(group.messages.get('live')?.body).toBe('m11');
  });

  it('applies a buffered event only if it is newer than what is stored', () => {
    const group = emptyGroup(0);
    applyNew(group, message({ id: 'e', seq: 1, updatedAt: T('2026-09-13T12:10:00+08:00') }));
    startReplay(group);
    applyEvent(group, message({ id: 'e', seq: 1, body: 'older', updatedAt: T('2026-09-13T12:09:00+08:00') }));
    applyPage(group, { items: [], asOfSeq: 1, hasMore: false });
    expect(group.messages.get('e')?.body).not.toBe('older');
  });

  it('replays current state, not events, so an offline revoke still lands', () => {
    // 4.3.5's counter-example: the client was away while seq 100 was sent and
    // then revoked. Replaying events would deliver a revoke for a message it has
    // never seen and drop it, leaving a bubble that should have disappeared.
    const group = emptyGroup(99);
    applyPage(group, {
      items: [message({ id: 'gone', seq: 100, body: null, deletedAt: T('2026-09-13T12:02:00+08:00'), updatedAt: T('2026-09-13T12:02:00+08:00') })],
      asOfSeq: 100,
      hasMore: false,
    });
    expect(group.syncedSeq).toBe(100);
    expect(group.messages.get('gone')?.deletedAt).not.toBeNull();
  });

  it('adopts asOfSeq unconditionally across a hole, and never backwards', () => {
    // docs/decisions/0005: rollback does not actually create holes with today's
    // allocator, but the client must still not assume contiguity, because a hard
    // delete removes whole ranges.
    const group = emptyGroup(104);
    applyPage(group, {
      items: [message({ id: 'p', seq: 106 }), message({ id: 'q', seq: 107 })],
      asOfSeq: 107,
      hasMore: false,
    });
    expect(group.syncedSeq).toBe(107);
    expect(orderedMessages(group).map((m) => m.seq)).toEqual([106, 107]);

    // An over-eager local watermark must not be walked back.
    applyPage(group, { items: [], asOfSeq: 105, hasMore: false });
    expect(group.syncedSeq).toBe(107);
  });

  it('reaches the same final state as a full pull, whichever interleaving happens', () => {
    // Acceptance item 4: inject message:new across a gap and message:updated
    // during the replay, then compare against a client that simply pulled once.
    const build = (interleaved: boolean): string => {
      const page1 = {
        items: [message({ id: 'a', seq: 1 }), message({ id: 'b', seq: 2 })],
        asOfSeq: 2,
        hasMore: true,
      };
      const page2 = {
        items: [
          message({ id: 'c', seq: 3 }),
          message({ id: 'b', seq: 2, body: 'b 改过', updatedAt: T('2026-09-13T12:20:00+08:00') }),
        ],
        asOfSeq: 3,
        hasMore: false,
      };

      if (!interleaved) {
        const straight = emptyGroup(0);
        applyPage(straight, page1);
        applyPage(straight, page2);
        return JSON.stringify(orderedMessages(straight));
      }

      const messy = emptyGroup(0);
      applyPage(messy, page1);
      startReplay(messy);
      // arrives while page 2 is still on the wire
      applyNew(messy, message({ id: 'd', seq: 9 }));
      applyEvent(messy, message({ id: 'b', seq: 2, body: 'b 改过', updatedAt: T('2026-09-13T12:20:00+08:00') }));
      applyPage(messy, page2);
      return JSON.stringify(
        orderedMessages(messy).filter((m) => m.seq <= 3),
      );
    };

    expect(build(true)).toBe(build(false));
  });

  it('does not let an edit for an unseen message corrupt ordering', () => {
    const group = emptyGroup(0);
    startReplay(group);
    applyEvent(group, message({ id: 'z', seq: 5, body: '改', updatedAt: T('2026-09-13T12:30:00+08:00') }));
    applyPage(group, { items: [message({ id: 'z', seq: 5, body: '原文' })], asOfSeq: 5, hasMore: false });
    // The replay is authoritative for current state, so it must not overwrite a
    // strictly newer edit that already arrived.
    expect(orderedMessages(group).map((m) => m.seq)).toEqual([5]);
  });
});
