import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from '../src/health.js';

describe('health routes', () => {
  it('reports a live process without checking dependencies', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, {
      getReadiness: async () => ({
        ok: false,
        checks: { db: 'down', meili: 'down', outboxLag: null },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns 503 when the database is not ready', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, {
      getReadiness: async () => ({
        ok: false,
        checks: { db: 'down', meili: 'degraded', outboxLag: null },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_READY',
        message: 'service is not ready',
        requestId: expect.any(String),
        details: {
          checks: { db: 'down', meili: 'degraded', outboxLag: null },
        },
      },
    });
  });

  it('keeps ready when Meilisearch is degraded', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, {
      getReadiness: async () => ({
        ok: true,
        checks: { db: 'up', meili: 'down', outboxLag: 0 },
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      checks: { db: 'up', meili: 'down', outboxLag: 0 },
    });
  });
});
