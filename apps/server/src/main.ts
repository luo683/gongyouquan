import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth/service.js';
import { createAuthRepository } from './auth/repository.js';
import { createDatabase, checkDatabase, getOutboxLag, getOutboxPending, migrateDatabase, type Database } from './db/pool.js';
import { createMetrics } from './metrics.js';
import { createGroupsRepository } from './groups/repository.js';
import { createGroupsService } from './groups/service.js';
import { createMessagesRepository } from './messages/repository.js';
import { createMessagesService } from './messages/service.js';
import { createMembersRepository } from './groups/members.js';
import { createMembersService } from './groups/members-service.js';
import { createMessageBus } from './messages/bus.js';
import { createSyncRepository } from './sync/repository.js';
import { createSyncService } from './sync/service.js';
import { createRateLimiter } from './http/rate-limit.js';
import { buildApp, type Runtime, type RuntimeOptions } from './runtime.js';
import { parseEnv, type ServerEnv } from './config/env.js';

export type StartOptions = {
  env?: Record<string, string | undefined>;
  host?: string;
  runtime?: RuntimeOptions;
};

/**
 * The spec wants the first 8 chars of the contracts build hash. Nothing stamps
 * that at build time yet, so this literal is the honest placeholder: hello still
 * carries a version, and clients still get a stable value to compare.
 */
const CONTRACT_VERSION_FALLBACK = 'dev-nohash';

function defaultRuntimeOptions(env: ServerEnv, database: Database): RuntimeOptions {
  const groupsRepo = createGroupsRepository(database);
  const messagesRepo = createMessagesRepository(database);
  const bus = createMessageBus();
  // One bucket store for the whole process, shared by the HTTP routes, the socket
  // handlers and the services. Spec 8.2 is a single-process design; several
  // replicas would each get their own copy of every limit.
  const limiter = createRateLimiter();
  return {
    jwtSecret: new TextEncoder().encode(env.jwtSecret),
    contractVersion: env.contractVersion,
    internalMetricsToken: env.internalMetricsToken,
    /**
     * 4.7's metrics. This side owns the database; buildApp owns io and the presence
     * map and hands them in. contractVersion is a string the frontend version guard
     * compares against, so it is reported as-is rather than summarised.
     */
    createMetrics: ({ wsConnections, presence }) =>
      createMetrics({
        wsConnections,
        presenceMapSize: () => presence.size(),
        presenceSocketCount: () => presence.socketCount(),
        poolStats: () => database.stats(),
        outboxPending: () => getOutboxPending(database),
        outboxLagSeconds: () => getOutboxLag(database),
        contractVersion: env.contractVersion ?? CONTRACT_VERSION_FALLBACK,
      }),
    getReadiness: async () => {
      const db = await checkDatabase(database);
      return {
        ok: db === 'up',
        checks: {
          db,
          meili: 'down',
          outboxLag: db === 'up' ? await getOutboxLag(database) : null,
        },
      };
    },
    auth: createAuthService({
      repo: createAuthRepository(database),
      jwtSecret: env.jwtSecret,
      // The refresh-family bucket cannot be checked before the session lookup,
      // so the service owns it; see createAuthService.
      limiter,
    }),
    groups: createGroupsService(groupsRepo, { limiter }),
    /**
     * Presence broadcasts room by room (line 758 forbids a global one), so it
     * needs the caller's group list. Read through the same repository the guards
     * use rather than a second membership query that could drift. Archived groups
     * are included: they stay readable and their members still see them.
     */
    getPresenceGroups: async (userId) => (await groupsRepo.listGroups(userId, true)).map((group) => group.id),
    /** Membership for the sync:ready presence snapshot; the presence map itself is process memory. */
    getGroupMemberIds: (groupIds) => groupsRepo.memberUserIds(groupIds),
    members: createMembersService(createMembersRepository(database), groupsRepo),
    // One shared bus: the write path publishes here after COMMIT and buildApp
    // attaches the Socket.IO emitter to it, so nothing in src/messages needs to
    // know what a room is.
    bus,
    messages: createMessagesService(messagesRepo, groupsRepo, {
      publish: bus.publish,
      // Personal channel: mention:new goes to user:{uid}, not group:{gid}.
      publishMention: bus.publishToUser,
      limiter,
    }),
    // Membership is read through the groups repository on purpose: one guard
    // implementation, not a second copy that can drift.
    sync: createSyncService({
      repo: createSyncRepository(database, messagesRepo),
      contractVersion: env.contractVersion ?? CONTRACT_VERSION_FALLBACK,
    }),
  };
}

export async function startServer(options: StartOptions = {}): Promise<Runtime> {
  const env = parseEnv(options.env ?? process.env);
  const database = createDatabase(env.databaseUrl);
  let runtime: Runtime | undefined;

  try {
    await migrateDatabase(database);
    runtime = await buildApp(options.runtime ?? defaultRuntimeOptions(env, database));
    const runtimeClose = runtime.close;
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        try {
          await runtimeClose();
        } finally {
          await database.end();
        }
      })();
      return closePromise;
    };
    const managedRuntime: Runtime = { ...runtime, close };
    const host = options.host ?? '0.0.0.0';
    let stopping = false;

    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await managedRuntime.close();
    };
    const onSignal = () => {
      void stop().catch((error: unknown) => {
        console.error('graceful shutdown failed', error);
        process.exitCode = 1;
      });
    };

    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    await managedRuntime.app.listen({ host, port: env.port });
    return managedRuntime;
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    await database.end();
    throw error;
  }
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  startServer().catch((error: unknown) => {
    console.error('server startup failed', error);
    process.exitCode = 1;
  });
}
