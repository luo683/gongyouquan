import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth/service.js';
import { registerAuthRoutes, type AuthRouteService } from '../src/auth/routes.js';

function service(): AuthRouteService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    register: async () => ({
      user: { id: '1', username: 'worker', displayName: '工友' },
      groups: [{ id: 'group-1', role: 'member' as const }],
    }),
    login: async ({ clientKind }) => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      user: { id: '1', username: 'worker', displayName: '工友' },
    }),
    refresh: async (refreshToken, clientKind) => {
      calls.push(`refresh:${refreshToken}:${clientKind}`);
      return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 900,
        user: { id: '1', username: 'worker', displayName: '工友' },
      };
    },
    logoutAll: async () => {
      calls.push('logout-all');
      return 2;
    },
    logout: async (refreshToken) => {
      calls.push(`logout:${refreshToken}`);
    },
  };
}

describe('auth routes', () => {
  it('returns desktop login tokens without leaking internal fields', async () => {
    const app = Fastify();
    const auth = service();
    await registerAuthRoutes(app, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'worker', password: 'password123', clientKind: 'desktop' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 900,
      user: { id: '1', username: 'worker', displayName: '工友' },
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('stores the web refresh token in an HttpOnly cookie', async () => {
    const app = Fastify();
    await registerAuthRoutes(app, service());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'worker', password: 'password123', clientKind: 'web' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('refreshToken');
    expect(response.headers['set-cookie']).toContain(
      'refresh_token=refresh-token; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth',
    );
  });

  it('reads the web refresh token from the cookie and logs out with 204', async () => {
    const app = Fastify();
    const auth = service();
    await registerAuthRoutes(app, auth);

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'refresh_token=refresh-token' },
      payload: {},
    });
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: 'refresh_token=refresh-token' },
      payload: {},
    });

    expect(refresh.statusCode).toBe(200);
    expect(auth.calls).toContain('refresh:refresh-token:web');
    expect(logout.statusCode).toBe(204);
    expect(auth.calls).toContain('logout:refresh-token');
  });

  it('wraps invalid auth requests with a request id', async () => {
    const app = Fastify();
    await registerAuthRoutes(app, service());

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: '', password: '', clientKind: 'mobile' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'INVALID_ARGUMENT',
        requestId: expect.any(String),
      },
    });
  });

  it('maps auth service errors without exposing stack details', async () => {
    const app = Fastify();
    const auth = service();
    auth.login = async () => { throw new AuthError('AUTH_INVALID_CREDENTIALS'); };
    await registerAuthRoutes(app, auth);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'worker', password: 'wrongpass1', clientKind: 'desktop' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: 'AUTH_INVALID_CREDENTIALS', requestId: expect.any(String) },
    });
  });
});
