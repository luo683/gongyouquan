import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { groupCreateSchema, groupUpdateSchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded } from '../http/errors.js';
import type { GroupsService } from './service.js';

type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function actor(request: FastifyRequest): string {
  if (!request.user) throw new Error('requireAuth must run before the handler');
  return request.user.id;
}

export async function registerGroupRoutes(app: FastifyInstance, groups: GroupsService, requireAuth: RequireAuth): Promise<void> {
  app.post('/api/v1/groups', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = groupCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const created = await guarded(request, reply, () => groups.create(actor(request), parsed.data));
    if (created) return reply.status(201).send(created);
  });

  app.get('/api/v1/groups', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as { includeArchived?: string };
    const includeArchived = query.includeArchived === '1' || query.includeArchived === 'true';
    return guarded(request, reply, () => groups.list(actor(request), includeArchived));
  });

  app.get('/api/v1/groups/:gid', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    return guarded(request, reply, () => groups.detail(actor(request), gid));
  });

  app.get('/api/v1/groups/:gid/members', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    return guarded(request, reply, () => groups.members(actor(request), gid));
  });

  app.patch('/api/v1/groups/:gid', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = groupUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    const { gid } = request.params as { gid: string };
    const updated = await guarded(request, reply, () => groups.update(actor(request), gid, parsed.data));
    if (updated) return reply.send(updated);
  });
}
