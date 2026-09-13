import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authLoginSchema, authRefreshSchema, authRegisterSchema } from '@gongyouquan/contracts';
import { AuthError, type PublicUser } from './service.js';

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
  if (code === 'INVALID_ARGUMENT' || code === 'INVITE_INVALID') return 400;
  if (code === 'AUTH_INVALID_CREDENTIALS' || code === 'REFRESH_INVALID' || code === 'REFRESH_REUSED') return 401;
  if (code === 'ACCOUNT_DISABLED') return 403;
  return 500;
}

function errorResponse(request: FastifyRequest, code: string, details?: unknown) {
  return {
    error: {
      code,
      message: code.toLowerCase().replaceAll('_', ' '),
      ...(details === undefined ? {} : { details }),
      requestId: request.id,
    },
  };
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
    return run(request, () => auth.register(parsed.data), reply);
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
