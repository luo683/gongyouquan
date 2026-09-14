import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MentionNewEvent } from '@gongyouquan/contracts';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createMessagesRepository } from '../../src/messages/repository.js';
import { createMessagesService, type MessagesService } from '../../src/messages/service.js';
import { createSyncRepository } from '../../src/sync/repository.js';
import { createSyncService, type SyncService } from '../../src/sync/service.js';
import { createHarness, databaseUrl, num, row0, str, type Harness, type Row } from './harness.js';

/**
 * Real-PostgreSQL acceptance for @提及 (spec 6.6, route table line 637, event line
 * 751). Skipped without INTEGRATION_DATABASE_URL.
 *
 * Two of these need a real database rather than a fake: the mention rows are
 * written inside the send transaction, so a fake cannot show whether a rolled-back
 * send leaves them behind; and the unread flag is derived by comparing seq against
 * read_positions.mentions_read_seq in SQL, which is exactly the kind of expression
 * that reads correctly and evaluates wrongly.
 */
const url = databaseUrl();
const harness: Harness = createHarness();

describe.runIf(url !== '')('mentions (real PostgreSQL)', () => {
  let messages: MessagesService;
  let sync: SyncService;
  /** Every mention:new the service tried to publish, with its intended recipient. */
  const published: Array<{ toUserId: string; event: MentionNewEvent }> = [];
  let groupId: string;
  let otherGroup: string;
  let author: string;
  let target: string;
  let outsider: string;

  beforeAll(async () => {
    await harness.up();
    const messagesRepo = createMessagesRepository(harness.db);
    const groupsRepo = createGroupsRepository(harness.db);
    messages = createMessagesService(messagesRepo, groupsRepo, {
      publishMention: (event, toUserId) => {
        published.push({ toUserId, event });
      },
    });
    sync = createSyncService({ repo: createSyncRepository(harness.db, messagesRepo), contractVersion: 'test-1' });

    author = await harness.bootstrapUser();
    target = await harness.insertUser(`target-${harness.tag}`, '被提及的人');
    outsider = await harness.insertUser(`outsider-${harness.tag}`, '群外的人');

    groupId = await harness.seedGroup(`提及群-${harness.tag}`);
    otherGroup = await harness.seedGroup(`另一个群-${harness.tag}`);
    for (const group of [groupId, otherGroup]) {
      await harness.db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')`, [
        group,
        target,
      ]);
    }
  });

  afterAll(async () => {
    await harness.down();
  });

  async function post(body: string, mentions?: string[]) {
    const sent = await messages.send(author, {
      groupId,
      clientMsgId: crypto.randomUUID(),
      kind: 'text',
      body,
      ...(mentions ? { mentions } : {}),
    });
    return sent.message;
  }

  async function storedMentions(messageId: string): Promise<string[]> {
    const result = await harness.db.query<Row>(
      'SELECT mentioned_user_id FROM message_mentions WHERE message_id = $1 ORDER BY mentioned_user_id',
      [messageId],
    );
    return result.rows.map((row) => str(row.mentioned_user_id));
  }

  it('writes the mention rows and hands them back on the message', async () => {
    const message = await post('@被提及的人 明天记得带尺', [target]);

    expect(message.mentions).toEqual([target]);
    expect(await storedMentions(message.id)).toEqual([target]);

    // group_id and seq are denormalised so 6.6 can answer "@我未读" from one index.
    const row = row0(
      (await harness.db.query<Row>('SELECT group_id, seq FROM message_mentions WHERE message_id = $1', [message.id]))
        .rows,
    );
    expect(str(row.group_id)).toBe(groupId);
    expect(num(row.seq)).toBe(message.seq);

    expect(published).toEqual([{ toUserId: target, event: { messageId: message.id, groupId, fromUserId: author } }]);
  });

  it('drops a mention of somebody who is not in the group, rather than failing the send', async () => {
    published.length = 0;
    const message = await post('有人能看下吗', [outsider, target]);

    // outsider is a real user but not a member. Writing the row would push a
    // notification into the personal room of someone who has never been in this
    // group, which is the whole reason membership is checked server-side.
    expect(await storedMentions(message.id)).toEqual([target]);
    expect(published.map((entry) => entry.toUserId)).toEqual([target]);
    // The message itself is not held hostage to one stale id.
    expect(message.body).toBe('有人能看下吗');
  });

  it('drops self-mentions and collapses duplicates', async () => {
    published.length = 0;
    const message = await post('自言自语', [author, target, target, target]);

    expect(await storedMentions(message.id)).toEqual([target]);
    // One notification per person per message, however many times they were listed.
    expect(published).toHaveLength(1);
  });

  it('does not notify anybody twice for a retried send', async () => {
    published.length = 0;
    const clientMsgId = crypto.randomUUID();
    const first = await messages.send(author, { groupId, clientMsgId, kind: 'text', body: '重发一次', mentions: [target] });
    const second = await messages.send(author, { groupId, clientMsgId, kind: 'text', body: '重发一次', mentions: [target] });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(published).toHaveLength(1);
    expect(await storedMentions(first.message.id)).toEqual([target]);
  });

  it('lists mentions across groups, newest first, with the group name a bare id cannot convey', async () => {
    const inOther = await messages.send(author, {
      groupId: otherGroup,
      clientMsgId: crypto.randomUUID(),
      kind: 'text',
      body: '另一个群里的提及',
      mentions: [target],
    });

    const page = await messages.mentions(target, { unreadOnly: false, limit: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    // Newest first, and spanning both groups - the list is not scoped to one room.
    expect(page.items[0]?.messageId).toBe(inOther.message.id);
    expect(page.items[0]?.groupName).toContain('另一个群');
    expect(page.items.every((item) => item.unread)).toBe(true);

    const seen = page.items.map((item) => item.messageId);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('derives unread from mentions_read_seq, independently of last_read_seq', async () => {
    const before = await messages.mentions(target, { unreadOnly: true, limit: 50 });
    expect(before.items.length).toBeGreaterThan(0);

    // Reading the room to the newest message advances last_read_seq only. 6.6 keeps
    // the two lines separate on purpose: having read the messages is not the same
    // as having dealt with the ones that named you.
    const state = await sync.state(target, groupId);
    await sync.read(target, { groupId, lastReadSeq: state.lastSeq });
    const stillUnread = await messages.mentions(target, { unreadOnly: true, limit: 50 });
    expect(stillUnread.items.length).toBe(before.items.length);

    // Advancing the mentions line is what clears them.
    await sync.read(target, { groupId, mentionsReadSeq: state.lastSeq });
    const cleared = await messages.mentions(target, { unreadOnly: true, limit: 50 });
    expect(cleared.items.filter((item) => item.groupId === groupId)).toEqual([]);
  });

  it('withholds the body of a revoked message, which /raw gates behind owner and admin', async () => {
    const secret = '撤回前含有敏感内容';
    const message = await post(secret, [target]);
    expect((await messages.mentions(target, { unreadOnly: false, limit: 50 })).items
      .find((item) => item.messageId === message.id)?.body).toBe(secret);

    await messages.revoke(author, message.id);

    const after = (await messages.mentions(target, { unreadOnly: false, limit: 50 })).items.find(
      (item) => item.messageId === message.id,
    );
    /**
     * The row stays - being told you were mentioned is not the same as being shown
     * what was said - but the text is gone. Returning it here would let any member
     * read what /messages/:mid/raw deliberately restricts to owner and admin.
     */
    expect(after).toBeDefined();
    expect(after?.body).toBeNull();
  });

  it('pages with a cursor and never repeats or skips a row', async () => {
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await messages.mentions(target, { unreadOnly: false, cursor, limit: 2 });
      walked.push(...page.items.map((item) => item.messageId));
      if (!page.hasMore) break;
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor ?? undefined;
    }
    const whole = await messages.mentions(target, { unreadOnly: false, limit: 50 });
    expect(walked).toEqual(whole.items.map((item) => item.messageId));
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('answers an empty list for somebody who was never mentioned', async () => {
    const page = await messages.mentions(outsider, { unreadOnly: false, limit: 50 });
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });
});
