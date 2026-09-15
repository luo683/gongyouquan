import { describe, expect, it } from 'vitest';
import { createPresenceDriftAlerter, driftAlert } from '../src/ops/presence-drift.js';

/** A tick long enough for one rejected promise to reach its catch. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('presence drift alerts', () => {
  it('sends every drift to one aggregation key but a fresh idempotency key', () => {
    const first = driftAlert({ tracked: 3, engine: 1 });
    const second = driftAlert({ tracked: 3, engine: 1 });

    // These three are the key the ops group merges on. Change any of them and the
    // next run starts a second line for the same leak, which reads as a new
    // incident to whoever is holding the phone.
    expect(first.source).toBe('presence-sweep');
    expect(first.title).toBe('presence 计数漂移');
    expect(first.fingerprint).toBe('presence-drift');
    expect(first.severity).toBe('warning');
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('carries both counters, because which side leaked is the whole question', () => {
    expect(driftAlert({ tracked: 12, engine: 7 }).detail).toBe('tracked=12 engine=7');
  });

  it('does not throw into the sweep when the alert fails, and says so', async () => {
    const logged: unknown[] = [];
    const handler = createPresenceDriftAlerter(
      async () => {
        throw new Error('OPS_GROUP_NOT_CONFIGURED');
      },
      (error) => logged.push(error),
    );

    // The sweep runs on a timer inside the socket layer. An alert that cannot be
    // posted must not be able to take presence down with it.
    expect(() => handler({ tracked: 3, engine: 1 })).not.toThrow();
    await settle();
    expect(logged).toHaveLength(1);
    expect((logged[0] as Error).message).toBe('OPS_GROUP_NOT_CONFIGURED');
  });

  it('stays quiet when the alert went through', async () => {
    const logged: unknown[] = [];
    const seen: string[] = [];
    const handler = createPresenceDriftAlerter(
      async (alert) => {
        seen.push(alert.idempotencyKey);
        return { messageId: '1', deduplicated: false };
      },
      (error) => logged.push(error),
    );

    handler({ tracked: 3, engine: 1 });
    await settle();
    expect(logged).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});
