import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth/service.js';
import { createAuthRepository } from './auth/repository.js';
import { createDatabase, checkDatabase, getOutboxLag, migrateDatabase, type Database } from './db/pool.js';
import { createGroupsRepository } from './groups/repository.js';
import { createGroupsService } from './groups/service.js';
import { createMessagesRepository } from './messages/repository.js';
import { createMessagesService } from './messages/service.js';
import { createMessageBus } from './messages/bus.js';
import { createSyncRepository } from './sync/repository.js';
import { createSyncService } from './sync/service.js';
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
  return {
    jwtSecret: new TextEncoder().encode(env.jwtSecret),
    contractVersion: env.contractVersion,
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
    }),
    groups: createGroupsService(groupsRepo),
    // One shared bus: the write path publishes here after COMMIT and buildApp
    // attaches the Socket.IO emitter to it, so nothing in src/messages needs to
    // know what a room is.
    bus,
    messages: createMessagesService(messagesRepo, groupsRepo, { publish: bus.publish }),
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
