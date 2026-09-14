import Fastify, { type FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import {
  messageDeleteSchema,
  messageEditSchema,
  messageSendSchema,
  readUpdateSchema,
  syncHelloSchema,
  syncPullSchema,
  typingSignalSchema,
  type MessageDto,
} from '@gongyouquan/contracts';
import { createPresence, createPresenceSweep, type Presence, type PresenceSweep } from './presence.js';
import { registerAuthRoutes, type AuthRouteService } from './auth/routes.js';
import { createAuthenticator } from './http/auth.js';
import { HttpError } from './http/errors.js';
import { registerGroupRoutes } from './groups/routes.js';
import { registerMessageRoutes } from './messages/routes.js';
import { registerMemberRoutes } from './groups/member-routes.js';
import type { MembersService } from './groups/members-service.js';
import type { MessageBus } from './messages/bus.js';
import type { GroupsService } from './groups/service.js';
import type { MessagesService } from './messages/service.js';
import { registerHealthRoutes, type Readiness } from './health.js';
import { registerSyncRoutes } from './sync/routes.js';
import type { SyncService } from './sync/service.js';
import type { RateLimiter } from './http/rate-limit.js';

export type RuntimeOptions = {
  jwtSecret: Uint8Array;
  contractVersion?: string;
  getReadiness: () => Promise<Readiness>;
  /** Only used by the socket tests that never stand up a database. */
  getGroupSyncState?: (input: { groupId: string; userId: string }) => Promise<{ lastSeq: number } | null>;
  auth?: AuthRouteService;
  groups?: GroupsService;
  messages?: MessagesService;
  /** Real watermarks and replay. When absent, hello falls back to getGroupSyncState. */
  /** Member management and invite codes; every rule traces to spec 3.4. */
  members?: MembersService;
  sync?: SyncService;
  /** Where committed writes go; attached to the rooms below. */
  bus?: MessageBus;
  /** Shared by routes and services; absent only in tests that pin no policy. */
  limiter?: RateLimiter;
  /**
   * Which group rooms a presence change is broadcast to. Optional: the socket
   * tests stand up no database, and presence is a broadcast with nothing to
   * read back, so an absent resolver simply means no presence events.
   */
  getPresenceGroups?: (userId: string) => Promise<string[]>;
  /**
   * Spec 4.6's leak probe. The ops module that should receive this does not
   * exist yet (see decisions/0007 section four), so the default is a log line -
   * which is honest about there being nowhere better for it to go.
   */
  onPresenceDrift?: (drift: { tracked: number; engine: number }) => void;
  /** 30 seconds per spec 4.6; overridable so a test does not have to wait. */
  presenceSweepIntervalMs?: number;
};

export type Runtime = {
  app: FastifyInstance;
  io: SocketIOServer;
  /** Exposed for 4.7's `presenceMapSize` gauge and for tests. */
  presence: Presence;
  close: () => Promise<void>;
};

type AuthenticatedSocket = Socket & {
  data: {
    userId: string;
    /**
     * Cached at connect so a disconnect can broadcast offline without awaiting a
     * database query during teardown. Membership can change mid-session; presence
     * is best-effort enough that a stale room list is acceptable, and the
     * alternative is a query on the path where the connection just died.
     */
    groupIds?: string[];
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
  if (options.auth)
    await registerAuthRoutes(app, options.auth, {
      limiter: options.limiter,
      requireAuth: createAuthenticator(options.jwtSecret),
    });
  if (options.groups) await registerGroupRoutes(app, options.groups, createAuthenticator(options.jwtSecret));
  if (options.messages) await registerMessageRoutes(app, options.messages, createAuthenticator(options.jwtSecret));
  if (options.sync) await registerSyncRoutes(app, options.sync, createAuthenticator(options.jwtSecret));
  if (options.members) await registerMemberRoutes(app, options.members, createAuthenticator(options.jwtSecret));

  const presence: Presence = createPresence();

  /**
   * Resolved once per socket and cached on it. The cache is what lets the
   * disconnect path broadcast offline without awaiting a database query at the
   * exact moment a connection died - and membership changing mid-session is a
   * staleness presence can tolerate, being best-effort by nature.
   */
  async function groupsOf(socket: AuthenticatedSocket): Promise<string[]> {
    const cached = socket.data.groupIds;
    if (cached) return cached;
    const resolved = options.getPresenceGroups ? await options.getPresenceGroups(socket.data.userId) : [];
    socket.data.groupIds = resolved;
    return resolved;
  }

  /**
   * Room by room, never global. Line 758 forbids a full broadcast outright, and
   * who is online in one group is nobody else's business.
   */
  function broadcastPresence(targetUserId: string, groupIds: string[], online: boolean): void {
    const at = new Date().toISOString();
    for (const groupId of groupIds) {
      io.to('group:' + groupId).emit('presence:updated', { groupId, userId: targetUserId, online, at });
    }
  }

  const sweep: PresenceSweep = createPresenceSweep(
    {
      engineClients: () => io.engine.clientsCount,
      isSocketAlive: (socketId) => io.sockets.sockets.has(socketId),
    },
    presence,
    {
      intervalMs: options.presenceSweepIntervalMs,
      onDrift:
        options.onPresenceDrift ??
        ((drift) => console.error('presence drift: tracking more sockets than the engine has', drift)),
      /**
       * A pruned user's socket is gone, so there is no socket.data to read the
       * group list from. This is the one place presence pays for a query, and it
       * only runs for connections that died without firing `disconnect`.
       */
      onOffline: (userId) => {
        if (!options.getPresenceGroups) return;
        void options
          .getPresenceGroups(userId)
          .then((groupIds) => broadcastPresence(userId, groupIds, false))
          .catch((error: unknown) => console.error('presence offline broadcast failed', error));
      },
    },
  );

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
    const userId = socket.data.userId;
    socket.join('user:' + userId);

    /**
     * Joined before anything awaits, mirroring the rule 4.6 states for leaving:
     * the map has to be correct first, and the broadcast is a consequence of the
     * transition rather than something racing it. Only the first of a user's
     * sockets announces them - a second device connecting is not a new arrival.
     */
    const cameOnline = presence.join(userId, socket.id);
    void groupsOf(socket).then((groupIds) => {
      if (cameOnline) broadcastPresence(userId, groupIds, true);
    });

    socket.on('disconnect', () => {
      // Synchronous first line, per spec 4.6. Everything after this may await.
      const wentOffline = presence.leave(userId, socket.id);
      if (!wentOffline) return;
      const cached = socket.data.groupIds;
      if (cached) broadcastPresence(userId, cached, false);
      else void groupsOf(socket).then((groupIds) => broadcastPresence(userId, groupIds, false));
    });

    /**
     * `typing:start` / `typing:stop`: no ack, best effort, never persisted (line
     * 739). Relayed to the room minus the sender, who has no use for an echo of
     * their own keystrokes.
     *
     * Gated on room membership rather than on a database query. Rooms are only
     * joined by sync:hello, sync:pull and message:send, all of which have already
     * checked membership, so this costs nothing - and it is not decorative:
     * `socket.to(room)` delivers to a room whether or not the sender is in it, so
     * without this check a stranger could put "someone is typing" into any group
     * they liked, under any userId they liked.
     */
    for (const signal of ['typing:start', 'typing:stop'] as const) {
      socket.on(signal, (payload: unknown) => {
        const parsed = typingSignalSchema.safeParse(payload);
        if (!parsed.success) return;
        const room = 'group:' + parsed.data.groupId;
        if (!socket.rooms.has(room)) return;
        socket.to(room).emit(signal, { groupId: parsed.data.groupId, userId });
      });
    }

    /**
     * Every handler answers with either the contract payload or a wsErrorPayload,
     * never a bare Error, so the client can map a code to Chinese copy instead of
     * parsing English text.
     */
    async function call<T>(ack: ((value: unknown) => void) | undefined, fn: () => Promise<T>): Promise<void> {
      if (typeof ack !== 'function') return;
      try {
        ack(await fn());
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
        if (!(error instanceof HttpError)) console.error('unhandled socket error', error);
        ack({ error: { code, message: code.toLowerCase().replaceAll('_', ' ') } });
      }
    }

    function follow(groupId: string): void {
      socket.join('group:' + groupId);
    }

    socket.on('sync:hello', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        const parsed = syncHelloSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');

        if (options.sync) {
          const ready = await options.sync.hello(userId, parsed.data);
          // Joining here is what makes the acknowledgement and the room list the
          // same answer: a group the caller is not in is neither reported nor joined.
          for (const group of ready.groups) follow(group.groupId);
          socket.emit('sync:ready', ready);
          return ready;
        }

        const authorized: Array<{ groupId: string; lastSeq: number }> = [];
        for (const group of parsed.data.groups) {
          const state = await options.getGroupSyncState?.({ groupId: group.groupId, userId });
          if (state) {
            authorized.push({ groupId: group.groupId, lastSeq: state.lastSeq });
            follow(group.groupId);
          }
        }
        const ready = { groups: authorized, contractVersion: options.contractVersion ?? 'unversioned' };
        socket.emit('sync:ready', ready);
        return ready;
      });
    });

    socket.on('sync:pull', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        if (!options.sync) throw new HttpError('INTERNAL_ERROR');
        const parsed = syncPullSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');
        follow(parsed.data.groupId);
        return options.sync.pull(userId, parsed.data);
      });
    });

    socket.on('read:update', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        if (!options.sync) throw new HttpError('INTERNAL_ERROR');
        const parsed = readUpdateSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');
        const position = await options.sync.read(userId, parsed.data);
        // Peers refresh their receipt counts off this; the sender needs no echo.
        socket.to('group:' + parsed.data.groupId).emit('read:updated', {
          groupId: parsed.data.groupId,
          userId,
          lastReadSeq: position.lastReadSeq,
        });
        return position;
      });
    });

    socket.on('message:send', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        if (!options.messages) throw new HttpError('INTERNAL_ERROR');
        const parsed = messageSendSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');
        follow(parsed.data.groupId);
        return options.messages.send(userId, parsed.data);
      });
    });

    socket.on('message:edit', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        if (!options.messages) throw new HttpError('INTERNAL_ERROR');
        const parsed = messageEditSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');
        return { message: await options.messages.edit(userId, parsed.data.messageId, parsed.data.body) };
      });
    });

    socket.on('message:delete', async (payload: unknown, ack?: (value: unknown) => void) => {
      await call(ack, async () => {
        if (!options.messages) throw new HttpError('INTERNAL_ERROR');
        const parsed = messageDeleteSchema.safeParse(payload);
        if (!parsed.success) throw new HttpError('INVALID_ARGUMENT');
        await options.messages.revoke(userId, parsed.data.messageId);
        return { ok: true };
      });
    });
  });

  // Live fan-out. Attached once per process; rooms are joined in sync:hello above.
  const detach = options.bus?.attach((event: string, message: MessageDto) => {
    io.to('group:' + message.groupId).emit(event, message);
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      sweep.stop();
      detach?.();
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

  return { app, io, presence, close };
}
