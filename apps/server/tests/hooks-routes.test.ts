import Fastify, { type FastifyRequest } from 'fastify';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AlertHook, AlertHookResult } from '@gongyouquan/contracts';
import { createAlertSignatureVerifier } from '../src/ops/hmac.js';
import { registerHookRoutes, type HookRouteDeps } from '../src/ops/hooks-routes.js';
import { createRateLimiter } from '../src/http/rate-limit.js';
import { HttpError } from '../src/http/errors.js';

const SECRET = 'hook-secret';

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}\n${body}`).digest('hex')}`;
}

function headersFor(body: string, over: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'content-type': 'application/json',
    'x-alert-timestamp': String(timestamp),
    'x-alert-signature': sign(body, timestamp),
    ...over,
  };
}

const ALERT: AlertHook = {
  source: 'backup',
  severity: 'critical',
  title: '备份失败',
  detail: 'FATAL: dump 不可读',
  idempotencyKey: 'idem-1',
};

type Recorded = { calls: AlertHook[]; result: AlertHookResult };

function deps(over: Partial<HookRouteDeps> = {}): { app: ReturnType<typeof Fastify>; rec: Recorded } & HookRouteDeps {
  const rec: Recorded = {
    calls: [],
    result: { messageId: '501', deduplicated: false },
  };
  const app = Fastify();
  const routeDeps: HookRouteDeps = {
    verifier: createAlertSignatureVerifier({ secret: SECRET }),
    ingest: async (alert) => {
      rec.calls.push(alert);
      return rec.result;
    },
    ...over,
  };
  return { app, rec, ...routeDeps };
}

describe('POST /api/v1/hooks/alert', () => {
  it('accepts a signed alert and returns the message id', async () => {
    const { app, rec, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify(ALERT);

    const response = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers: headersFor(payload) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ messageId: '501', deduplicated: false });
    expect(rec.calls).toEqual([ALERT]);
    await app.close();
  });

  it('verifies the exact bytes, not a canonicalisation of them', async () => {
    const { app, rec, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    // Two spaces inside the JSON: a signature over the compact form must not match.
    const signed = JSON.stringify(ALERT);
    const sent = signed.replace('{"source"', '{  "source"');

    const good = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload: signed, headers: headersFor(signed) });
    const tampered = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload: sent, headers: headersFor(signed) });

    expect(good.statusCode).toBe(200);
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json().error.code).toBe('HOOK_SIGNATURE_INVALID');
    expect(rec.calls).toHaveLength(1);
    await app.close();
  });

  it('answers 401 with the reason and never reaches the service', async () => {
    for (const [label, mutate] of [
      ['wrong secret', (b: string, t: number) => ({ 'x-alert-signature': sign(b, t, 'not-the-secret') })],
      ['no signature', () => ({ 'x-alert-signature': '' })],
      ['no timestamp', () => ({ 'x-alert-timestamp': '' })],
      ['stale timestamp', (_b: string, t: number) => ({ 'x-alert-timestamp': String(t - 900) })],
    ] as const) {
      const { app, rec, ...routeDeps } = deps();
      await registerHookRoutes(app, routeDeps);
      const payload = JSON.stringify(ALERT);
      const timestamp = Math.floor(Date.now() / 1000);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hooks/alert',
        payload,
        headers: { ...headersFor(payload), ...mutate(payload, timestamp) },
      });
      expect(`${label} ${response.statusCode}`).toBe(`${label} 401`);
      expect(response.json().error.code).toBe('HOOK_SIGNATURE_INVALID');
      expect(rec.calls).toEqual([]);
      await app.close();
    }
  });

  it('rejects a body that does not match the contract with 400, after the signature check', async () => {
    const { app, rec, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify({ ...ALERT, severity: 'fatal' });
    // 'fatal' is not one of info|warning|critical, and the severity feeds a
    // Postgres enum - a 500 from the database would be the alternative.
    const response = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers: headersFor(payload) });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_ARGUMENT');
    expect(rec.calls).toEqual([]);
    await app.close();
  });

  it('demands the idempotency key rather than guessing one', async () => {
    const { app, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    const without = { ...ALERT } as Partial<AlertHook>;
    delete without.idempotencyKey;
    const payload = JSON.stringify(without);

    const response = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers: headersFor(payload) });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('answers 401 rather than parsing a body sent as text/plain', async () => {
    const { app, rec, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify(ALERT);
    const timestamp = Math.floor(Date.now() / 1000);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hooks/alert',
      payload,
      headers: { 'content-type': 'text/plain', 'x-alert-timestamp': String(timestamp), 'x-alert-signature': sign(payload, timestamp) },
    });
    // There are no captured bytes for this content type, so nothing was compared.
    // 401/missing is the truth; 400 would blame the payload for a header mistake.
    expect(response.statusCode).toBe(401);
    expect(response.json().error.details).toEqual({ reason: 'missing' });
    expect(rec.calls).toEqual([]);
    await app.close();
  });

  it('does not let unsigned floods spend the authenticated budget', async () => {
    const limiter = createRateLimiter();
    const { app, rec, ...routeDeps } = deps({ limiter });
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify(ALERT);

    // 200 rejections: more than the 120/minute bucket would hold if the limit ran
    // before the signature check.
    for (let i = 0; i < 200; i += 1) {
      const refused = await app.inject({
        method: 'POST',
        url: '/api/v1/hooks/alert',
        payload,
        headers: { ...headersFor(payload), 'x-alert-signature': 'sha256=' + '0'.repeat(64) },
      });
      expect(refused.statusCode).toBe(401);
    }
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers: headersFor(payload) });

    expect(accepted.statusCode).toBe(200);
    expect(rec.calls).toHaveLength(1);
    await app.close();
  });

  it('rate limits signed traffic at the /hooks bucket', async () => {
    const limiter = createRateLimiter();
    const { app, ...routeDeps } = deps({ limiter });
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify(ALERT);
    const headers = headersFor(payload);

    let lastStatus = 0;
    for (let i = 0; i < 130; i += 1) {
      lastStatus = (await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers })).statusCode;
    }
    expect(lastStatus).toBe(429);

    const refused = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers });
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('surfaces a missing ops group as 503 rather than 500', async () => {
    const { app, ...routeDeps } = deps({
      ingest: async () => {
        throw new HttpError('OPS_GROUP_NOT_CONFIGURED', { reason: 'env-unset' });
      },
    });
    await registerHookRoutes(app, routeDeps);
    const payload = JSON.stringify(ALERT);

    const response = await app.inject({ method: 'POST', url: '/api/v1/hooks/alert', payload, headers: headersFor(payload) });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('OPS_GROUP_NOT_CONFIGURED');
    await app.close();
  });

  it('does not register the parser globally, so other routes still parse JSON', async () => {
    const { app, ...routeDeps } = deps();
    await registerHookRoutes(app, routeDeps);
    const seen: unknown[] = [];
    app.post('/elsewhere', async (request: FastifyRequest) => {
      seen.push(request.body);
      return { ok: true };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/elsewhere',
      payload: { nested: { a: 1 } },
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ nested: { a: 1 } }]);
    await app.close();
  });
});
