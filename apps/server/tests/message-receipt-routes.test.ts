import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAuthenticator } from '../src/http/auth.js';
import { registerMessageRoutes } from '../src/messages/routes.js';
import type { MessagesService } from '../src/messages/service.js';

const secret = new TextEncoder().encode('test-secret');

async function accessToken(sub: string): Promise<string> {
  return new SignJWT({ sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

type Call = { actor: string; groupId: string; messageId: string; detail: boolean };

/**
 * Only the receipts surface matters here; the SQL behind it is pinned against a
 * real database in tests/integration/receipts.test.ts. What this file exists to
 * catch is the tier flag crossing the HTTP boundary - the schema turns ?detail=1
 * into the number 1, and a handler comparing it to the string '1' would silently
 * serve the cheap aggregate to every client that asked for names.
 */
function appWithReceipts(): { app: ReturnType<typeof Fastify>; calls: Call[] } {
  const calls: Call[] = [];
  const service = {
    async receipts(actor: string, groupId: string, messageId: string, detail: boolean) {
      calls.push({ actor, groupId, messageId, detail });
      return detail
        ? { readCount: 1, totalMembers: 3, readers: [{ userId: '77', displayName: '工友甲', lastReadSeq: 12 }] }
        : { readCount: 1, totalMembers: 3 };
    },
  } as unknown as MessagesService;

  const app = Fastify();
  void registerMessageRoutes(app, service, createAuthenticator(secret));
  return { app, calls };
}

function get(app: ReturnType<typeof Fastify>, url: string, token?: string) {
  return app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe('receipts http slice', () => {
  const url = '/api/v1/groups/10/messages/55/receipts';

  it('defaults to the cheap aggregate tier', async () => {
    const { app, calls } = appWithReceipts();
    const token = await accessToken('42');

    const response = await get(app, url, token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ readCount: 1, totalMembers: 3 });
    expect(calls).toEqual([{ actor: '42', groupId: '10', messageId: '55', detail: false }]);
  });

  it('passes the name-list tier through as a boolean, not as the raw query string', async () => {
    const { app, calls } = appWithReceipts();
    const token = await accessToken('42');

    expect((await get(app, `${url}?detail=0`, token)).statusCode).toBe(200);
    expect((await get(app, `${url}?detail=1`, token)).statusCode).toBe(200);
    expect(calls.map((call) => call.detail)).toEqual([false, true]);
    expect(calls[1]?.groupId).toBe('10');
    expect(calls[1]?.messageId).toBe('55');
  });

  it('rejects a tier that is not one of the two the spec defines, before calling the service', async () => {
    const { app, calls } = appWithReceipts();
    const token = await accessToken('42');

    for (const bad of ['2', '', 'true', 'all']) {
      const response = await get(app, `${url}?detail=${bad}`, token);
      expect(response.statusCode, `detail=${bad}`).toBe(400);
      expect(response.json().error.code).toBe('INVALID_ARGUMENT');
    }
    expect(calls).toEqual([]);
  });

  it('needs a bearer token', async () => {
    const { app, calls } = appWithReceipts();
    const response = await get(app, url);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
    expect(calls).toEqual([]);
  });
});
