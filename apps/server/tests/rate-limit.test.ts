import { describe, expect, it } from 'vitest';
import { createRateLimiter, LIMITS } from '../src/http/rate-limit.js';

/**
 * The clock is injected precisely so a window can be proven to close without
 * anyone sleeping through it - a limiter test that waits in real time is a slow,
 * flaky test of Date.now().
 */
function clocked(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('token bucket rate limiter', () => {
  it('lets a full burst through, then refuses until a token accrues', () => {
    const clock = clocked();
    const limiter = createRateLimiter(clock.now);

    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take('a', 5, 60_000).allowed).toBe(true);
    }

    const refused = limiter.take('a', 5, 60_000);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.remaining).toBe(0);
  });

  it('refills continuously rather than resetting all at once', () => {
    const clock = clocked();
    const limiter = createRateLimiter(clock.now);
    for (let i = 0; i < 5; i += 1) limiter.take('a', 5, 60_000);

    // 12s is one token's worth of refill at 5 per minute.
    clock.advance(12_000);
    expect(limiter.take('a', 5, 60_000).allowed).toBe(true);
    expect(limiter.take('a', 5, 60_000).allowed).toBe(false);

    // A whole window later the bucket is full again, and no fuller than full.
    clock.advance(60_000);
    for (let i = 0; i < 5; i += 1) expect(limiter.take('a', 5, 60_000).allowed).toBe(true);
    expect(limiter.take('a', 5, 60_000).allowed).toBe(false);
  });

  it('keeps distinct keys apart and reports a retry that is never zero', () => {
    const clock = clocked();
    const limiter = createRateLimiter(clock.now);
    expect(limiter.take('login:1.2.3.4', 1, 60_000).allowed).toBe(true);
    expect(limiter.take('login:5.6.7.8', 1, 60_000).allowed).toBe(true);
    expect(limiter.take('login:1.2.3.4', 1, 60_000).allowed).toBe(false);
    expect(limiter.take('login:1.2.3.4', 1, 60_000).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('does not charge a caller it refused', () => {
    const clock = clocked();
    const limiter = createRateLimiter(clock.now);
    limiter.take('a', 1, 60_000);
    // Twenty refusals must not push recovery further out than the first would.
    for (let i = 0; i < 20; i += 1) expect(limiter.take('a', 1, 60_000).allowed).toBe(false);
    const wait = limiter.take('a', 1, 60_000).retryAfterSeconds;
    clock.advance(wait * 1000);
    expect(limiter.take('a', 1, 60_000).allowed).toBe(true);
  });

  it('matches the numbers spec 8.2 fixes', () => {
    expect(LIMITS.loginPerIp).toEqual({ limit: 5, windowMs: 60_000 });
    expect(LIMITS.loginPerUser).toEqual({ limit: 10, windowMs: 3_600_000 });
    expect(LIMITS.registerPerIp).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(LIMITS.refreshPerFamily).toEqual({ limit: 30, windowMs: 60_000 });
    expect(LIMITS.sendPerUserGroup).toEqual({ limit: 30, windowMs: 60_000 });
    expect(LIMITS.sendPerUser).toEqual({ limit: 200, windowMs: 60_000 });
    expect(LIMITS.otherWritesPerUser).toEqual({ limit: 600, windowMs: 60_000 });
  });

  it('bounds its own memory instead of growing with every IP it ever saw', () => {
    const clock = clocked();
    const limiter = createRateLimiter(clock.now);
    for (let i = 0; i < 12_000; i += 1) {
      limiter.take(`flood:${i}`, 1, 60_000);
      limiter.take(`flood2:${i}`, 1, 60_000);
    }
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });
});
