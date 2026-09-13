import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authLoginSchema, authRefreshSchema, authRegisterSchema } from '@gongyouquan/contracts';
import { errorEnvelope, statusForErrorCode } from '../http/errors.js';
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

async function run<T>(
  request: FastifyRequest,
  fn: () => Promise<T>,
  reply: { status(code: number): { send(body: unknown): unknown } },
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const code = error instanceof AuthError ? error.code : 'INTERNAL_ERROR';
    reply.status(statusFor(code)).send(errorResponse(request, code));
    return undefined;
  }
}

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthRouteService): Promise<void> {
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = authRegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const created = await run<AuthRegisterResult>(request, () => auth.register(parsed.data), reply);
    // 201, matching POST /groups. The spec fixes neither status code, but two
    // endpoints that both create a resource answering differently is the sort of
    // thing a client silently gets wrong. Registered in docs/decisions/0003.
    if (created) return reply.status(201).send(created);
    return undefined;
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = authLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const result = await run<AuthResult>(request, () => auth.login(parsed.data), reply);
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

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const parsed = authRefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send(errorResponse(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const token = parsed.data.refreshToken ?? cookies(request).refresh_token;
    if (token) await auth.logout(token);
    return reply.status(204).send();
  });
}
