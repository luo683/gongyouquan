import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createMessagesRepository } from '../../src/messages/repository.js';
import { createMessagesService } from '../../src/messages/service.js';
import { createSyncRepository } from '../../src/sync/repository.js';
import { createSyncService, type SyncService } from '../../src/sync/service.js';
import {
  createHarness,
  databaseUrl,
  expectCode,
  num,
  row0,
  type Harness,
  type Row,
} from './harness.js';
import type { MessageDto } from '@gongyouquan/contracts';

/**
 * Real-PostgreSQL acceptance for the replay half of spec 4.3: watermarks,
 * sync:pull, asOfSeq and the read positions that unread counts derive from.
 * Skipped without INTEGRATION_DATABASE_URL.
 */
const url = databaseUrl();
const harness: Harness = createHarness();

describe.runIf(url !== '')('sync + read positions (real PostgreSQL)', () => {
  let sync: SyncService;
  let messages: ReturnType<typeof createMessagesService>;
  let groupId: string;
  let otherGroup: string;
  let owner: string;
  let reader: string;
  let stranger: string;
  const seen = new Set<number>();

  beforeAll(async () => {
    await harness.up();
    const messagesRepo = createMessagesRepository(harness.db);
    const groupsRepo = createGroupsRepository(harness.db);
    sync = createSyncService({ repo: createSyncRepository(harness.db, messagesRepo), contractVersion: 'test-1' });
    messages = createMessagesService(messagesRepo, groupsRepo);
    owner = await harness.bootstrapUser();
    reader = await harness.insertUser(`reader-${harness.tag}`, '读者');
    stranger = await harness.insertUser(`stranger-${harness.tag}`, '路人');
    groupId = await harness.seedGroup(`同步群-${harness.tag}`);
    otherGroup = await harness.seedGroup(`另一群-${harness.tag}`);
    await harness.db.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
      [groupId, reader],
    );
  });

  afterAll(async () => {
    await harness.down();
  });

  async function post(sender: string, body: string): Promise<MessageDto> {
    const sent = await messages.send(sender, { groupId, clientMsgId: crypto.randomUUID(), kind: 'text', body });
    return sent.message;
  }

  it('reports watermarks only for groups the caller is actually in', async () => {
    const hello = await sync.hello(reader, { groups: [{ groupId, syncedSeq: 0 }, { groupId: otherGroup, syncedSeq: 0 }] });
    expect(hello.groups.map((g) => g.groupId)).toEqual([groupId]);
    expect(hello.contractVersion).toBe('test-1');

    // A stranger learns nothing, not even whether the group exists.
    const none = await sync.hello(stranger, { groups: [{ groupId, syncedSeq: 0 }] });
    expect(none.groups).toEqual([]);
  });

  it('replays exactly the rows above sinceSeq, ascending, in their current state', async () => {
    const sent: MessageDto[] = [];
    for (let i = 1; i <= 5; i += 1) sent.push(await post(owner, `断线期间 ${i}`));

    const page = await sync.pull(reader, { groupId, sinceSeq: 0, limit: 200 });
    expect(page.items.map((m) => m.seq)).toEqual(sent.map((m) => m.seq));
    expect(page.asOfSeq).toBe(sent[4]?.seq);
    expect(page.hasMore).toBe(false);
    for (const message of page.items) seen.add(message.seq);

    // Second page from the watermark is empty - a client must not re-apply.
    const next = await sync.pull(reader, { groupId, sinceSeq: page.asOfSeq, limit: 200 });
    expect(next.items).toEqual([]);
    expect(next.hasMore).toBe(false);

    // A revoked message comes back already carrying deleted_at. Replaying events
    // instead (4.3.5) would need the client to have seen the send first.
    const victim = await post(owner, '会被撤回');
    await messages.revoke(owner, victim.id);
    const afterRevoke = await sync.pull(reader, { groupId, sinceSeq: sent[4]?.seq ?? 0, limit: 200 });
    expect(afterRevoke.items.map((m) => m.id)).toContain(victim.id);
    expect(afterRevoke.items.find((m) => m.id === victim.id)?.deletedAt).not.toBeNull();
  });

  it('pages with a limit and never loses the tail', async () => {
    const all = await sync.pull(owner, { groupId, sinceSeq: 0, limit: 200 });
    const first = await sync.pull(owner, { groupId, sinceSeq: 0, limit: 3 });
    expect(first.items.map((m) => m.seq)).toEqual(all.items.slice(0, 3).map((m) => m.seq));
    expect(first.hasMore).toBe(true);
    expect(first.asOfSeq).toBe(all.items[2]?.seq);

    const second = await sync.pull(owner, { groupId, sinceSeq: first.asOfSeq, limit: 3 });
    expect(second.items.map((m) => m.seq)).toEqual(all.items.slice(3, 6).map((m) => m.seq));

    // Walking the pages must reproduce the single big pull exactly.
    const walked: number[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await sync.pull(owner, { groupId, sinceSeq: cursor, limit: 2 });
      walked.push(...page.items.map((m) => m.seq));
      if (!page.hasMore) {
        expect(page.asOfSeq).toBeGreaterThanOrEqual(cursor);
        break;
      }
      cursor = page.asOfSeq;
    }
    expect(walked).toEqual(all.items.map((m) => m.seq));
  });

  it('keeps one group invisible to a member of another group', async () => {
    // The regression this pins: the watermark query had no WHERE clause, so the
    // appended `AND g.id = ...` filtered the LEFT JOIN instead of the groups. Every
    // group the caller belonged to came back, which meant asking about a group you
    // were NOT in passed the membership check and handed over its messages.
    const elsewhere = await harness.seedGroup(`别处的群-${harness.tag}`);

    const hello = await sync.hello(reader, { groups: [{ groupId: elsewhere, syncedSeq: 0 }] });
    expect(hello.groups).toEqual([]);
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.pull(reader, { groupId: elsewhere, sinceSeq: 0, limit: 10 }));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.state(reader, elsewhere));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.read(reader, { groupId: elsewhere, lastReadSeq: 1 }));

    // With the caller genuinely in both, both come back - the filter is not simply
    // returning nothing.
    await harness.db.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
      [elsewhere, reader],
    );
    const both = await sync.hello(reader, {
      groups: [{ groupId, syncedSeq: 0 }, { groupId: elsewhere, syncedSeq: 0 }],
    });
    expect(both.groups.map((g) => g.groupId).sort()).toEqual([groupId, elsewhere].sort());
  });

    it('never sends asOfSeq backwards, which is what protects an over-eager client', async () => {
    // docs/decisions/0006 gap four: an empty page must not walk a client whose
    // local watermark already outruns the server back into re-applying messages.
    const stored = await harness.db.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
    const current = row0(stored.rows);
    const ahead = num(current.last_seq) + 100;

    const page = await sync.pull(owner, { groupId, sinceSeq: ahead, limit: 200 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.asOfSeq).toBe(ahead);
    expect(page.asOfSeq).toBeGreaterThanOrEqual(num(current.last_seq));
  });

  it('advances read positions with GREATEST, so a late report cannot drag them back', async () => {
    const state = await sync.state(reader, groupId);
    expect(state.myLastReadSeq).toBe(0);

    const advanced = await sync.read(reader, { groupId, lastReadSeq: 500 });
    expect(advanced.lastReadSeq).toBe(500);

    const late = await sync.read(reader, { groupId, lastReadSeq: 480 });
    expect(late.lastReadSeq).toBe(500);

    // The two halves are independent progress lines, per 4.4.1.
    const mentions = await sync.read(reader, { groupId, mentionsReadSeq: 7 });
    expect(mentions).toEqual({ lastReadSeq: 500, mentionsReadSeq: 7 });

    expect((await sync.state(reader, groupId)).myMentionsReadSeq).toBe(7);
  });

  it('drives the unread count in GET /groups down to zero through the real position', async () => {
    const groups = createGroupsRepository(harness.db);
    const listUnread = async (): Promise<number> => {
      const rows = await groups.listGroups(reader, false);
      return rows.find((g) => g.id === groupId)?.unreadCount ?? -1;
    };

    await post(owner, '未读一条');
    // Reset to a position below that message so the count is non-zero to begin with.
    await sync.read(reader, { groupId, lastReadSeq: 0 });
    await harness.db.query('UPDATE read_positions SET last_read_seq = 0 WHERE user_id = $1 AND group_id = $2', [
      reader,
      groupId,
    ]);
    const before = await listUnread();
    expect(before).toBeGreaterThan(0);

    const watermark = await sync.state(reader, groupId);
    await sync.read(reader, { groupId, lastReadSeq: watermark.lastSeq });
    expect(await listUnread()).toBe(0);

    // Own messages and system rows never count, whatever the position is.
    const asOwner = (await (await createGroupsRepository(harness.db).listGroups(owner, false)).find((g) => g.id === groupId))?.unreadCount;
    expect(asOwner).toBe(0);
    await harness.db.query(
      `INSERT INTO messages (group_id, seq, sender_id, kind, body)
       VALUES ($1, (SELECT last_seq + 1 FROM groups WHERE id = $1), NULL, 'system', '系统提示')`,
      [groupId],
    );
    await harness.db.query('UPDATE groups SET last_seq = last_seq + 1 WHERE id = $1', [groupId]);
    expect(await listUnread()).toBe(0);
  });

  it('refuses a non-member on every replay path with 403, not an empty page', async () => {
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.pull(stranger, { groupId, sinceSeq: 0, limit: 10 }));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.state(stranger, groupId));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.read(stranger, { groupId, lastReadSeq: 3 }));
    await expectCode('INVALID_ARGUMENT', () => sync.read(reader, { groupId }));
  });

  it('stops reporting a group to a member who was kicked', async () => {
    const beforeKick = await sync.state(reader, groupId);
    await harness.db.query('UPDATE group_members SET removed_at = now() WHERE group_id = $1 AND user_id = $2', [
      groupId,
      reader,
    ]);
    const hello = await sync.hello(reader, { groups: [{ groupId, syncedSeq: 0 }] });
    expect(hello.groups).toEqual([]);
    await expectCode('FORBIDDEN_NOT_MEMBER', () => sync.pull(reader, { groupId, sinceSeq: 0, limit: 10 }));

    // Rejoining revives the same row. Positions are keyed by (user, group) and were
    // never deleted, so a kicked-then-rejoined member is not handed a fresh wall of
    // unread for messages they had already read.
    await harness.db.query(
      'UPDATE group_members SET removed_at = NULL WHERE group_id = $1 AND user_id = $2',
      [groupId, reader],
    );
    const afterKick = await sync.state(reader, groupId);
    expect(afterKick).toEqual(beforeKick);
    expect(afterKick.myLastReadSeq).toBeGreaterThan(0);
  });
});
