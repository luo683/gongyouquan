import { randomUUID } from 'node:crypto';
import type { AlertHook } from '@gongyouquan/contracts';

type Drift = { tracked: number; engine: number };

/**
 * Spec 4.6's leak probe, turned into an alert body.
 *
 * `source` and `title` are the aggregation key, so they are constants on purpose:
 * two sweeps that both find a leak inside five minutes must land on the same
 * counting line in #运维告警, not on two lines that split the reader's attention.
 * A test pins them because editing either one silently forks the stream into a
 * second line nobody is watching.
 *
 * `idempotencyKey` is per occurrence, the other way round: that key answers "has
 * this exact delivery been seen before", and two drifts are two facts. Two
 * consecutive sweeps over the same leak are therefore two hits on one message -
 * which is the correct reading, because the leak is still there.
 */
export function driftAlert(drift: Drift): AlertHook {
  return {
    source: 'presence-sweep',
    severity: 'warning',
    title: 'presence 计数漂移',
    detail: `tracked=${drift.tracked} engine=${drift.engine}`,
    fingerprint: 'presence-drift',
    idempotencyKey: randomUUID(),
  };
}

/**
 * The hook `runtime.ts` hands the presence sweep.
 *
 * It never throws. The sweep runs on a timer inside the socket layer, and an
 * alerting path that can throw there would let a misconfigured `SYSTEM_GROUP_ID`
 * take presence down with it - the observer must not break the observed. The
 * failure is still said out loud: this is the one place an operator finds out that
 * alerts have been going nowhere, so it logs rather than swallowing.
 */
export function createPresenceDriftAlerter(
  ingest: (alert: AlertHook) => Promise<unknown>,
  onError: (error: unknown) => void = (error) => console.error('presence drift alert failed', error),
): (drift: Drift) => void {
  return (drift) => {
    ingest(driftAlert(drift)).catch(onError);
  };
}
