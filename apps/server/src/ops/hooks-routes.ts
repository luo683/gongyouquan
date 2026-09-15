import type { FastifyInstance } from 'fastify';
import type { AlertHook, AlertHookResult } from '@gongyouquan/contracts';
import { alertHookSchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded, HttpError, RateLimitedError } from '../http/errors.js';
import { LIMITS, type RateLimiter } from '../http/rate-limit.js';
import type { AlertSignatureVerifier } from './hmac.js';

/**
 * `/hooks/*` - the endpoints the ops manual specifies as "HMAC 签名（无登录态）".
 *
 * Two things make this route unlike every other one in the server, and both come
 * from the signature:
 *
 * 1. It needs the request body as **bytes**. Fastify's default JSON parser hands
 *    over an object, and a signature cannot be checked against a re-serialisation
 *    (whitespace, key order and \u escapes all survive a parse/stringify round trip
 *    differently). So this scope installs its own parser that keeps the string.
 *    It is registered on a child instance rather than on `app`, because replacing
 *    the parser on the root would change how every other route decodes JSON -
 *    including what a malformed body answers.
 * 2. The checks run in cost order, not in contract order: signature, then rate
 *    limit, then schema. Putting the limit first would let anyone who cannot sign
 *    still spend the 120/minute budget that a real sender needs during an incident,
 *    which is exactly the moment spec 8.2 says the endpoint has to stay alive for.
 */

export type HookRouteDeps = {
  verifier: AlertSignatureVerifier;
  ingest(alert: AlertHook): Promise<AlertHookResult>;
  /** Absent only in tests that pin no policy, matching the other route modules. */
  limiter?: RateLimiter;
};

/**
 * Keyed by the request object rather than hung off it: `FastifyRequest` has no
 * field for the raw payload, and augmenting the module type to add one would make
 * every other route look like it can have one too.
 */
const rawBodies = new WeakMap<object, string>();

const JSON_CONTENT_TYPE = 'application/json';

export async function registerHookRoutes(app: FastifyInstance, deps: HookRouteDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      JSON_CONTENT_TYPE,
      { parseAs: 'string' },
      (request, payload, done) => {
        const text = payload as unknown as string;
        rawBodies.set(request, text);
        try {
          done(null, JSON.parse(text));
        } catch (error) {
          // The root parser answers 400 for this, and a webhook that starts
          // answering 500 to a typo'd brace is a downgrade someone will spend an
          // evening chasing.
          const asError = error instanceof Error ? error : new Error(String(error));
          (asError as Error & { statusCode?: number }).statusCode = 400;
          done(asError);
        }
      },
    );

    scope.post('/api/v1/hooks/alert', async (request, reply) => {
      // Outside `guarded` on purpose: a refused signature is not an exception, it
      // is the ordinary answer, and the reason has to reach the envelope.
      const verdict = deps.verifier.verify(request.headers, rawBodies.get(request));
      if (!verdict.ok) {
        return reply
          .status(401)
          .send(errorEnvelope(request, 'HOOK_SIGNATURE_INVALID', { reason: verdict.reason }));
      }

      return guarded(request, reply, async () => {
        const { limiter } = deps;
        if (limiter) {
          // One bucket for the whole /hooks surface: with a single shared secret,
          // "per source" is only per whatever the body claims, and a caller that
          // can sign can claim anything. The number is spec 8.2's 120/分钟.
          const decision = limiter.take('hooks', LIMITS.hooksPerKey.limit, LIMITS.hooksPerKey.windowMs);
          if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, 'hooks');
        }

        const parsed = alertHookSchema.safeParse(request.body);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT', parsed.error.flatten());

        return deps.ingest(parsed.data);
      });
    });
  });
}
