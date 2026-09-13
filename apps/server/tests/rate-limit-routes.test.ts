import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAuthRoutes, type AuthRouteService } from '../src/auth/routes.js';
import type { MessageRepository } from '../src/messages/repository.js';
import { createMessagesService } from '../src/messages/service.js';
import { createRateLimiter, LIMITS, type RateLimiter } from '../src/http/rate-limit.js';
import { errorEnvelope } from '../src/http/errors.js';

function fakeAuth(): AuthRouteService & { calls: string[] } {
  const calls: string[] = [];
  const result = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresIn: 900,
    user: { id: '1', username: 'worker', displayName: '工友' },
  };
  return {
    calls,
    register: async (input: { username: string }) => {
      calls.push(`register:${input.username}`);
      return { user: result.user, groups: [{ id: '7', role: 'member' as const }] };
    },
    login: async (input: { username: string }) => {
      calls.push(`login:${input.username}`);
      return result;
    },
    refresh: async () => result,
    logout: async () => undefined,
    logoutAll: async () => {
      calls.push('logout-all');
      return 3;
    },
  };
}

/** Records every bucket key the handlers ask about, so wiring can be proved. */
function spyLimiter(taken: string[]): RateLimiter {
  const real = createRateLimiter();
  return {
    take(key, limit, windowMs) {
      taken.push(`${key}|${limit}|${windowMs}`);
      return real.take(key, limit, windowMs);
    },
    reset: () => real.reset(),
    size: () => real.size(),
  };
}

async function authApp(limiter?: RateLimiter) {
  const app = Fastify();
  const auth = fakeAuth();
    await registerAuthRoutes(app, auth, { limiter });
  return { app, auth };
}

describe('auth rate limits (spec 8.2)', () => {
  it('refuses the sixth login in a minute and says how long to wait', async () => {
    const taken: string[] = [];
    const { app } = await authApp(spyLimiter(taken));

    for (let i = 0; i < 5; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'worker', password: 'password123', clientKind: 'desktop' },
      });
      expect(ok.statusCode).toBe(200);
    }

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'worker', password: 'password123', clientKind: 'desktop' },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(refused.json().error.details.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // 8.1 requires the header, not just a number in the body.
    expect(refused.headers['retry-after']).toBeDefined();
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('takes both login dimensions on every attempt, not one of them', async () => {
    const taken: string[] = [];
    const { app } = await authApp(spyLimiter(taken));
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'WorKer', password: 'password123', clientKind: 'desktop' },
    });

    // IP-only is bypassed by rotating addresses; username-only by rotating
    // accounts. The spec says both, and the key proves both were consulted.
    expect(taken.some((entry) => entry.startsWith('auth/login:ip:'))).toBe(true);
    const userEntry = taken.find((entry) => entry.startsWith('auth/login:user:'));
    expect(userEntry).toBeDefined();
    // The account dimension is case-folded, because login is.
    expect(userEntry).toContain('worker');
    expect(userEntry).toContain(`|${LIMITS.loginPerUser.limit}|${LIMITS.loginPerUser.windowMs}`);
  });

  it('refuses the fourth registration from one address in an hour', async () => {
    const { app } = await authApp(createRateLimiter());
    const attempt = (username: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          code: 'INV-1',
          username,
          displayName: username,
          password: 'password123',
        },
      });

    for (const name of ['a1', 'a2', 'a3']) expect((await attempt(name)).statusCode).toBe(201);
    const fourth = await attempt('a4');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.code).toBe('RATE_LIMITED');
  });

  it('reports how many sessions logout-all revoked, and refuses an anonymous caller', async () => {
    const app = Fastify();
    const auth = fakeAuth();
    // Mirrors createAuthenticator's real contract: a refusal is answered by
    // writing the 401 onto the reply, not by throwing. Throwing makes Fastify
    // answer 500, and the test would then be asserting something untrue.
    const authenticator = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.headers.authorization) {
        return reply.status(401).send(errorEnvelope(request, 'UNAUTHENTICATED'));
      }
      request.user = { id: '1', sessionId: 'session-1' };
      return undefined;
    };
    await registerAuthRoutes(app, auth, {
      // The routes take an authenticator from the runtime; stand one up here.
      requireAuth: authenticator as never,
    });

    const anonymous = await app.inject({ method: 'POST', url: '/api/v1/auth/logout-all' });
    expect(anonymous.statusCode).toBe(401);
    expect(auth.calls).not.toContain('logout-all');

    const signed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: { authorization: 'Bearer whatever' },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toEqual({ revokedCount: 3 });
    expect(auth.calls).toContain('logout-all');
  });
});

describe('message send rate limits', () => {
  /** Counts repository calls: a refused send must cost zero database work. */
  function countingRepo(counters: { send: number }) {
    const repo = {
      async send() {
        counters.send += 1;
        return {
          kind: 'created' as const,
          message: {
            id: '1',
            groupId: '7',
            seq: counters.send,
            senderId: 'u1',
            clientMsgId: null,
            kind: 'text' as const,
            body: 'hi',
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
          },
        };
      },
    } as unknown as MessageRepository;
    const groups = {
      async getGroup() {
        return { id: '7' };
      },
      async getMembership() {
        return { role: 'member' as const, archived: false };
      },
    };
    return { repo, groups };
  }

  it('refuses the 31st message to one group in a minute without touching the database', async () => {
    const counters = { send: 0 };
    const { repo, groups } = countingRepo(counters);
    const service = createMessagesService(repo, groups as never, { limiter: createRateLimiter() });

    for (let i = 0; i < 30; i += 1) {
      await service.send('u1', {
        groupId: '7',
        clientMsgId: crypto.randomUUID(),
        kind: 'text',
        body: `m${i}`,
      });
    }
    expect(counters.send).toBe(30);

    await expect(
      service.send('u1', { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'too much' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // The limit is worth nothing if it runs after the query it is guarding.
    expect(counters.send).toBe(30);
  });

  it('counts per user and group, so flooding one group cannot starve another', async () => {
    const counters = { send: 0 };
    const { repo, groups } = countingRepo(counters);
    const service = createMessagesService(repo, groups as never, { limiter: createRateLimiter() });

    for (let i = 0; i < 30; i += 1) {
      await service.send('u1', { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' });
    }
    await expect(
      service.send('u1', { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    // Same user, different group: the group-scoped bucket is separate...
    await expect(
      service.send('u1', { groupId: '8', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' }),
    ).resolves.toBeTruthy();
  });

  it('shares one counter between the HTTP and socket paths by living on the service', async () => {
    const counters = { send: 0 };
    const { repo, groups } = countingRepo(counters);
    const limiter = createRateLimiter();
    const service = createMessagesService(repo, groups as never, { limiter });

    // Both transports call the same method, so the bucket cannot be doubled by
    // switching transports mid-flood - which is what spec 8.2 is guarding.
    const app = Fastify();
    await app.register(async (instance) => {
      const { registerMessageRoutes } = await import('../src/messages/routes.js');
      // The real authenticator puts the verified subject on request.user, which
      // is what actor() reads; a preHandler that only returns would 500 instead.
      await registerMessageRoutes(instance, service, async (request) => {
        (request as { user?: { id: string } }).user = { id: 'u1' };
      });
    });

    for (let i = 0; i < 30; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/groups/7/messages',
        payload: { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' },
      });
      expect(response.statusCode).toBe(201);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/7/messages',
      payload: { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' },
    });
    expect(overflow.statusCode).toBe(429);
    expect(counters.send).toBe(30);

    // The socket path on the same service is already out of tokens.
    await expect(
      service.send('u1', { groupId: '7', clientMsgId: crypto.randomUUID(), kind: 'text', body: 'x' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});
