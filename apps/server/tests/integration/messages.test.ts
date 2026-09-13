import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createMessagesRepository } from '../../src/messages/repository.js';
import { createMessagesService, type MessagesService } from '../../src/messages/service.js';
import { databaseUrl, num, row0, str, createHarness, expectCode, type Harness, type Row } from './harness.js';

/**
 * Real-PostgreSQL acceptance for the message write path (docs/specs/01 §10
 * acceptance items 2, 3, 5, 6, 8). Skipped without INTEGRATION_DATABASE_URL.
 *
 * The windows are the reason this needs a database at all: they are compared
 * against the server clock inside the UPDATE, so the only honest way to test
 * 14:59 versus 15:01 is to move created_at and let PostgreSQL decide.
 */
const url = databaseUrl();
const harness: Harness = createHarness();

describe.runIf(url !== '')('messages write path (real PostgreSQL)', () => {
  let messages: MessagesService;
  let groupId: string;
  let owner: string;
  let mate: string;
  let stranger: string;

  beforeAll(async () => {
    await harness.up();
    const groupsRepo = createGroupsRepository(harness.db);
    messages = createMessagesService(createMessagesRepository(harness.db), groupsRepo);
    owner = await harness.bootstrapUser();
    mate = await harness.insertUser(`mate-${harness.tag}`, '工友乙');
    stranger = await harness.insertUser(`stranger-${harness.tag}`, '路人');
    groupId = await harness.seedGroup(`砖群-${harness.tag}`);
    // mate joins as a plain member; stranger is never added.
    await harness.db.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`,
      [groupId, mate],
    );
  });

  afterAll(async () => {
    await harness.down();
  });

  function send(author: string, body = '搬砖') {
    return messages.send(author, { groupId, clientMsgId: randomUUID(), kind: 'text', body });
  }

  it('allocates seq through alloc_group_seq and records the outbox event in the same transaction', async () => {
    const before = await harness.db.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
    const { message, deduplicated } = await send(owner, '三点集合');

    expect(deduplicated).toBe(false);
    expect(message.seq).toBe(num(row0(before.rows).last_seq) + 1);
    expect(message.kind).toBe('text');
    expect(message.senderId).toBe(owner);
    expect(message.deletedAt).toBeNull();
    expect(message.attachments).toEqual([]);
    expect(message.mentions).toEqual([]);
    // DTO timestamps must be parseable ISO-8601, which the contract enforces.
    expect(new Date(message.updatedAt).getTime()).toBeGreaterThan(0);

    const outbox = await harness.db.query<Row>(
      `SELECT aggregate_type, event_type, processed_at, payload FROM outbox
        WHERE aggregate_id = $1`,
      [message.id],
    );
    const event = row0(outbox.rows);
    expect(event.aggregate_type).toBe('message');
    expect(event.event_type).toBe('upsert');
    expect(event.processed_at).toBeNull();
    // node-pg hands jsonb back already parsed; re-parsing an object throws.
    expect((event.payload as { seq: number }).seq).toBe(message.seq);
  });

  it('answers a replayed clientMsgId with the original row instead of a second copy', async () => {
    const clientMsgId = randomUUID();
    const input = { groupId, clientMsgId, kind: 'text' as const, body: '网不好，重发' };

    const first = await messages.send(owner, input);
    const second = await messages.send(owner, input);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    // The loser's allocated seq is handed back by the rollback, so last_seq moves once.
    expect(second.message.seq).toBe(first.message.seq);

    const rows = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM messages WHERE sender_id = $1 AND client_msg_id = $2`,
      [owner, clientMsgId],
    );
    expect(num(row0(rows.rows).c)).toBe(1);
  });

  it('lets five simultaneous retries of one clientMsgId collapse to one message', async () => {
    const clientMsgId = randomUUID();
    const input = { groupId, clientMsgId, kind: 'text' as const, body: '并发重发' };

    const results = await Promise.all(Array.from({ length: 5 }, () => messages.send(mate, input)));
    const ids = new Set(results.map((r) => r.message.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.deduplicated).length).toBe(4);

    const seqs = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM messages WHERE sender_id = $1 AND client_msg_id = $2`,
      [mate, clientMsgId],
    );
    expect(num(row0(seqs.rows).c)).toBe(1);
  });

  it('pages history oldest-first with a beforeSeq cursor', async () => {
    const page1 = await messages.history(owner, groupId, { limit: 2 });
    expect(page1.items.map((m) => m.seq)).toEqual([...page1.items.map((m) => m.seq)].sort((a, b) => a - b));
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(String(page1.items[0]?.seq));

    const before = Number(page1.nextCursor);
    const page2 = await messages.history(owner, groupId, { beforeSeq: before, limit: 50 });
    const overlap = page2.items.filter((m) => page1.items.some((p) => p.seq === m.seq));
    expect(overlap).toEqual([]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('refuses a stranger and honours a member on the same group', async () => {
    await expectCode('FORBIDDEN_NOT_MEMBER', () => messages.history(stranger, groupId, { limit: 50 }));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => send(stranger));
    // A member's own message is always fine.
    expect((await send(mate, '收到')).deduplicated).toBe(false);
  });

  it('enforces the 15 minute edit window against the database clock', async () => {
    const { message } = await send(owner, '14:59');
    const edited = await messages.edit(owner, message.id, '14:59 改过');
    expect(edited.body).toBe('14:59 改过');
    expect(edited.editedAt).not.toBeNull();
    // 0002 exists so that an edit moves updated_at, which is what 4.3.4 compares.
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(message.updatedAt).getTime());

    const stale = (await send(owner, '旧消息')).message;
    await backdate(stale.id, '16 minutes');
    await expectCode('EDIT_WINDOW_EXPIRED', () => messages.edit(owner, stale.id, '太晚了'));

    await expectCode('FORBIDDEN_ROLE', () => messages.edit(mate, stale.id, '不是我的'));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => messages.edit(stranger, stale.id, '不是群里人'));
    await expectCode('NOT_FOUND', () => messages.edit(owner, '999999999', '不存在'));
  });

  it('applies the 2 minute window to your own message and exempts moderators only for others', async () => {
    // Spec 3.4 is two rows. The window belongs to 撤回自己的消息 and does not
    // care about your role; the no-deadline branch is 撤回他人的消息 only.
    const mine = (await send(mate, '我自己撤')).message;
    await messages.revoke(mate, mine.id);
    const revoked = await harness.db.query<Row>(
      `SELECT deleted_at, deleted_by, seq, body FROM messages WHERE id = $1`,
      [mine.id],
    );
    const row = row0(revoked.rows);
    expect(row.deleted_at).not.toBeNull();
    expect(str(row.deleted_by)).toBe(mate);
    // Soft delete keeps the row addressable - the trail is the whole point.
    expect(num(row.seq)).toBe(mine.seq);
    expect(str(row.body)).toBe('我自己撤');

    // A repeat revoke is still a success: DELETE is idempotent, and a client
    // retrying over a weak link must not be shown a failure for done work.
    await messages.revoke(mate, mine.id);

    const aged = (await send(mate, '放久了的')).message;
    await backdate(aged.id, '3 minutes');
    await expectCode('DELETE_WINDOW_EXPIRED', () => messages.revoke(mate, aged.id));

    // The author is locked out past the window, but an owner may still revoke
    // someone else's message at any age.
    await messages.revoke(owner, aged.id);
    const moderated = await harness.db.query<Row>(
      `SELECT deleted_by FROM messages WHERE id = $1`,
      [aged.id],
    );
    expect(str(row0(moderated.rows).deleted_by)).toBe(owner);

    // A plain member may not touch a peer at all.
    const peers = (await send(owner, '群主的')).message;
    await expectCode('FORBIDDEN_ROLE', () => messages.revoke(mate, peers.id));
  });

  it('shows revoked originals to moderators and answers 403 to members', async () => {
    const { message } = await send(mate, '秘密');
    await messages.revoke(mate, message.id);

    const raw = await messages.raw(owner, message.id);
    expect(raw.body).toBe('秘密');
    expect(raw.deletedBy).toBe(mate);

    await expectCode('FORBIDDEN_ROLE', () => messages.raw(mate, message.id));
    await expectCode('FORBIDDEN_NOT_MEMBER', () => messages.raw(stranger, message.id));
    // Asking for the original of a live message is a state error, not a secret.
    const live = await send(owner, '还在');
    await expectCode('STATE_MACHINE_VIOLATION', () => messages.raw(owner, live.message.id));
  });

  it('leaves an archived group readable but refuses writes with 409', async () => {
    const quiet = await harness.seedGroup(`归档群-${harness.tag}`);
    const before = await messages.send(owner, {
      groupId: quiet,
      clientMsgId: randomUUID(),
      kind: 'text',
      body: '归档前发的',
    });
    await harness.db.query('UPDATE groups SET is_archived = true WHERE id = $1', [quiet]);

    // Reads stay open (decision 0004): the group is still in the history list.
    expect((await messages.history(owner, quiet, { limit: 5 })).items.map((m) => m.id)).toContain(
      before.message.id,
    );

    const attempt = { groupId: quiet, clientMsgId: randomUUID(), kind: 'text' } as const;
    await expectCode('GROUP_ARCHIVED', () => messages.send(owner, { ...attempt, body: '归档后不能发' }));
    await expectCode('GROUP_ARCHIVED', () => messages.edit(owner, before.message.id, '归档后不能改'));
    await expectCode('GROUP_ARCHIVED', () => messages.revoke(owner, before.message.id));

    // An archived refusal must not have written anything at all.
    const untouched = await harness.db.query<Row>(
      `SELECT body, deleted_at FROM messages WHERE id = $1`,
      [before.message.id],
    );
    expect(str(row0(untouched.rows).body)).toBe('归档前发的');
    expect(row0(untouched.rows).deleted_at).toBeNull();
  });

  it('writes an outbox event for edits and revokes too, not only for sends', async () => {
    const { message } = await send(owner, '计数');
    const countOf = async (): Promise<number> => {
      const counted = await harness.db.query<Row>(
        `SELECT count(*) AS c FROM outbox WHERE aggregate_id = $1`,
        [message.id],
      );
      return num(row0(counted.rows).c);
    };

    expect(await countOf()).toBe(1);
    await messages.edit(owner, message.id, '计数 改');
    expect(await countOf()).toBe(2);
    await messages.revoke(owner, message.id);
    expect(await countOf()).toBe(3);
  });

  it('rejects kinds this round cannot persist', async () => {
    await expectCode('INVALID_ARGUMENT', () =>
      messages.send(owner, { groupId, clientMsgId: randomUUID(), kind: 'image', body: '图' }),
    );
    await expectCode('INVALID_ARGUMENT', () =>
      messages.send(owner, { groupId, clientMsgId: randomUUID(), kind: 'system', body: '冒充系统' }),
    );
    await expectCode('INVALID_ARGUMENT', () =>
      messages.send(owner, { groupId, clientMsgId: randomUUID(), kind: 'text', body: '   ' }),
    );
    await expectCode('INVALID_ARGUMENT', () =>
      messages.send(owner, { groupId, clientMsgId: 'not-a-uuid', kind: 'text', body: '幂等键不是 UUID' }),
    );
  });

  async function backdate(messageId: string, age: string): Promise<void> {
    await harness.db.query(
      `UPDATE messages SET created_at = now() - interval '${age}' WHERE id = $1`,
      [messageId],
    );
  }
});
