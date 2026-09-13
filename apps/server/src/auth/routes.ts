import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authLoginSchema, authRefreshSchema, authRegisterSchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded, RateLimitedError, statusForErrorCode } from '../http/errors.js';
import { LIMITS, type RateLimiter } from '../http/rate-limit.js';
import { AuthError, type PublicUser } from './service.js';

type AuthRegisterResult = {
  user: PublicUser;
  groups: Array<{ id: string; role: 'owner' | 'admin' | 'member' }>;
};

type AuthResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
};

export type AuthRouteService = {
  register(input: {
    code: string;
    username: string;
    displayName: string;
    password: string;
  }): Promise<{ user: PublicUser; groups: Array<{ id: string; role: 'owner' | 'admin' | 'member' }> }>;
  login(input: {
    username: string;
    password: string;
    clientKind: 'desktop' | 'web';
  }): Promise<AuthResult>;
  refresh(refreshToken: string, clientKind?: 'desktop' | 'web'): Promise<AuthResult>;
  logout(refreshToken: string): Promise<void>;
  /** Spec 5.2 answers {revokedCount}: how many sessions this identity had live. */
  logoutAll(userId: string): Promise<number>;
};

function cookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(';').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function statusFor(code: string): number {
  return statusForErrorCode(code);
}

function errorResponse(request: FastifyRequest, code: string, details?: unknown) {
  return errorEnvelope(request, code, details);
}

/**
 * Thin alias over the shared guarded() rather than a second implementation.
 * The local version used to map only AuthError, so a RateLimitedError left
 * this handler as a 500 - and it could not emit Retry-After at all, because
 * that lives in errors.ts. Two error mappers in one app is how a 429 becomes
 * an internal error.
 */
async function run<T>(
  request: FastifyRequest,
  fn: () => Promise<T>,
  reply: FastifyReply,
): Promise<T | undefined> {
  return guarded(request, reply, fn);
}

export type AuthRouteOptions = {
  /**
   * Omitted only so the route tests can mount these handlers without a policy.
   * main.ts always passes one. Spec 8.2 puts the check ahead of any database work
   * - a limiter that runs after Argon2 has verified a password has already paid
   * for the attack - so each gate is the first statement inside the handler
   * callback, before the service is touched.
   */
  limiter?: RateLimiter;
  /** Guards the session-scope endpoints; the public three stay open by design. */
  requireAuth?: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
};

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthRouteService,
  options: AuthRouteOptions = {},
): Promise<void> {
  const { limiter, requireAuth } = options;

  function gate(scope: string, key: string, limit: number, windowMs: number): void {
    if (!limiter) return;
    const decision = limiter.take(`${scope}:${key}`, limit, windowMs);
    // RateLimitedError rather than a bare HttpError is what makes run()/guarded()
    // attach Retry-After on the way out.
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, scope);
  }
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = authRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const created = await run<AuthRegisterResult>(request, async () => {
      // Invite codes look guessable, so registration is brute-forceable too.
      gate('auth/register:ip', request.ip, LIMITS.registerPerIp.limit, LIMITS.registerPerIp.windowMs);
      return auth.register(parsed.data);
    }, reply);
    // 201, matching POST /groups. The spec fixes neither status code, but two
    // endpoints that both create a resource answering differently is the sort of
    // thing a client silently gets wrong. Registered in docs/decisions/0003.
    if (created) return reply.status(201).send(created);
    return undefined;
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = authLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const result = await run<AuthResult>(request, async () => {
      // Both dimensions, always: IP-only is bypassed by rotating addresses against
      // one account; username-only by rotating accounts from one box.
      gate('auth/login:ip', request.ip, LIMITS.loginPerIp.limit, LIMITS.loginPerIp.windowMs);
      gate(
        'auth/login:user',
        parsed.data.username.toLowerCase(),
        LIMITS.loginPerUser.limit,
        LIMITS.loginPerUser.windowMs,
      );
      return auth.login(parsed.data);
    }, reply);
    if (!result) return;
    if (parsed.data.clientKind === 'web') {
      reply.header('set-cookie', `refresh_token=${encodeURIComponent(result.refreshToken)}; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`);
      const { refreshToken: _, ...webResult } = result;
      return reply.send(webResult);
    }
    return reply.send(result);
  });

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const parsed = authRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const token = parsed.data.refreshToken ?? cookies(request).refresh_token;
    if (!token) return reply.status(401).send(errorResponse(request, 'REFRESH_INVALID'));
    const clientKind = parsed.data.refreshToken ? 'desktop' : 'web';
    const result = await run<AuthResult>(request, () => auth.refresh(token, clientKind), reply);
    if (!result) return;
    if (clientKind === 'web') {
      reply.header('set-cookie', `refresh_token=${encodeURIComponent(result.refreshToken)}; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`);
      const { refreshToken: _, ...webResult } = result;
      return reply.send(webResult);
    }
    return reply.send(result);
  });

  if (requireAuth) {
    app.post('/api/v1/auth/logout-all', { preHandler: requireAuth }, async (request, reply) => {
      const userId = request.user?.id;
      if (!userId) throw new Error('requireAuth must run before the handler');
      const revoked = await guarded(request, reply, () => auth.logoutAll(userId));
      if (revoked !== undefined) return reply.send({ revokedCount: revoked });
      return undefined;
    });
  }

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const parsed = authRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const token = parsed.data.refreshToken ?? cookies(request).refresh_token;
    if (token) await auth.logout(token);
    return reply.status(204).send();
  });
}
