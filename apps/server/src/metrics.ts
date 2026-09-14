import type { PoolStats } from './db/pool.js';

/**
 * `/internal/metrics`（后端册 4.7）。
 *
 * 4.7 说得很直接：这些指标不是「有了更好」，而是运维手册里若干巡检项与自愈剧本的
 * **输入**，缺一项就等于那条巡检失效。所以这个模块的原则是——**只报能真实测到的**。
 * 一个看起来合理但含义不对的数字，比缺失更危险：巡检脚本会拿它去触发处置。
 *
 * 因此 `broadcastMs`（巡检项 17）**没有实现**，理由见 `decisions/0011` 第一节：
 * 服务端能测的只有「emit 调用耗时」，那不是投递延迟；把它挂在这个名字下面，等于
 * 让 agent 在 CPU 抢占上找原因，而真正的问题可能是网络。
 */

export type MetricsSources = {
  /** `io.engine.clientsCount`。巡检项 12。 */
  wsConnections: () => number;
  /** presence 映射里的**用户数**。巡检项 13 要它与 wsConnections 相减。 */
  presenceMapSize: () => number;
  /** presence 映射里的**socket 总数**，多端时大于用户数。 */
  presenceSocketCount: () => number;
  /** 4.7 的三个 pgPool 指标；剧本 3 靠 `Waiting` 区分「池子太小」与「连接泄漏」。 */
  poolStats: () => PoolStats;
  outboxPending: () => Promise<number | null>;
  outboxLagSeconds: () => Promise<number | null>;
  contractVersion: string;
};

export type MetricsSnapshot = Record<string, number | string | null>;

export type Metrics = {
  collect(): Promise<MetricsSnapshot>;
  /** Fastify `onResponse` 钩子调用。 */
  observeResponse(statusCode: number): void;
  /** 每次 `sync:pull` 调用一次。巡检项 14 取的是增量，所以这是单调计数器。 */
  countSyncPull(): void;
  /** 启动事件循环延迟采样器。 */
  start(): void;
  stop(): void;
};

const FIVE_MINUTES_MS = 300_000;
const LAG_SAMPLE_MS = 100;

export function createMetrics(sources: MetricsSources): Metrics {
  let syncPullRequests = 0;
  let eventLoopLagMs = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTick = Date.now();

  /**
   * Timestamps rather than a count, because a rate over a window has to be able to
   * forget old events. A plain counter could only ever answer "since boot", which
   * is not what 巡检项 15 asks.
   */
  const errors5xx: number[] = [];
  const requests: number[] = [];

  function prune(bucket: number[], now: number): void {
    const cutoff = now - FIVE_MINUTES_MS;
    while (bucket.length > 0 && (bucket[0] ?? 0) < cutoff) bucket.shift();
  }

  return {
    observeResponse(statusCode) {
      const now = Date.now();
      requests.push(now);
      if (statusCode >= 500) errors5xx.push(now);
      prune(requests, now);
      prune(errors5xx, now);
    },

    countSyncPull() {
      syncPullRequests += 1;
    },

    start() {
      if (timer) return;
      lastTick = Date.now();
      timer = setInterval(() => {
        const now = Date.now();
        // The interval is the expected gap; anything beyond it is time the loop
        // spent doing something else. That excess is the number worth reporting.
        eventLoopLagMs = Math.max(0, now - lastTick - LAG_SAMPLE_MS);
        lastTick = now;
      }, LAG_SAMPLE_MS);
      // Never hold the process open for a gauge.
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    async collect() {
      const now = Date.now();
      prune(requests, now);
      prune(errors5xx, now);
      const pool = sources.poolStats();
      const ws = sources.wsConnections();
      const presenceUsers = sources.presenceMapSize();

      return {
        // 巡检项 12 与 13：两者的差值就是 presence 泄漏信号（4.6 的兜底扫描看同一个差）。
        wsConnections: ws,
        presenceMapSize: presenceUsers,
        presenceSocketCount: sources.presenceSocketCount(),
        presenceDrift: sources.presenceSocketCount() - ws,

        pgPoolTotal: pool.total,
        pgPoolIdle: pool.idle,
        pgPoolWaiting: pool.waiting,

        // 积压条数与最老事件年龄是两个量，剧本 7 看前者，readyz 看后者。
        outboxPending: await sources.outboxPending(),
        outboxLagSeconds: await sources.outboxLagSeconds(),

        heapUsed: process.memoryUsage().heapUsed,
        eventLoopLagMs,

        // 巡检项 15 原本靠解析 pino 日志；直接给数比解析日志可靠，也给得出分母。
        http5xxCount5m: errors5xx.length,
        httpRequests5m: requests.length,
        http5xxRate5m: requests.length === 0 ? 0 : (errors5xx.length / requests.length) * 100,

        // 巡检项 14 取增量，所以是单调计数器，不是速率。
        syncPullRequests,

        contractVersion: sources.contractVersion,
      } satisfies MetricsSnapshot;
    },
  };
}
