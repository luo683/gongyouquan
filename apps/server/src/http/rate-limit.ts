/**
 * Token bucket, single process, in memory.
 *
 * Two properties are load bearing. The clock is injected so a test can prove a
 * window actually closes instead of sleeping through it. And the buckets live in
 * one process, which is honest for this deployment (spec 1.x: one process, one
 * node) but means a horizontally scaled backend would multiply every limit by
 * the replica count - if that ever changes this has to move to the database or
 * Redis rather than being re-decided under pressure.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the next token is available; 0 when allowed. */
  retryAfterSeconds: number;
  remaining: number;
};

export type RateLimiter = {
  take(key: string, limit: number, windowMs: number): RateLimitDecision;
  /** Test hook: forget everything. */
  reset(): void;
  size(): number;
};

type Bucket = { tokens: number; refilledAt: number };

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(clock: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, Bucket>();

  /**
   * Full capacity at first touch, draining one token per request and refilling
   * continuously at limit/windowMs. A burst of `limit` requests is therefore
   * allowed, then the steady rate holds it back - which is what a bucket is for
   * and what a fixed window counter gets wrong at the boundary.
   */
  function take(key: string, limit: number, windowMs: number): RateLimitDecision {
    const now = clock();
    const refillPerMs = limit / windowMs;
    const existing = buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: limit, refilledAt: now };

    if (!existing) buckets.set(key, bucket);
    else {
      bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.refilledAt) * refillPerMs);
      bucket.refilledAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
    }

    // Nothing to take: report how long until one token accrues, and do NOT
    // consume - a caller that is refused must not also pay for the attempt.
    const needed = 1 - bucket.tokens;
    const waitMs = Math.ceil(needed / refillPerMs);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), remaining: 0 };
  }

  function prune(): void {
    if (buckets.size <= MAX_TRACKED_KEYS) return;
    // Keys stop mattering once they are full again, so drop the coldest half by
    // insertion order rather than growing without bound.
    const drop = buckets.size - MAX_TRACKED_KEYS / 2;
    let dropped = 0;
    for (const key of buckets.keys()) {
      if (dropped >= drop) break;
      buckets.delete(key);
      dropped += 1;
    }
  }

  return {
    take(key, limit, windowMs) {
      const decision = take(key, limit, windowMs);
      // Prune unconditionally: a flood of *distinct* allowed keys (one per spoofed
      // username) never trips a refusal, and that is exactly the shape that grows
      // the map without bound.
      prune();
      return decision;
    },
    reset() {
      buckets.clear();
    },
    size() {
      return buckets.size;
    },
  };
}

/** Spec 8.2. Named so a route reads as a policy rather than as two numbers. */
export const LIMITS = {
  loginPerIp: { limit: 5, windowMs: 60_000 },
  loginPerUser: { limit: 10, windowMs: 3_600_000 },
  registerPerIp: { limit: 3, windowMs: 3_600_000 },
  refreshPerFamily: { limit: 30, windowMs: 60_000 },
  sendPerUserGroup: { limit: 30, windowMs: 60_000 },
  sendPerUser: { limit: 200, windowMs: 60_000 },
  otherWritesPerUser: { limit: 600, windowMs: 60_000 },
} as const;
