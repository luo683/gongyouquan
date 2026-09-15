import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createAlertRepository } from '../../src/ops/alert-repository.js';
import { createAlertService } from '../../src/ops/alert-service.js';
import { createGroupsRepository } from '../../src/groups/repository.js';
import type { AlertHook, MessageDto } from '@gongyouquan/contracts';
import { createHarness, databaseUrl, num, row0, str, expectCode, type Row } from './harness.js';

/**
 * Real PostgreSQL. This is the only suite that can answer the questions the unit
 * tests cannot: does the aggregation window actually serialise concurrent
 * deliveries into one message, does a replay really cost no seq, and does the
 * count in the group message match the number of deliveries.
 */

const h = createHarness();
let groupId = '';
let repo: ReturnType<typeof createAlertRepository>;
let published: Array<{ event: string; message: MessageDto }> = [];
let alerts: ReturnType<typeof createAlertService>;

/** One source per test: alert_windows is global, so sharing a name would couple runs. */
function alertFor(over: Partial<AlertHook> & { title: string }): AlertHook {
  return {
    source: `gyq-it-${h.tag}`,
    severity: 'critical',
    // Carries the run tag so afterAll can find these rows: the harness cleans up
    // groups and messages, not the alert ledger, and a surviving agg_key would
    // poison the next run against the same database.
    idempotencyKey: `gyq-it-${h.tag}-k${Math.random().toString(36).slice(2)}`,
    ...over,
  };
}

beforeAll(async () => {
  if (databaseUrl() === '') return;
  await h.up();
  groupId = await h.seedGroup();
  repo = createAlertRepository(h.db);
  published = [];
  alerts = createAlertService({
    groups: createGroupsRepository(h.db),
    repo,
    publish: async (event, message) => {
      published.push({ event, message });
    },
    systemGroupId: groupId,
  });
});

afterAll(async () => {
  if (databaseUrl() === '') return;
  // The harness cleans up users and groups; these two tables hang off messages with
  // SET NULL / CASCADE, so their rows would outlive the group and the unique
  // agg_key would then be poisoned for the next run against this database.
  await h.db.query(`DELETE FROM alert_events WHERE fingerprint LIKE $1 OR idempotency_key LIKE $1`, [
    `gyq-it-${h.tag}%`,
  ]);
  await h.db.query(`DELETE FROM alert_windows WHERE source LIKE $1`, [`gyq-it-${h.tag}%`]);
  await h.down();
});

const gated = databaseUrl() === '' ? describe.skip : describe;

gated('/hooks/alert against a real database', () => {
  it('posts a system message with no author and writes its outbox row', async () => {
    published = [];
    const result = await alerts.ingest(alertFor({ title: '备份失败', detail: 'dump 不可读' }));

    expect(result.deduplicated).toBe(false);
    expect(result.messageId).not.toBeNull();

    const stored = await h.db.query<Row>(
      `SELECT sender_id, kind, body, meta, deleted_at FROM messages WHERE id = $1`,
      [result.messageId],
    );
    const row = row0(stored.rows);
    expect(row.sender_id).toBeNull();
    expect(str(row.kind)).toBe('system');
    expect(str(row.body)).toContain('【critical】备份失败');
    expect(str(row.body)).toContain('dump 不可读');
    // jsonb comes back already parsed; String()ing it would give "[object Object]".
    expect((row.meta as { alert: { hitCount: number } }).alert.hitCount).toBe(1);

    // Without this row an ops client that was offline during the alert never sees
    // it: the socket emit is live-only, the outbox is the durable half.
    const outbox = await h.db.query<Row>(
      `SELECT event_type, processed_at FROM outbox WHERE aggregate_type = 'message' AND aggregate_id = $1`,
      [result.messageId],
    );
    expect(str(row0(outbox.rows).event_type)).toBe('upsert');

    expect(published.map((p) => p.event)).toEqual(['message:new']);
  });

  it('merges a second delivery into the same message and counts it', async () => {
    const first = await alerts.ingest(alertFor({ title: '磁盘将满' }));
    const second = await alerts.ingest(alertFor({ title: '磁盘将满' }));

    expect(second.messageId).toBe(first.messageId);
    expect(second.deduplicated).toBe(false);

    const body = str(
      row0((await h.db.query<Row>('SELECT body FROM messages WHERE id = $1', [first.messageId])).rows).body,
    );
    expect(body).toContain('×2');

    const count = num(
      row0(
        (
          await h.db.query<Row>(
            `SELECT hit_count FROM alert_windows WHERE agg_key = $1`,
            [`gyq-it-${h.tag}\n磁盘将满`],
          )
        ).rows,
      ).hit_count,
    );
    expect(count).toBe(2);
  });

  it('answers a replayed idempotency key without touching the count or the seq', async () => {
    const key = `gyq-it-${h.tag}-replay-once`;
    const first = await alerts.ingest(alertFor({ title: '重复投递', idempotencyKey: key }));
    // Read after the first, which does allocate: the claim is that the *replay*
    // adds nothing - not a message, not a count, not a seq that later becomes a hole.
    const before = await h.db.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
    const replay = await alerts.ingest(alertFor({ title: '重复投递', idempotencyKey: key }));

    expect(replay).toEqual({ messageId: first.messageId, deduplicated: true });

    const after = await h.db.query<Row>('SELECT last_seq FROM groups WHERE id = $1', [groupId]);
    expect(num(row0(after.rows).last_seq)).toBe(num(row0(before.rows).last_seq));

    const window = row0(
      (
        await h.db.query<Row>(
          `SELECT hit_count FROM alert_windows WHERE agg_key = $1`,
          [`gyq-it-${h.tag}\n重复投递`],
        )
      ).rows,
    );
    expect(num(window.hit_count)).toBe(1);
  });

  it('keeps two titles from the same source as two messages', async () => {
    const a = await alerts.ingest(alertFor({ title: '备份失败' }));
    const b = await alerts.ingest(alertFor({ title: '证书快到期' }));
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('escalates the existing message when severity rises, and never falls back', async () => {
    const source = `gyq-it-${h.tag}-escalation`;
    const low = await alerts.ingest({ source, severity: 'warning', title: '内存水位', idempotencyKey: `${source}-1` });
    const high = await alerts.ingest({ source, severity: 'critical', title: '内存水位', idempotencyKey: `${source}-2` });
    const back = await alerts.ingest({ source, severity: 'info', title: '内存水位', idempotencyKey: `${source}-3` });

    expect(high.messageId).toBe(low.messageId);
    const bodyOf = async () =>
      str(row0((await h.db.query<Row>('SELECT body FROM messages WHERE id = $1', [low.messageId])).rows).body);
    expect(await bodyOf()).toContain('【critical】');
    // An info arriving after a critical must not downgrade the line: the ops group
    // is read by someone deciding whether to get up, and the worst seen is the
    // fact they need.
    expect(await bodyOf()).toContain('【critical】');
    expect(back.deduplicated).toBe(false);
  });

  it('opens a new message once the window is older than five minutes', async () => {
    const source = `gyq-it-${h.tag}-rollover`;
    const first = await alerts.ingest({ source, severity: 'warning', title: '队列积压', idempotencyKey: `${source}-1` });
    // Time travel rather than sleeping: the window is a database interval, and a
    // test that waited five minutes would still only prove the clock had passed.
    await h.db.query(`UPDATE alert_windows SET opened_at = now() - interval '6 minutes' WHERE source = $1`, [
      source,
    ]);
    const second = await alerts.ingest({ source, severity: 'warning', title: '队列积压', idempotencyKey: `${source}-2` });

    expect(second.messageId).not.toBe(first.messageId);
    const hits = await h.db.query<Row>(
      `SELECT hit_count FROM alert_windows WHERE source = $1 ORDER BY opened_at DESC LIMIT 1`,
      [source],
    );
    expect(num(row0(hits.rows).hit_count)).toBe(1);
    // The first line stays as history with its own count.
    const aged = str(
      row0((await h.db.query<Row>('SELECT body FROM messages WHERE id = $1', [first.messageId])).rows).body,
    );
    expect(aged).not.toContain('×');
  });

  it('does not carry a stale severity into the next window', async () => {
    const source = `gyq-it-${h.tag}-stale-severity`;
    const hot = await alerts.ingest({ source, severity: 'critical', title: '磁盘将满', idempotencyKey: `${source}-1` });
    await h.db.query(`UPDATE alert_windows SET opened_at = now() - interval '6 minutes' WHERE source = $1`, [
      source,
    ]);
    const calm = await alerts.ingest({ source, severity: 'info', title: '磁盘将满', idempotencyKey: `${source}-2` });

    expect(calm.messageId).not.toBe(hot.messageId);
    const bodyOf = async (id: string | null) =>
      str(row0((await h.db.query<Row>('SELECT body FROM messages WHERE id = $1', [id])).rows).body);
    // Within a window the highest seen wins; across a rollover the arriving alert
    // *is* the window's first hit. Inheriting critical would leave every later line
    // shouting about a disk that filled once at 03:00 and has been fine since.
    expect(await bodyOf(calm.messageId)).toContain('【info】');
    expect(await bodyOf(hot.messageId)).toContain('【critical】');
  });

  it('serialises twenty concurrent deliveries of one title into one message', async () => {
    const source = `gyq-it-${h.tag}-race`;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        alerts.ingest({ source, severity: 'warning', title: '并发风暴', idempotencyKey: `${source}-${i}` }),
      ),
    );

    const ids = new Set(results.map((r) => r.messageId));
    expect(ids.size).toBe(1);
    expect(results.every((r) => !r.deduplicated)).toBe(true);

    const window = row0(
      (await h.db.query<Row>('SELECT hit_count, message_id FROM alert_windows WHERE source = $1', [source])).rows,
    );
    // This is the whole point of doing the window upsert and the message insert in
    // one transaction: without the row lock as a mutex, N clients would each post
    // their own line and the count would drift below the real number.
    expect(num(window.hit_count)).toBe(20);
    expect(str(window.message_id)).toBe(str(results[0]?.messageId));

    const messages = await h.db.query<Row>(
      `SELECT count(*) AS n FROM messages WHERE group_id = $1 AND meta::text LIKE $2`,
      [groupId, `%${source}%`],
    );
    expect(num(row0(messages.rows).n)).toBe(1);
  });

  it('posts a fresh line when the aggregated message has been deleted', async () => {
    const source = `gyq-it-${h.tag}-deleted`;
    const first = await alerts.ingest({ source, severity: 'critical', title: '待删除', idempotencyKey: `${source}-1` });
    await h.db.query(`DELETE FROM messages WHERE id = $1`, [first.messageId]);
    const second = await alerts.ingest({ source, severity: 'critical', title: '待删除', idempotencyKey: `${source}-2` });

    expect(second.deduplicated).toBe(false);
    expect(second.messageId).not.toBe(first.messageId);
    // The replay of the *first* delivery now resolves through the window, since the
    // line it originally pointed at no longer exists.
    const replay = await alerts.ingest({ source, severity: 'critical', title: '待删除', idempotencyKey: `${source}-1` });
    expect(replay).toEqual({ messageId: second.messageId, deduplicated: true });
  });

  it('refuses an alert group that is not there, rather than half-recording it', async () => {
    const broken = createAlertService({
      groups: createGroupsRepository(h.db),
      repo,
      systemGroupId: '999999999',
    });
    await expectCode('OPS_GROUP_NOT_CONFIGURED', () => broken.ingest(alertFor({ title: '无处可去' })));
  });

  it('reports an unset group id as env-unset rather than as a mystery 500', async () => {
    const broken = createAlertService({
      groups: createGroupsRepository(h.db),
      repo,
    });
    await expectCode('OPS_GROUP_NOT_CONFIGURED', () => broken.ingest(alertFor({ title: '没配群' })));
  });
});
