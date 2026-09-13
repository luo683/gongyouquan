import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { inviteCreateSchema, memberAddSchema, memberUpdateSchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded } from '../http/errors.js';
import type { MembersService } from './members-service.js';

type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function actor(request: FastifyRequest): string {
  if (!request.user) throw new Error('requireAuth must run before the handler');
  return request.user.id;
}

export async function registerMemberRoutes(
  app: FastifyInstance,
  members: MembersService,
  requireAuth: RequireAuth,
): Promise<void> {
  app.post('/api/v1/groups/:gid/members', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = memberAddSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid } = request.params as { gid: string };
    const added = await guarded(request, reply, () => members.add(actor(request), gid, parsed.data));
    if (added) return reply.status(201).send(added);
    return undefined;
  });

  app.patch('/api/v1/groups/:gid/members/:uid', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = memberUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid, uid } = request.params as { gid: string; uid: string };
    const updated = await guarded(request, reply, () => members.update(actor(request), gid, uid, parsed.data));
    if (updated) return reply.send(updated);
    return undefined;
  });

  app.delete('/api/v1/groups/:gid/members/:uid', { preHandler: requireAuth }, async (request, reply) => {
    const { gid, uid } = request.params as { gid: string; uid: string };
    const done = await guarded(request, reply, async () => {
      await members.remove(actor(request), gid, uid);
      return true as const;
    });
    if (done) return reply.status(204).send();
    return undefined;
  });

  app.post('/api/v1/groups/:gid/invites', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = inviteCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid } = request.params as { gid: string };
    const created = await guarded(request, reply, () => members.createInvite(actor(request), gid, parsed.data));
    // 201 and the plaintext code are returned exactly once; the list endpoint
    // deliberately stops exposing it after this response.
    if (created) return reply.status(201).send(created);
    return undefined;
  });

  app.get('/api/v1/groups/:gid/invites', { preHandler: requireAuth }, async (request, reply) => {
    const { gid } = request.params as { gid: string };
    return guarded(request, reply, () => members.listInvites(actor(request), gid));
  });

  app.delete('/api/v1/groups/:gid/invites/:iid', { preHandler: requireAuth }, async (request, reply) => {
    const { gid, iid } = request.params as { gid: string; iid: string };
    const done = await guarded(request, reply, async () => {
      await members.revokeInvite(actor(request), gid, iid);
      return true as const;
    });
    if (done) return reply.status(204).send();
    return undefined;
  });
}
