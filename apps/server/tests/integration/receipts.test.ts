import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createMessagesRepository } from '../../src/messages/repository.js';
import { createMessagesService, type MessagesService } from '../../src/messages/service.js';
import { createSyncRepository } from '../../src/sync/repository.js';
import { createSyncService, type SyncService } from '../../src/sync/service.js';
import {
  createHarness,
  databaseUrl,
  expectCode,
  num,
  row0,
  str,
  type Harness,
  type Row,
} from './harness.js';
import type { MessageDto } from '@gongyouquan/contracts';

/**
 * Real-PostgreSQL acceptance for read receipts (spec 4.4.3, §10 acceptance item
 * 9). Skipped without INTEGRATION_DATABASE_URL.
 *
 * This needs a real database for the same reason the other suites do: the whole
 * feature is one aggregate over read_positions joined to group_members, and the
 * two ways to get it wrong - counting a soft-removed member's stale position, and
 * writing `<> NULL` for a system message's sender - both return a plausible
 * number rather than an error.
 */
const url = databaseUrl();
const harness: Harness = createHarness();

describe.runIf(url !== '')('read receipts (real PostgreSQL)', () => {
  let messages: MessagesService;
  let sync: SyncService;
  let groupId: string;
  let elsewhere: string;
  /** The sender, whose own position proves nothing about anyone else. */
  let owner: string;
  let reached: string;
  let behind: string;
  /** Never reports a position at all, so has no read_positions row. */
  let silent: string;
  /** Read everything, then left: the soft-deleted row must stop counting. */
  let gone: string;
  let stranger: string;
  let target: MessageDto;

  beforeAll(async () => {
    await harness.up();
    const messagesRepo = createMessagesRepository(harness.db);
    messages = createMessagesService(messagesRepo, createGroupsRepository(harness.db));
    sync = createSyncService({ repo: createSyncRepository(harness.db, messagesRepo), contractVersion: 'test-1' });

    owner = await harness.bootstrapUser();
    reached = await harness.insertUser(`reached-${harness.tag}`, '读到了');
    behind = await harness.insertUser(`behind-${harness.tag}`, '差一条');
    silent = await harness.insertUser(`silent-${harness.tag}`, '没读');
    gone = await harness.insertUser(`gone-${harness.tag}`, '离职的');
    stranger = await harness.insertUser(`stranger-${harness.tag}`, '路人');

    groupId = await harness.seedGroup(`回执群-${harness.tag}`);
    elsewhere = await harness.seedGroup(`别的群-${harness.tag}`);
    for (const member of [reached, behind, silent, gone]) {
      await harness.db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [
        groupId,
        member,
      ]);
    }
  });

  afterAll(async () => {
    await harness.down();
  });

  it('counts positions at or past the message, drops the sender and the removed member', async () => {
    target = (
      await messages.send(owner, {
        groupId,
        clientMsgId: crypto.randomUUID(),
        kind: 'text',
        body: '明天几点上工',
      })
    ).message;

    await sync.read(reached, { groupId, lastReadSeq: target.seq });
    await sync.read(behind, { groupId, lastReadSeq: target.seq - 1 });
    // gone reads everything and then leaves. sync.read enforces membership, so the
    // position has to exist before the removal - which is also the realistic order,
    // and precisely why a stale row is left behind for the aggregate to ignore.
    await sync.read(gone, { groupId, lastReadSeq: target.seq + 50 });
    await harness.db.query('UPDATE group_members SET removed_at = now() WHERE group_id = $1 AND user_id = $2', [
      groupId,
      gone,
    ]);

    // One assertion covers all three rules in spec line 1631: reached counts,
    // behind is one short, silent has no row, owner is the sender, gone left.
    // The denominator is 3 for the same reason the numerator excludes owner -
    // otherwise a fully read room could never show anything but 2/3.
    const summary = await messages.receipts(owner, groupId, target.id, false);
    expect(summary).toEqual({ readCount: 1, totalMembers: 3 });
    expect(summary.readers).toBeUndefined();
  });

  it('pays for the name list only on the detail tier', async () => {
    await sync.read(behind, { groupId, lastReadSeq: target.seq + 5 });

    const detailed = await messages.receipts(owner, groupId, target.id, true);
    expect(detailed.readCount).toBe(2);
    expect(detailed.totalMembers).toBe(3);
    // Newest position first, so an expanding list reads as "who has caught up".
    expect(detailed.readers).toEqual([
      { userId: behind, displayName: '差一条', lastReadSeq: target.seq + 5 },
      { userId: reached, displayName: '读到了', lastReadSeq: target.seq },
    ]);
    expect(detailed.readers?.length).toBe(detailed.readCount);
  });

  it('treats a position as 追认 for every message below it (spec 4.4.4)', async () => {
    const later = (
      await messages.send(owner, { groupId, clientMsgId: crypto.randomUUID(), kind: 'text', body: '六点' })
    ).message;

    // silent is the one member who has never reported a position, so they are in
    // no name list yet. Asserting on their presence rather than on an absolute
    // count keeps this independent of the positions earlier tests left behind.
    const beforeJump = await messages.receipts(owner, groupId, later.id, true);
    expect(beforeJump.readers?.map((reader) => reader.userId)).not.toContain(silent);

    // Jumping straight to the newest message marks the older one read too, even
    // though silent never scrolled back to it. Inherent to a position model, and
    // the reason spec 4.4.4 wants the client to say 已读到此 rather than 已读.
    await sync.read(silent, { groupId, lastReadSeq: later.seq });

    expect((await messages.receipts(owner, groupId, later.id, true)).readers?.map((reader) => reader.userId)).toContain(
      silent,
    );
    const older = await messages.receipts(owner, groupId, target.id, true);
    expect(older.readers?.map((reader) => reader.userId)).toContain(silent);
  });

  it('counts the whole room for a system message, which has no sender to exclude', async () => {
    const inserted = await harness.db.query<Row>(
      `INSERT INTO messages (group_id, seq, sender_id, kind, body)
       VALUES ($1, alloc_group_seq($1), NULL, 'system', '工期变更通知') RETURNING id, seq`,
      [groupId],
    );
    const row = row0(inserted.rows);
    const systemId = str(row.id);

    // senderId is NULL here, and `user_id <> NULL` is NULL rather than true: the
    // plain comparison this replaced dropped every row and reported 0/0 for a room
    // of four. IS DISTINCT FROM reads NULL as "no sender to exclude", so owner is
    // back in the denominator - four active members, gone having left.
    const before = await messages.receipts(owner, groupId, systemId, false);
    expect(before.totalMembers).toBe(4);
    expect(before.readers).toBeUndefined();

    await sync.read(owner, { groupId, lastReadSeq: num(row.seq) });
    const after = await messages.receipts(owner, groupId, systemId, true);
    // Relative on purpose: earlier tests left positions above this seq behind, so
    // the honest claim is that owner reading adds exactly one reader.
    expect(after.readCount).toBe(before.readCount + 1);
    expect(after.readers?.map((reader) => reader.userId)).toContain(owner);
    expect(after.totalMembers).toBe(4);
  });

  it('answers 403 to a non-member and 404 to a path that does not name this message', async () => {
    await expectCode('FORBIDDEN_NOT_MEMBER', () => messages.receipts(stranger, groupId, target.id, false));

    // stranger is a member of elsewhere, not of groupId. Passing their own group
    // id with someone else's message must be indistinguishable from an id that
    // never existed, or the error code becomes a probe for other groups' messages.
    await harness.db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [
      elsewhere,
      stranger,
    ]);
    await expectCode('NOT_FOUND', () => messages.receipts(stranger, elsewhere, target.id, false));
    await expectCode('NOT_FOUND', () => messages.receipts(stranger, elsewhere, '999999999', false));
    await expectCode('NOT_FOUND', () => messages.receipts(owner, groupId, '999999999', false));
  });

  it('still reports receipts for a revoked message, whose position was really read', async () => {
    const victim = (
      await messages.send(owner, { groupId, clientMsgId: crypto.randomUUID(), kind: 'text', body: '写错了' })
    ).message;
    await sync.read(reached, { groupId, lastReadSeq: victim.seq });
    await messages.revoke(owner, victim.id);

    const receipts = await messages.receipts(owner, groupId, victim.id, false);
    expect(receipts.readCount).toBeGreaterThanOrEqual(1);
    expect(receipts.totalMembers).toBe(3);
  });
});
