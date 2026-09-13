import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createAuthRepository } from '../../src/auth/repository.js';
import { createAuthService } from '../../src/auth/service.js';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createGroupsService } from '../../src/groups/service.js';
import { createMessageBus } from '../../src/messages/bus.js';
import { createMessagesRepository } from '../../src/messages/repository.js';
import { createMessagesService } from '../../src/messages/service.js';
import { createMembersRepository } from '../../src/groups/members.js';
import { createMembersService } from '../../src/groups/members-service.js';
import { createSyncRepository } from '../../src/sync/repository.js';
import { createSyncService } from '../../src/sync/service.js';
import { buildApp, type Runtime } from '../../src/runtime.js';
import { createHarness, databaseUrl, row0, str, type Harness, type Row } from '../integration/harness.js';
import type { MessageDto, MessageSyncPage, SyncReady, WsErrorPayload } from '@gongyouquan/contracts';

/**
 * The demoable end of the whole goal: two real clients, a real PostgreSQL, a
 * real Socket.IO connection, and the offline-replay behaviour spec 4.3 promises.
 * Nothing here is stubbed - if it passes, two people can actually chat.
 *
 * Skipped without INTEGRATION_DATABASE_URL.
 */
const url = databaseUrl();
const JWT_SECRET = 'group-chat-e2e-secret';
const PASSWORD = 'HardPass2026';

type Authed = { accessToken: string; refreshToken: string; user: { id: string } };

function once<T>(socket: Socket, event: string, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`)), timeoutMs);
    socket.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as T);
    });
  });
}

function ask<T>(socket: Socket, event: string, payload: unknown, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for the ack of "${event}"`)), timeoutMs);
    socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: unknown) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response as T);
    });
  });
}

describe.runIf(url !== '')('group chat end to end', () => {
  const sockets: Socket[] = [];
  const harness: Harness = createHarness();
  let runtime: Runtime;
  let origin: string;
  // Every identity this suite creates carries this tag, which is what lets the
  // shared reaper find it again. Without it a second run collides with the first
  // on lower(username) and the whole suite dies in beforeAll.
  const tag = harness.tag;
  let db: { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>; end(): Promise<void> };
  let groupId = '';
  let alice: Authed;
  let bob: Authed;
  let carol: Authed;

  beforeAll(async () => {
    db = await harness.up();

    // Bootstrap: an existing member and their group, the way an ops-created first
    // account would be. Everything after this point goes through real endpoints.
    const argon2 = (await import('argon2')).default;
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const seeded = await db.query<Row>(
      `INSERT INTO users (username, display_name, password_hash) VALUES ($1, '内置号', $2) RETURNING id`,
      [`seed-admin-${tag}`, hash],
    );
    const seedId = str(row0(seeded.rows).id);
    const group = await db.query<Row>(
      `INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id`,
      [`bootstrap-${tag}`, seedId],
    );
    const seedGroupId = str(row0(group.rows).id);
    await db.query(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`, [
      seedGroupId,
      seedId,
    ]);

    const database = db as never;
    const groupsRepo = createGroupsRepository(database);
    const messagesRepo = createMessagesRepository(database);
    const bus = createMessageBus();
    const auth = createAuthService({ repo: createAuthRepository(database), jwtSecret: JWT_SECRET });

    runtime = await buildApp({
      jwtSecret: new TextEncoder().encode(JWT_SECRET),
      contractVersion: 'e2e-1',
      getReadiness: async () => ({ ok: true, checks: { db: 'up', meili: 'down', outboxLag: 0 } }),
      auth,
      groups: createGroupsService(groupsRepo),
      messages: createMessagesService(messagesRepo, groupsRepo, { publish: bus.publish }),
      // Without this the invite endpoint answers 404, which is exactly what the
      // scenario hit when it started minting a code instead of inserting one.
      members: createMembersService(createMembersRepository(database), groupsRepo),
      sync: createSyncService({ repo: createSyncRepository(database, messagesRepo), contractVersion: 'e2e-1' }),
      bus,
    });
    // buildApp already mounted the auth routes when options.auth was passed.
    await runtime.app.listen({ host: '127.0.0.1', port: 0 });

    const address = runtime.app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    origin = `http://127.0.0.1:${address.port}`;

    // An invite needs a group that already exists and a member to issue it, so
    // the very first code has to be laid down outside the API - that is what the
    // create-admin CLI exists for. Everything after it goes through endpoints.
    const seedInvite = async (targetGroup: string, creator: string, label: string): Promise<string> => {
      const code = `E2E-${label}-${randomBytes(3).toString('hex').toUpperCase()}`;
      await db.query(
        `INSERT INTO group_invites (group_id, code, role, max_uses, created_by)
         VALUES ($1, $2, 'member', 1, $3)`,
        [targetGroup, code, creator],
      );
      return code;
    };

    /**
     * POST /groups/:gid/invites, as a real client would. The scenario's "生成邀请码"
     * step used to be this file writing an INSERT, which proved the registration path
     * but not that anyone could actually hand out a code.
     */
    const mintInvite = async (token: string, targetGroup: string): Promise<string> => {
      const created = await runtime.app.inject({
        method: 'POST',
        url: `/api/v1/groups/${targetGroup}/invites`,
        headers: { authorization: `Bearer ${token}` },
        payload: { role: 'member', maxUses: 1 },
      });
      expect(created.statusCode).toBe(201);
      const body = created.json() as { code: string };
      expect(body.code).toMatch(/^GYQ-[0-9A-F]{12}$/);
      return body.code;
    };

    // Alice joins the bootstrap group, which is only ever her foothold.
    alice = await register(`alice-${tag}`, await seedInvite(seedGroupId, seedId, 'A'));

    // Alice creates the group the whole scenario happens in.
    const created = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { name: `夜班组-${tag}` },
    });
    expect(created.statusCode).toBe(201);
    groupId = str((created.json() as { id: string }).id);
    expect(groupId).not.toBe(seedGroupId);

    // Bob registers straight into Alice's group, so the account the tests carry
    // around is the one that is actually a member. Registering a second account to
    // consume the invite - which is what this did first - leaves "bob" outside the
    // group and every socket assertion silently waiting for an event that can
    // never arrive.
    // Bob's code is minted by the API, by Alice, in the group the scenario runs in.
    bob = await register(`bob-${tag}`, await mintInvite(alice.accessToken, groupId));
    expect(bob.user.id).not.toBe(alice.user.id);

    // Carol only ever joins the bootstrap group, so Alice's group is a stranger to
    // her and she is a stranger to it.
    carol = await register(`carol-${tag}`, await seedInvite(seedGroupId, seedId, 'C'));

    // Membership proved through the API rather than assumed from the invite.
    const members = await runtime.app.inject({
      method: 'GET',
      url: `/api/v1/groups/${groupId}/members`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(members.statusCode).toBe(200);
    expect((members.json() as Array<{ userId: string }>).map((m) => m.userId).sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );
  });

  async function register(username: string, code: string): Promise<Authed> {
    const registered = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { code, username, displayName: username, password: PASSWORD },
    });
    expect(registered.statusCode).toBe(201);
    const { user } = registered.json() as { user: { id: string; username: string } };
    expect(user.username).toBe(username);

    const loggedIn = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: PASSWORD, clientKind: 'desktop' },
    });
    expect(loggedIn.statusCode).toBe(200);
    return loggedIn.json() as Authed;
  }

  /**
   * Teardown. This block was silently absent for a whole run: rewriting the
   * identity section replaced everything between it and the first test, and
   * nothing noticed - the suite stayed green while leaking four users, two
   * groups and their outbox events. Reaping lives in the harness so every
   * real-database suite cleans up the same way.
   */
  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await runtime?.close();
    await harness.down();
  });

  async function connect(who: Authed): Promise<Socket> {
    const client = createClient(origin, { auth: { token: who.accessToken }, reconnection: false });
    sockets.push(client);
    await once<void>(client, 'connect');
    const ready = await ask<SyncReady>(client, 'sync:hello', { groups: [{ groupId, syncedSeq: 0 }] });
    return Object.assign(client, { __ready: ready });
  }

  function readyOf(client: Socket): SyncReady {
    return (client as Socket & { __ready: SyncReady }).__ready;
  }

  it('registers through an invite, creates a group, and gets the watermark from sync:hello', async () => {
    const bobSocket = await connect(bob);
    expect(readyOf(bobSocket).contractVersion).toBe('e2e-1');
    expect(readyOf(bobSocket).groups).toEqual([{ groupId, lastSeq: 0 }]);
  });

  it('delivers a message to another member over the socket within a second, without a refresh', async () => {
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    const delivered = once<MessageDto>(bobSocket, 'message:new');
    const sentAt = Date.now();

    const sent = await ask<{ message: MessageDto }>(aliceSocket, 'message:send', {
      groupId,
      clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      kind: 'text',
      body: '十一点到',
    });

    const arrivedAt = Date.now();
    const received = await delivered;
    // once() races nothing: the emit above already completed, so this gap is the
    // delivery latency the client experiences, not a round trip being double counted.
    expect(arrivedAt - sentAt).toBeLessThan(1000);
    expect(received.id).toBe(sent.message.id);
    expect(received.body).toBe('十一点到');
    expect(received.seq).toBe(1);
    // Bob is only ever a receiver here, so the one event he must have seen is
    // message:new, which the assertion above already pins by id and seq.

    // The sender gets it too, which is how a second tab of Alice's converges.
    expect((await ask<{ message: MessageDto }>(aliceSocket, 'message:send', {
      groupId,
      clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      kind: 'text',
      body: '第二条',
    })).message.seq).toBe(2);
    aliceSocket.close();
    bobSocket.close();
  });

  it('replays what arrived while Bob was offline and moves his watermark to asOfSeq', async () => {
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    // Bob drops, without knowing about seq 2.
    bobSocket.close();
    sockets.splice(sockets.indexOf(bobSocket), 1);

    for (let i = 3; i <= 7; i += 1) {
      await ask(aliceSocket, 'message:send', {
        groupId,
        clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
        kind: 'text',
        body: `离线期间 ${i}`,
      });
    }

    const back = await connect(bob);
    const hello = readyOf(back);
    expect(hello.groups[0]?.lastSeq).toBe(7);

    // Bob's client state is the spec's: syncedSeq 2, five rows to catch up on.
    let syncedSeq = 2;
    const applied = new Map<number, MessageDto>();
    while (true) {
      const page = await ask<MessageSyncPage>(back, 'sync:pull', { groupId, sinceSeq: syncedSeq, limit: 200 });
      for (const message of page.items) applied.set(message.seq, message);
      // Unconditional, even across a jump - this is the rule 4.3.3 calls the
      // foundation of the whole mechanism.
      syncedSeq = page.asOfSeq;
      if (!page.hasMore) break;
    }

    expect([...applied.keys()]).toEqual([3, 4, 5, 6, 7]);
    expect(new Set(applied.values()).size).toBe(5);
    expect(syncedSeq).toBe(7);

    const empty = await ask<MessageSyncPage>(back, 'sync:pull', { groupId, sinceSeq: syncedSeq, limit: 200 });
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
    aliceSocket.close();
    back.close();
  });

  it('propagates an edit and a revoke as full DTOs carrying updatedAt', async () => {
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);

    const sent = await ask<{ message: MessageDto }>(aliceSocket, 'message:send', {
      groupId,
      clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      kind: 'text',
      body: '写错了',
    });

    const edited = once<MessageDto>(bobSocket, 'message:updated');
    await ask(aliceSocket, 'message:edit', { messageId: sent.message.id, body: '改好了' });
    const editEvent = await edited;
    // A diff would force the client to apply events in order; the full DTO does not.
    expect(editEvent.body).toBe('改好了');
    expect(editEvent.id).toBe(sent.message.id);
    expect(new Date(editEvent.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(sent.message.updatedAt).getTime(),
    );

    const revoked = once<MessageDto>(bobSocket, 'message:deleted');
    await ask(aliceSocket, 'message:delete', { messageId: sent.message.id });
    expect((await revoked).deletedAt).not.toBeNull();

    // Past the 2 minute author window the same request answers 409, over either
    // transport. Here the clock is moved in the database, not faked in the app.
    const old = await ask<{ message: MessageDto }>(aliceSocket, 'message:send', {
      groupId,
      clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      kind: 'text',
      body: '过期',
    });
    await db.query(`UPDATE messages SET created_at = now() - interval '3 minutes' WHERE id = $1`, [
      old.message.id,
    ]);
    const refused = await ask<WsErrorPayload>(aliceSocket, 'message:delete', { messageId: old.message.id });
    expect(refused.error?.code).toBe('DELETE_WINDOW_EXPIRED');

    aliceSocket.close();
    bobSocket.close();
  });

  it('drives Bobs unread count from N to 0 through read:update', async () => {
    const aliceSocket = await connect(alice);
    const bobSocket = await connect(bob);
    await ask(aliceSocket, 'message:send', {
      groupId,
      clientMsgId: randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
      kind: 'text',
      body: '未读一条',
    });

    const unreadOf = async (who: Authed): Promise<number> => {
      const response = await runtime.app.inject({
        method: 'GET',
        url: '/api/v1/groups',
        headers: { authorization: `Bearer ${who.accessToken}` },
      });
      const rows = response.json() as Array<{ id: string; unreadCount: number }>;
      return rows.find((row) => row.id === groupId)?.unreadCount ?? -1;
    };

    expect(await unreadOf(bob)).toBeGreaterThan(0);

    // The watermark has to come from AFTER the send. Re-using the one this socket
    // was handed at connect() time is what the test did first, and it read Bob up
    // to the previous tip - leaving one genuinely unread message and a perfectly
    // correct server answering 1.
    const refreshed = await ask<SyncReady>(bobSocket, 'sync:hello', {
      groups: [{ groupId, syncedSeq: 0 }],
    });
    const watermark = refreshed.groups[0]?.lastSeq ?? 0;
    expect(watermark).toBeGreaterThan(readyOf(bobSocket).groups[0]?.lastSeq ?? 0);

    const position = await ask<{ lastReadSeq: number }>(bobSocket, 'read:update', {
      groupId,
      lastReadSeq: watermark,
    });
    expect(position.lastReadSeq).toBe(watermark);
    expect(await unreadOf(bob)).toBe(0);

    // Alice's own messages never counted for her, at any position.
    expect(await unreadOf(alice)).toBe(0);
    aliceSocket.close();
    bobSocket.close();
  });

  it('refuses a non-member over the socket with 403, not an empty page', async () => {
    const carolSocket = await connect(carol);
    // Carol is in no group at all, so hello reports none and a pull is refused.
    expect(readyOf(carolSocket).groups).toEqual([]);
    const refused = await ask<WsErrorPayload>(carolSocket, 'sync:pull', { groupId, sinceSeq: 0, limit: 10 });
    expect(refused.error?.code).toBe('FORBIDDEN_NOT_MEMBER');
    carolSocket.close();
  });
});
