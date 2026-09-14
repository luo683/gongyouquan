import { describe, expect, it } from 'vitest';
import { createMetrics, type MetricsSources } from '../src/metrics.js';

/**
 * Spec 4.7: these numbers are inputs to the ops manual's inspections, so a wrong
 * one is worse than a missing one - an inspection will act on it. These tests pin
 * the arithmetic rather than the plumbing, because the arithmetic is where a
 * plausible-looking number can quietly mean something else.
 */
function sources(overrides: Partial<MetricsSources> = {}): MetricsSources {
  return {
    wsConnections: () => 3,
    presenceMapSize: () => 2,
    presenceSocketCount: () => 4,
    poolStats: () => ({ total: 20, idle: 17, waiting: 0 }),
    outboxPending: async () => 5,
    outboxLagSeconds: async () => 90,
    contractVersion: 'test-hash',
    ...overrides,
  };
}

describe('metrics', () => {
  it('reports every field 4.7 names, sourced rather than invented', async () => {
    const snapshot = await createMetrics(sources()).collect();

    expect(snapshot).toMatchObject({
      wsConnections: 3,
      presenceMapSize: 2,
      presenceSocketCount: 4,
      pgPoolTotal: 20,
      pgPoolIdle: 17,
      pgPoolWaiting: 0,
      outboxPending: 5,
      outboxLagSeconds: 90,
      contractVersion: 'test-hash',
    });
    expect(typeof snapshot.heapUsed).toBe('number');
    expect(typeof snapshot.eventLoopLagMs).toBe('number');
  });

  it('reports the presence drift inspection 13 subtracts for, already subtracted', async () => {
    // 4 tracked sockets against 3 engine connections: one socket the engine no
    // longer has, which is exactly the leak 4.6's sweep exists to catch.
    const snapshot = await createMetrics(sources()).collect();
    expect(snapshot.presenceDrift).toBe(1);
  });

  it('keeps the outbox backlog and the outbox age as two different numbers', async () => {
    // Conflating these is the mistake that reads a 42-minute-old event as a
    // backlog of two thousand. Inspection 18 wants the count; readyz wants the age.
    const snapshot = await createMetrics(
      sources({ outboxPending: async () => 2, outboxLagSeconds: async () => 2519 }),
    ).collect();
    expect(snapshot.outboxPending).toBe(2);
    expect(snapshot.outboxLagSeconds).toBe(2519);
  });

  it('answers a zero rate when nothing has been served, not a division by zero', async () => {
    const snapshot = await createMetrics(sources()).collect();
    expect(snapshot.httpRequests5m).toBe(0);
    expect(snapshot.http5xxCount5m).toBe(0);
    expect(snapshot.http5xxRate5m).toBe(0);
  });

  it('computes the 5xx rate over what was actually served', async () => {
    const metrics = createMetrics(sources());
    metrics.observeResponse(200);
    metrics.observeResponse(201);
    metrics.observeResponse(503);
    metrics.observeResponse(200);

    const snapshot = await metrics.collect();
    expect(snapshot.httpRequests5m).toBe(4);
    expect(snapshot.http5xxCount5m).toBe(1);
    expect(snapshot.http5xxRate5m).toBe(25);
  });

  it('counts sync:pull monotonically, because inspection 14 reads the delta', async () => {
    const metrics = createMetrics(sources());
    expect((await metrics.collect()).syncPullRequests).toBe(0);
    metrics.countSyncPull();
    metrics.countSyncPull();
    expect((await metrics.collect()).syncPullRequests).toBe(2);
  });

  it('starts and stops the lag sampler without holding the process open', () => {
    const metrics = createMetrics(sources());
    metrics.start();
    // Starting twice must not stack a second interval behind the same handle.
    metrics.start();
    metrics.stop();
    metrics.stop();
  });
});
