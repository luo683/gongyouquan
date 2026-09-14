import { SignJWT } from 'jose';
import { io as createClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type Runtime } from '../src/runtime.js';
import { createMetrics } from '../src/metrics.js';

const secret = new TextEncoder().encode('test-secret');
const clients: Socket[] = [];
const runtimes: Runtime[] = [];

function onceSocket<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (...args: unknown[]) => resolve(args[0] as T));
  });
}

async function token(subject = 'user-1', overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...overrides, sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

/**
 * Records everything received on an event. These tests assert on what does NOT
 * arrive as much as on what does - an echo to the sender, a second online
 * announcement for a second device, a typing relay to a socket that never joined
 * the room - and an absence is only provable against a listener that was attached
 * before the thing happened.
 */
function record<T>(socket: Socket, event: string): T[] {
  const seen: T[] = [];
  socket.on(event, (payload: unknown) => seen.push(payload as T));
  return seen;
}

async function startRuntime(extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const runtime = await buildApp({
    jwtSecret: secret,
    contractVersion: 'test-contract',
    getReadiness: async () => ({
      ok: true,
      checks: { db: 'up', meili: 'degraded', outboxLag: 0 },
    }),
    getGroupSyncState: async ({ groupId }) =>
      groupId === 'group-1' ? { lastSeq: 12 } : null,
    ...extra,
  });
  await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  runtimes.push(runtime);
  const address = runtime.app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { runtime, url: `http://127.0.0.1:${address.port}` };
}

async function connect(url: string, subject?: string): Promise<Socket> {
  const client = createClient(url, { auth: { token: await token(subject) }, reconnection: false });
  clients.push(client);
  await onceSocket<void>(client, 'connect');
  return client;
}

/** sync:hello is what joins the socket to group rooms, so typing has somewhere to go. */
async function joinRoom(client: Socket, groupId = 'group-1'): Promise<void> {
  await new Promise<unknown>((resolve) => {
    client.emit('sync:hello', { groups: [{ groupId, syncedSeq: 0 }] }, resolve);
  });
}

/** Give the server a turn to flush broadcasts before asserting on what arrived. */
function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

describe('server runtime', () => {
  it('authenticates Socket.IO and emits sync:ready for authorized groups only', async () => {
    const { url } = await startRuntime();
    const client = createClient(url, { auth: { token: await token() }, reconnection: false });
    clients.push(client);

    await onceSocket<void>(client, 'connect');
    const ready = onceSocket<{
      groups: Array<{ groupId: string; lastSeq: number }>;
      contractVersion: string;
      online: string[];
    }>(client, 'sync:ready');
    const ack = new Promise<unknown>((resolve) => {
      client.emit('sync:hello', { groups: [
        { groupId: 'group-1', syncedSeq: 0 },
        { groupId: 'group-2', syncedSeq: 0 },
      ] }, resolve);
    });

    const readyPayload = await ready;
    expect(readyPayload).toEqual({
      groups: [{ groupId: 'group-1', lastSeq: 12 }],
      contractVersion: 'test-contract',
      // No group-member resolver on this runtime, so the snapshot degrades to
      // empty rather than to undefined and a schema failure on the client.
      online: [],
    });
    expect(await ack).toEqual(readyPayload);
    expect(client.connected).toBe(true);
  });

  it('rejects a connection without a valid access token', async () => {
    const { url } = await startRuntime();
    const client = createClient(url, { auth: {}, reconnection: false });
    clients.push(client);

    const error = await onceSocket<Error>(client, 'connect_error');
    expect(error.message).toBe('UNAUTHENTICATED');
    expect(client.connected).toBe(false);
  });

  it('closes Socket.IO and Fastify exactly once', async () => {
    const { runtime, url } = await startRuntime();
    const client = createClient(url, { auth: { token: await token() }, reconnection: false });
    clients.push(client);
    await onceSocket<void>(client, 'connect');

    const disconnected = onceSocket<string>(client, 'disconnect');
    const first = runtime.close();
    const second = runtime.close();
    expect(second).toBe(first);
    await first;
    await disconnected;

    expect(client.connected).toBe(false);
  });

  it('relays typing to the room but not back to the sender', async () => {
    const { url } = await startRuntime();
    const sender = await connect(url, 'user-1');
    const peer = await connect(url, 'user-2');
    await joinRoom(sender);
    await joinRoom(peer);

    const atPeer = record<{ groupId: string; userId: string }>(peer, 'typing:start');
    const atSender = record<unknown>(sender, 'typing:start');

    sender.emit('typing:start', { groupId: 'group-1' });
    await settle();

    // The payload carries the sender's id, which is the part the spec's
    // client-to-server row cannot express and its server-to-client row omits.
    expect(atPeer).toEqual([{ groupId: 'group-1', userId: 'user-1' }]);
    expect(atSender).toEqual([]);
  });

  it('drops typing from a socket that never joined the room', async () => {
    const { url } = await startRuntime();
    const member = await connect(url, 'user-2');
    await joinRoom(member);
    // Authenticated, but it never sent sync:hello, so it is in no group room.
    const stranger = await connect(url, 'user-1');

    const seen = record<unknown>(member, 'typing:start');
    stranger.emit('typing:start', { groupId: 'group-1' });
    await settle();

    /**
     * `socket.to(room)` delivers to a room whether or not the sender is in it, so
     * without the room check this arrives - and a stranger could put "someone is
     * typing" into any group they liked, attributed to any userId they liked.
     */
    expect(seen).toEqual([]);
  });

  it('announces presence once per user, not once per socket', async () => {
    const { url } = await startRuntime({ getPresenceGroups: async () => ['group-1'] });
    const watcher = await connect(url, 'user-2');
    await joinRoom(watcher);
    // Let the watcher's own arrival flush past before listening, or it records
    // itself and every count below is off by one.
    await settle();
    const events = record<{ groupId: string; userId: string; online: boolean; at: string }>(
      watcher,
      'presence:updated',
    );

    const desktop = await connect(url, 'user-1');
    await settle();
    expect(events).toEqual([
      { groupId: 'group-1', userId: 'user-1', online: true, at: expect.any(String) },
    ]);

    // Their browser connects. Same person, so the group hears nothing.
    const browser = await connect(url, 'user-1');
    await settle();
    expect(events.filter((event) => event.online)).toHaveLength(1);

    // Closing the tab while the desktop is open must not say they left.
    desktop.close();
    await settle();
    expect(events.filter((event) => !event.online)).toHaveLength(0);

    browser.close();
    await settle();
    expect(events.filter((event) => !event.online)).toEqual([
      { groupId: 'group-1', userId: 'user-1', online: false, at: expect.any(String) },
    ]);
  });

  it('hands a fresh connection the online snapshot it cannot infer from events', async () => {
    // user-3 is a member the resolver knows about but who never connects, and
    // user-1 connects. The snapshot has to be the intersection, not the whole
    // presence map and not the whole member list.
    const { url } = await startRuntime({ getGroupMemberIds: async () => ['user-1', 'user-2', 'user-3'] });

    const first = await connect(url, 'user-1');
    const firstReady = onceSocket<{ online: string[] }>(first, 'sync:ready');
    await new Promise<unknown>((resolve) => {
      first.emit('sync:hello', { groups: [{ groupId: 'group-1', syncedSeq: 0 }] }, resolve);
    });
    // Nobody else is connected yet, and the caller is never in their own snapshot.
    expect((await firstReady).online).toEqual([]);

    const second = await connect(url, 'user-2');
    const secondReady = onceSocket<{ online: string[] }>(second, 'sync:ready');
    second.emit('sync:hello', { groups: [{ groupId: 'group-1', syncedSeq: 0 }] });
    /**
     * This is the case the snapshot exists for: without it user-2 would have to
     * wait for user-1 to reconnect before learning they were there, and every dot
     * in the UI would read offline after a page reload.
     */
    expect((await secondReady).online).toEqual(['user-1']);
  });

  it('still runs a handler whose client forgot the ack callback', async () => {
    const { url } = await startRuntime();
    const deaf = await connect(url, 'user-1');
    // No ack function. This used to make the server skip the handler entirely, so
    // the socket never joined its room and then heard nothing at all - no error, no
    // ack, no broadcast, and nothing in the logs to point at the missing callback.
    deaf.emit('sync:hello', { groups: [{ groupId: 'group-1', syncedSeq: 0 }] });
    await settle();

    const heard = record<{ groupId: string; userId: string }>(deaf, 'typing:start');
    const peer = await connect(url, 'user-2');
    await joinRoom(peer);

    // A typing relay only reaches sockets inside group:group-1, so hearing it is
    // proof the ackless sync:hello above really did run and really did join.
    peer.emit('typing:start', { groupId: 'group-1' });
    await settle();

    expect(heard).toEqual([{ groupId: 'group-1', userId: 'user-2' }]);
  });

  it('serves /internal/metrics to loopback and refuses the rest without the token', async () => {
    const { runtime } = await startRuntime({
      createMetrics: ({ wsConnections, presence }) =>
        createMetrics({
          wsConnections,
          presenceMapSize: () => presence.size(),
          presenceSocketCount: () => presence.socketCount(),
          poolStats: () => ({ total: 20, idle: 19, waiting: 0 }),
          outboxPending: async () => 0,
          outboxLagSeconds: async () => 0,
          contractVersion: 'test-contract',
        }),
      internalMetricsToken: 'sekrit',
    });

    const loopback = await runtime.app.inject({ method: 'GET', url: '/internal/metrics' });
    expect(loopback.statusCode).toBe(200);
    expect(loopback.json()).toMatchObject({ contractVersion: 'test-contract', pgPoolTotal: 20 });

    // Caddy does not proxy /internal, so this should be unreachable in practice.
    // The route does not rely on that: the Caddyfile is a file somebody can edit,
    // and the payload is reconnaissance material.
    const outside = await runtime.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      remoteAddress: '203.0.113.9',
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('FORBIDDEN_ROLE');

    const withToken = await runtime.app.inject({
      method: 'GET',
      url: '/internal/metrics',
      remoteAddress: '203.0.113.9',
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(withToken.statusCode).toBe(200);
  });
});
