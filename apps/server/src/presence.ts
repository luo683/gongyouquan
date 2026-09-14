/**
 * 在线状态与死连接清理（说明书 4.6）。
 *
 * Presence lives only in process memory and is never persisted. Under the
 * single-process deployment spec 1.x describes, memory is already the
 * authority; writing it down would buy nothing but a consistency problem.
 *
 * A Set of socketIds per user rather than a boolean, because one person is
 * commonly on two devices: closing a browser tab must not tell the group that
 * someone who is still sitting at the desktop has left. Only the transition to
 * an empty set means offline.
 *
 * Nothing here imports Socket.IO. The sweep takes a two-method view of the
 * server instead, so the transitions and the leak probe can be tested without
 * standing up a socket, and so this module cannot reach past its interface.
 */

export type Presence = {
  /** True when this socket is the user's first - the transition to online. */
  join(userId: string, socketId: string): boolean;
  /** True when the set became empty - the transition to offline. */
  leave(userId: string, socketId: string): boolean;
  online(userId: string): boolean;
  /** Distinct users online. This is 4.7's `presenceMapSize` gauge. */
  size(): number;
  /** Every socketId tracked, summed. The sweep compares this against the engine. */
  socketCount(): number;
  /**
   * Drop socketIds that are no longer connected and return the users whose set
   * emptied as a result, so the caller can broadcast them offline.
   */
  prune(isAlive: (socketId: string) => boolean): string[];
};

export function createPresence(): Presence {
  const map = new Map<string, Set<string>>();

  return {
    join(userId, socketId) {
      const existing = map.get(userId);
      if (existing) {
        existing.add(socketId);
        return false;
      }
      map.set(userId, new Set([socketId]));
      return true;
    },

    leave(userId, socketId) {
      const existing = map.get(userId);
      if (!existing) return false;
      existing.delete(socketId);
      if (existing.size > 0) return false;
      /**
       * Deleting the emptied set is what keeps size() honest. Leaving it behind
       * would grow the map forever and read as a user who is online with no
       * connections - precisely the leak the sweep below exists to catch.
       */
      map.delete(userId);
      return true;
    },

    online(userId) {
      return map.has(userId);
    },

    size() {
      return map.size;
    },

    socketCount() {
      let total = 0;
      for (const set of map.values()) total += set.size;
      return total;
    },

    prune(isAlive) {
      const wentOffline: string[] = [];
      // Deleting from a Map during its own iteration is defined behaviour in JS:
      // the current entry is safe to remove and the walk still finishes.
      for (const [userId, set] of map) {
        for (const socketId of set) if (!isAlive(socketId)) set.delete(socketId);
        if (set.size === 0) {
          map.delete(userId);
          wentOffline.push(userId);
        }
      }
      return wentOffline;
    },
  };
}

/** The narrow view of a Socket.IO server the sweep needs, and nothing more. */
export type SweepSource = {
  /** `io.engine.clientsCount`. */
  engineClients(): number;
  /** Whether a socketId is still connected: `io.sockets.sockets.has(id)`. */
  isSocketAlive(socketId: string): boolean;
};

export type PresenceSweepOptions = {
  /** 4.6 says every 30 seconds. */
  intervalMs?: number;
  /** 4.6 says alert past a difference of 20. */
  driftThreshold?: number;
  /** Called when the tracked count drifts from the engine's by more than the threshold. */
  onDrift?: (drift: { tracked: number; engine: number }) => void;
  /** Called for each user the prune took offline, so the caller can broadcast it. */
  onOffline?: (userId: string) => void;
};

export type PresenceSweep = {
  /** Run one pass immediately. Exposed so a test does not have to wait 30 seconds. */
  tick(): void;
  stop(): void;
};

export const SWEEP_INTERVAL_MS = 30_000;
export const DRIFT_THRESHOLD = 20;

/**
 * The fallback scan 4.6 insists on. `disconnect` does not fire in every way a
 * connection can die - NAT timeout, a client sleeping into a half-open TCP
 * socket, a process killed outright - so relying on the event alone is betting
 * memory correctness on network behaviour.
 *
 * Drift is measured BEFORE pruning, not after. Pruning is what fixes the leak,
 * so measuring afterwards would report a clean number every time and the probe
 * would never fire. The point of the metric is to see the accumulation.
 */
export function createPresenceSweep(
  source: SweepSource,
  presence: Presence,
  options: PresenceSweepOptions = {},
): PresenceSweep {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  const threshold = options.driftThreshold ?? DRIFT_THRESHOLD;

  function tick(): void {
    const tracked = presence.socketCount();
    const engine = source.engineClients();
    for (const userId of presence.prune(source.isSocketAlive)) options.onOffline?.(userId);
    if (Math.abs(tracked - engine) > threshold) options.onDrift?.({ tracked, engine });
  }

  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for a gauge. Tests and graceful shutdown both
  // depend on this: an unref'd timer does not keep the event loop alive.
  timer.unref?.();

  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
