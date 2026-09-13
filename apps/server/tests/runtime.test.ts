import { SignJWT } from 'jose';
import { io as createClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type Runtime } from '../src/runtime.js';

const secret = new TextEncoder().encode('test-secret');
const clients: Socket[] = [];
const runtimes: Runtime[] = [];

function onceSocket<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (...args: unknown[]) => resolve(args[0] as T));
  });
}

async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...overrides, sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

async function startRuntime() {
  const runtime = await buildApp({
    jwtSecret: secret,
    contractVersion: 'test-contract',
    getReadiness: async () => ({
      ok: true,
      checks: { db: 'up', meili: 'degraded', outboxLag: 0 },
    }),
    getGroupSyncState: async ({ groupId }) =>
      groupId === 'group-1' ? { lastSeq: 12 } : null,
  });
  await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  runtimes.push(runtime);
  const address = runtime.app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { runtime, url: `http://127.0.0.1:${address.port}` };
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
    const ready = onceSocket<{ groups: Array<{ groupId: string; lastSeq: number }>; contractVersion: string }>(client, 'sync:ready');
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
});
