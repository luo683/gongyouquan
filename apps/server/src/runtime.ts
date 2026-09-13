import Fastify, { type FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { registerAuthRoutes, type AuthRouteService } from './auth/routes.js';
import { registerHealthRoutes, type Readiness } from './health.js';

export type RuntimeOptions = {
  jwtSecret: Uint8Array;
  contractVersion?: string;
  getReadiness: () => Promise<Readiness>;
  getGroupSyncState: (input: { groupId: string; userId: string }) => Promise<{ lastSeq: number } | null>;
  auth?: AuthRouteService;
};

export type Runtime = {
  app: FastifyInstance;
  io: SocketIOServer;
  close: () => Promise<void>;
};

type AuthenticatedSocket = Socket & {
  data: {
    userId: string;
  };
};

function getToken(socket: Socket): string | undefined {
  const token = socket.handshake.auth?.token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

async function authenticate(socket: Socket, secret: Uint8Array): Promise<string> {
  const token = getToken(socket);
  if (!token) throw new Error('UNAUTHENTICATED');

  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('UNAUTHENTICATED');
  }
  return payload.sub;
}

function closeSocketServer(io: SocketIOServer): Promise<void> {
  return new Promise((resolve) => io.close(() => resolve()));
}

export async function buildApp(options: RuntimeOptions): Promise<Runtime> {
  const app = Fastify({ genReqId: () => crypto.randomUUID() });
  const io = new SocketIOServer(app.server, {
    pingInterval: 10_000,
    pingTimeout: 15_000,
  });

  await registerHealthRoutes(app, { getReadiness: options.getReadiness });
  if (options.auth) await registerAuthRoutes(app, options.auth);

  io.use(async (socket, next) => {
    try {
      const userId = await authenticate(socket, options.jwtSecret);
      (socket as AuthenticatedSocket).data.userId = userId;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthenticatedSocket;
    socket.join(`user:${socket.data.userId}`);

    socket.on('sync:hello', async (payload: unknown, ack?: (value: unknown) => void) => {
      if (typeof ack !== 'function') return;
      const groups = Array.isArray((payload as { groups?: unknown } | null)?.groups)
        ? (payload as { groups: Array<{ groupId?: unknown }> }).groups
        : [];
      const authorizedGroups: Array<{ groupId: string; lastSeq: number }> = [];

      for (const group of groups) {
        if (typeof group?.groupId !== 'string') continue;
        const state = await options.getGroupSyncState({
          groupId: group.groupId,
          userId: socket.data.userId,
        });
        if (state) {
          authorizedGroups.push({ groupId: group.groupId, lastSeq: state.lastSeq });
          socket.join(`group:${group.groupId}`);
        }
      }

      const result = {
        groups: authorizedGroups,
        contractVersion: options.contractVersion,
      };
      ack(result);
      socket.emit('sync:ready', result);
    });
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await closeSocketServer(io);
      try {
        await app.close();
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) {
          throw error;
        }
      }
    })();
    return closePromise;
  };

  return { app, io, close };
}
