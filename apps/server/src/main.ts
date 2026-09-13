import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth/service.js';
import { createAuthRepository } from './auth/repository.js';
import { createDatabase, checkDatabase, getOutboxLag, migrateDatabase, type Database } from './db/pool.js';
import { createGroupsRepository } from './groups/repository.js';
import { createGroupsService } from './groups/service.js';
import { buildApp, type Runtime, type RuntimeOptions } from './runtime.js';
import { parseEnv, type ServerEnv } from './config/env.js';

export type StartOptions = {
  env?: Record<string, string | undefined>;
  host?: string;
  runtime?: RuntimeOptions;
};

function defaultRuntimeOptions(env: ServerEnv, database: Database): RuntimeOptions {
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
    getGroupSyncState: async () => null,
    auth: createAuthService({
      repo: createAuthRepository(database),
      jwtSecret: env.jwtSecret,
    }),
    groups: createGroupsService(createGroupsRepository(database)),
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
