import { pathToFileURL } from 'node:url';
import { buildApp, type Runtime, type RuntimeOptions } from './runtime.js';
import { parseEnv, type ServerEnv } from './config/env.js';

export type StartOptions = {
  env?: Record<string, string | undefined>;
  host?: string;
  runtime?: RuntimeOptions;
};

function defaultRuntimeOptions(env: ServerEnv): RuntimeOptions {
  return {
    jwtSecret: new TextEncoder().encode(env.jwtSecret),
    contractVersion: env.contractVersion,
    getReadiness: async () => ({
      ok: false,
      checks: { db: 'down', meili: 'down', outboxLag: null },
    }),
    getGroupSyncState: async () => null,
  };
}

export async function startServer(options: StartOptions = {}): Promise<Runtime> {
  const env = parseEnv(options.env ?? process.env);
  const runtime = await buildApp(options.runtime ?? defaultRuntimeOptions(env));
  const host = options.host ?? '0.0.0.0';
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
  };
  const onSignal = () => {
    void stop().catch((error: unknown) => {
      console.error('graceful shutdown failed', error);
      process.exitCode = 1;
    });
  };

  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  await runtime.app.listen({ host, port: env.port });
  return runtime;
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
