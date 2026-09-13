import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readUpdateSchema, syncPullQuerySchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded } from '../http/errors.js';
import type { SyncService } from './service.js';

type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function actor(request: FastifyRequest): string {
  if (!request.user) throw new Error('requireAuth must run before the handler');
  return request.user.id;
}

/**
 * The HTTP half of 4.3.6. These exist so a client that cannot hold a socket -
 * or one that lost it mid-flight - can still catch up, which means they must
 * share the service with the WS handlers rather than reimplement the paging.
 */
export async function registerSyncRoutes(
  app: FastifyInstance,
  sync: SyncService,
  requireAuth: RequireAuth,
): Promise<void> {
  app.get('/api/v1/groups/:gid/sync', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    const parsed = syncPullQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    // groupId comes from the path, never from the query, so the membership check
    // and the page can never be about different groups.
    return guarded(request, reply, () => sync.pull(actor(request), { ...parsed.data, groupId: gid }));
  });

  app.get('/api/v1/groups/:gid/sync-state', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    return guarded(request, reply, () => sync.state(actor(request), gid));
  });

  app.post('/api/v1/groups/:gid/read', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    const parsed = readUpdateSchema.safeParse({ ...(request.body as Record<string, unknown>), groupId: gid });
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    return guarded(request, reply, () => sync.read(actor(request), parsed.data));
  });
}
