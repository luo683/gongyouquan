import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mentionQuerySchema, messageEditBodySchema, messageHistoryQuerySchema, messageReceiptsQuerySchema, messageSendSchema } from '@gongyouquan/contracts';
import { errorEnvelope, guarded } from '../http/errors.js';
import type { MessagesService } from './service.js';

type RequireAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function actor(request: FastifyRequest): string {
  if (!request.user) throw new Error('requireAuth must run before the handler');
  return request.user.id;
}

/**
 * The HTTP surface is the fallback path; the primary one is WS `message:send`.
 * Both call the same service so the two can never disagree about seq, idempotency
 * or the edit / revoke windows (spec 4.3.6).
 */
export async function registerMessageRoutes(
  app: FastifyInstance,
  messages: MessagesService,
  requireAuth: RequireAuth,
): Promise<void> {
  app.post('/api/v1/groups/:gid/messages', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = messageSendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid } = request.params as { gid: string };
    // groupId comes from the path; a mismatched body value is ignored rather
    // than trusted, so the guard and the insert can never target different groups.
    const sent = await guarded(request, reply, () =>
      messages.send(actor(request), { ...parsed.data, groupId: gid }),
    );
    if (!sent) return undefined;
    // 201 for a new row, 200 when the idempotency key hit an existing one.
    return reply.status(sent.deduplicated ? 200 : 201).send(sent);
  });

  app.get('/api/v1/groups/:gid/messages', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = messageHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid } = request.params as { gid: string };
    return guarded(request, reply, () => messages.history(actor(request), gid, parsed.data));
  });

  /**
   * 已读回执分级（spec 4.4.3）。Both :gid and :mid are passed through: the service
   * answers 404 when they disagree, before it asks whether the caller is a member,
   * so the error cannot be used to probe another group's message ids.
   */
  app.get('/api/v1/groups/:gid/messages/:mid/receipts', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = messageReceiptsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { gid, mid } = request.params as { gid: string; mid: string };
    return guarded(request, reply, () =>
      messages.receipts(actor(request), gid, mid, parsed.data.detail === 1),
    );
  });

  app.get('/api/v1/me/mentions', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = mentionQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    return guarded(request, reply, () => messages.mentions(actor(request), parsed.data));
  });

  app.patch('/api/v1/messages/:mid', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = messageEditBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(errorEnvelope(request, 'INVALID_ARGUMENT', parsed.error.flatten()));
    }
    const { mid } = request.params as { mid: string };
    const edited = await guarded(request, reply, () => messages.edit(actor(request), mid, parsed.data.body));
    if (edited) return reply.send(edited);
    return undefined;
  });

  app.delete('/api/v1/messages/:mid', { preHandler: requireAuth }, async (request, reply) => {
    const { mid } = request.params as { mid: string };
    // guarded() answers undefined both for "handled an error" and for a void
    // success, so the sentinel is what tells 204 from an already-sent envelope.
    const revoked = await guarded(request, reply, async () => {
      await messages.revoke(actor(request), mid);
      return true as const;
    });
    if (revoked) return reply.status(204).send();
    return undefined;
  });

  app.get('/api/v1/messages/:mid/raw', { preHandler: requireAuth }, async (request, reply) => {
    const { mid } = request.params as { mid: string };
    return guarded(request, reply, () => messages.raw(actor(request), mid));
  });
}
