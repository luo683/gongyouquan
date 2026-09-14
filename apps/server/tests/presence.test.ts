import { describe, expect, it } from 'vitest';
import { createPresence, createPresenceSweep, type SweepSource } from '../src/presence.js';

/**
 * Spec 4.6: presence is a Map<userId, Set<socketId>> in process memory, and the
 * only thing that matters about it is when a transition happens. Every test here
 * is about a transition or about the leak probe, because those are the two things
 * that break silently - a missed offline leaves someone permanently "online", and
 * a missed leak grows memory until the process dies.
 */
describe('presence map', () => {
  it('announces a user online once, however many devices they open', () => {
    const presence = createPresence();

    // The desktop connects. This is the transition the group should hear about.
    expect(presence.join('7', 'sock-a')).toBe(true);
    // Their browser connects too. Nobody came online - the same person did.
    expect(presence.join('7', 'sock-b')).toBe(false);
    // A reconnect of an id already tracked is not a new arrival either.
    expect(presence.join('7', 'sock-a')).toBe(false);

    expect(presence.online('7')).toBe(true);
    expect(presence.size()).toBe(1);
    expect(presence.socketCount()).toBe(2);
  });

  it('only calls a user offline when their last socket goes', () => {
    const presence = createPresence();
    presence.join('7', 'sock-a');
    presence.join('7', 'sock-b');

    // Closing the tab while the desktop is still open must not tell the group
    // that this person left. This is the whole reason it is a Set.
    expect(presence.leave('7', 'sock-a')).toBe(false);
    expect(presence.online('7')).toBe(true);
    expect(presence.size()).toBe(1);
    expect(presence.socketCount()).toBe(1);

    expect(presence.leave('7', 'sock-b')).toBe(true);
    expect(presence.online('7')).toBe(false);
    // The emptied set is deleted, not left behind: size() is the presenceMapSize
    // gauge, and a user with no sockets counted as online is the leak itself.
    expect(presence.size()).toBe(0);
    expect(presence.socketCount()).toBe(0);
  });

  it('treats a leave for an unknown user or socket as a no-op', () => {
    const presence = createPresence();
    expect(presence.leave('7', 'sock-a')).toBe(false);
    presence.join('7', 'sock-a');
    // A socket this user never had. Must not take them offline.
    expect(presence.leave('7', 'sock-other')).toBe(false);
    expect(presence.online('7')).toBe(true);
  });

  it('keeps two users independent', () => {
    const presence = createPresence();
    presence.join('7', 'sock-a');
    presence.join('9', 'sock-b');
    expect(presence.leave('7', 'sock-a')).toBe(true);
    expect(presence.online('7')).toBe(false);
    expect(presence.online('9')).toBe(true);
    expect(presence.size()).toBe(1);
  });
});

describe('presence sweep', () => {
  /** A server view with a fixed set of live sockets and a fixed engine count. */
  function source(alive: string[], engineClients: number): SweepSource {
    const live = new Set(alive);
    return {
      engineClients: () => engineClients,
      isSocketAlive: (socketId) => live.has(socketId),
    };
  }

  it('prunes sockets that died without firing disconnect, and reports who went offline', () => {
    const presence = createPresence();
    presence.join('7', 'sock-live');
    presence.join('7', 'sock-dead');
    presence.join('9', 'sock-dead-2');

    const offlined: string[] = [];
    const sweep = createPresenceSweep(source(['sock-live'], 1), presence, {
      onOffline: (userId) => offlined.push(userId),
    });
    sweep.tick();

    // 7 still has a live socket, so only 9 is announced offline. A prune that
    // reported 7 would tell the group someone left who is still connected.
    expect(offlined).toEqual(['9']);
    expect(presence.online('7')).toBe(true);
    expect(presence.online('9')).toBe(false);
    expect(presence.socketCount()).toBe(1);
    sweep.stop();
  });

  it('measures drift before pruning, so a leak is actually reported', () => {
    const presence = createPresence();
    // 25 tracked sockets, every one of them dead, and the engine has none. This
    // is the leak shape 4.6 describes: disconnect never fired, so the map kept
    // growing while the server had nobody connected.
    for (let index = 0; index < 25; index += 1) presence.join(`user-${index}`, `sock-${index}`);

    const drifts: Array<{ tracked: number; engine: number }> = [];
    const sweep = createPresenceSweep(source([], 0), presence, {
      onDrift: (drift) => drifts.push(drift),
    });
    sweep.tick();

    /**
     * The ordering is the whole test. Pruning fixes the leak, so measuring
     * afterwards would report 0 against 0 every single time and the probe would
     * never fire - a gauge that is always clean is worse than no gauge, because
     * it is believed.
     */
    expect(drifts).toEqual([{ tracked: 25, engine: 0 }]);
    expect(presence.socketCount()).toBe(0);
    sweep.stop();
  });

  it('stays quiet inside the threshold', () => {
    const presence = createPresence();
    for (let index = 0; index < 20; index += 1) presence.join(`user-${index}`, `sock-${index}`);

    const drifts: unknown[] = [];
    // Tracked 20, engine 0: a difference of exactly 20, which 4.6 says is not
    // yet worth waking anyone for.
    const sweep = createPresenceSweep(source([], 0), presence, { onDrift: (drift) => drifts.push(drift) });
    sweep.tick();
    expect(drifts).toEqual([]);
    sweep.stop();
  });

  it('does not complain about sockets mid-handshake, which the engine sees first', () => {
    const presence = createPresence();
    // The engine counts a connection before it is authenticated and joined, so a
    // burst of incoming handshakes shows up as engine ahead of tracked. That is
    // normal, not a leak, and the comparison is absolute in both directions.
    const drifts: unknown[] = [];
    const sweep = createPresenceSweep(source([], 5), presence, { onDrift: (drift) => drifts.push(drift) });
    sweep.tick();
    expect(drifts).toEqual([]);
    sweep.stop();
  });
});
