import type { GroupRole, MessageDto, MessageHistoryQuery, MessageReceiptsDto, MessageSend } from '@gongyouquan/contracts';
import { HttpError, RateLimitedError } from '../http/errors.js';
import { LIMITS, type RateLimiter } from '../http/rate-limit.js';
import { requireMembership, requireRole, requireWritable, type GroupMembership } from '../groups/guards.js';
import type { MessageRepository } from './repository.js';

export type MessagesGroupAccess = {
  getGroup(groupId: string): Promise<{ id: string } | null>;
  getMembership(groupId: string, userId: string): Promise<GroupMembership | null>;
};

export type RawMessage = {
  body: string | null;
  deletedAt: string;
  deletedBy: string | null;
};

const MODERATOR_ROLES: GroupRole[] = ['owner', 'admin'];

function isModerator(role: GroupRole): boolean {
  return MODERATOR_ROLES.includes(role);
}

/**
 * Realtime fan-out, fired after the write transaction has committed.
 *
 * There is no outbox dispatcher in this build, so a crash between COMMIT and
 * publish can drop a live event. That is accepted here rather than papered over
 * because the recovery path for a missed event already exists and is what sync:pull
 * is for: a client that never got message:new still converges on reconnect.
 * Registering the delivery in 6.9's outbox worker is the follow-up that removes the
 * window entirely.
 */
export type MessagePublisher = (event: MessageEvent, message: MessageDto) => void | Promise<void>;

export type MessageEvent = 'message:new' | 'message:updated' | 'message:deleted';

export type MessagesServiceOptions = {
  publish?: MessagePublisher;
  /**
   * Rate policy. It lives on the service rather than on either transport because
   * spec 8.2 says 发消息（WS 与 HTTP 共用计数） - one bucket per user and group.
   * Mounted on the routes it would become two counters that a client can double
   * simply by choosing which transport to talk on.
   */
  limiter?: RateLimiter;
};

export function createMessagesService(
  repo: MessageRepository,
  groups: MessagesGroupAccess,
  options: MessagesServiceOptions = {},
) {
  const publish = async (event: MessageEvent, message: MessageDto): Promise<void> => {
    if (options.publish) await options.publish(event, message);
  };

  const { limiter } = options;
  function gate(scope: string, key: string, limit: number, windowMs: number): void {
    if (!limiter) return;
    const decision = limiter.take(`${scope}:${key}`, limit, windowMs);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, scope);
  }
  /** The catch-all for writes that are not spam-shaped: 其他写接口 600/分钟. */
  function gateWrite(actor: string, what: string): void {
    gate('write:' + what, actor, LIMITS.otherWritesPerUser.limit, LIMITS.otherWritesPerUser.windowMs);
  }
  /** Membership first, then the archived write gate. Reads never pass through here. */
  async function writableMembership(groupId: string, actor: string): Promise<GroupMembership> {
    if (!(await groups.getGroup(groupId))) throw new HttpError('NOT_FOUND');
    const membership = await requireMembership(groups, groupId, actor);
    return requireWritable(membership);
  }

  async function messageInGroup(messageId: string, actor: string): Promise<{ message: MessageDto; membership: GroupMembership }> {
    const message = await repo.findMessage(messageId);
    if (!message) throw new HttpError('NOT_FOUND');
    // Non-members get 403 here, not 404: spec §10 acceptance item 6 and line 1642
    // say so explicitly for message reads, which is the opposite of how group
    // detail hides existence (decision 0004). The two are deliberately different.
    const membership = await requireMembership(groups, message.groupId, actor);
    return { message, membership };
  }

  return {
    async send(actor: string, input: MessageSend): Promise<{ message: MessageDto; deduplicated: boolean }> {
      // Only plain text can be sent by a user this round. 'system' is
      // server-generated, and image / file / task_card need the files and tasks
      // modules - see docs/decisions/0006 gap five.
      if (input.kind !== 'text') throw new HttpError('INVALID_ARGUMENT', { kind: input.kind });
      if (!input.body || input.body.trim() === '') throw new HttpError('INVALID_ARGUMENT', { field: 'body' });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.clientMsgId)) {
        throw new HttpError('INVALID_ARGUMENT', { field: 'clientMsgId' });
      }

      // Both send buckets are taken before the membership queries, so a flood from
      // one user costs no database work at all (spec 8.2).
      gate('message:send:user', actor, LIMITS.sendPerUser.limit, LIMITS.sendPerUser.windowMs);
      gate(
        'message:send:group',
        `${actor}:${input.groupId}`,
        LIMITS.sendPerUserGroup.limit,
        LIMITS.sendPerUserGroup.windowMs,
      );
      await writableMembership(input.groupId, actor);
      const outcome = await repo.send({
        groupId: input.groupId,
        senderId: actor,
        clientMsgId: input.clientMsgId,
        body: input.body,
      });
      // A deduplicated hit is not a new message: republishing it would make every
      // receiver render the same bubble twice.
      if (outcome.kind === 'created') await publish('message:new', outcome.message);
      return { message: outcome.message, deduplicated: outcome.kind === 'duplicate' };
    },

    async edit(actor: string, messageId: string, body: string): Promise<MessageDto> {
      gateWrite(actor, 'message:edit');
      const { membership } = await messageInGroup(messageId, actor);
      requireWritable(membership);
      // Authorship is enforced by the UPDATE itself so the clock and the
      // author check cannot be separated by a race.
      const outcome = await repo.applyEdit({ messageId, actorId: actor, body });
      switch (outcome.kind) {
        case 'edited':
          // Full DTO, never a diff (spec 4.3.4): the receiver decides whether it
          // wins over its own copy using updatedAt, which only works if the event
          // is self-contained and applying it twice changes nothing.
          await publish('message:updated', outcome.message);
          return outcome.message;
        case 'notFound':
          throw new HttpError('NOT_FOUND');
        case 'notAuthor':
          throw new HttpError('FORBIDDEN_ROLE');
        case 'notEditTextable':
          throw new HttpError('INVALID_ARGUMENT', { reason: 'not-editable' });
        case 'windowExpired':
          throw new HttpError('EDIT_WINDOW_EXPIRED');
      }
    },

    /**
     * Repeat revokes answer 204 rather than an error: DELETE is idempotent and a
     * weak-network client that retries must not see a failure for work already done.
     */
    async revoke(actor: string, messageId: string): Promise<void> {
      gateWrite(actor, 'message:delete');
      const { membership } = await messageInGroup(messageId, actor);
      requireWritable(membership);
      const outcome = await repo.applyRevoke({ messageId, actorId: actor, moderator: isModerator(membership.role) });
      switch (outcome.kind) {
        case 'revoked':
          await publish('message:deleted', outcome.message);
          return;
        case 'alreadyRevoked':
          // Nothing changed, so nothing is re-broadcast; a replayed DELETE stays
          // silent rather than flashing the receiver again.
          return;
        case 'notFound':
          throw new HttpError('NOT_FOUND');
        case 'notAuthor':
          throw new HttpError('FORBIDDEN_ROLE');
        case 'windowExpired':
          throw new HttpError('DELETE_WINDOW_EXPIRED');
      }
    },

    /** 被撤回消息的原文：owner / admin 可看，member 是 403，不是空结果（验收项 6）。 */
    async raw(actor: string, messageId: string): Promise<RawMessage> {
      const { message, membership } = await messageInGroup(messageId, actor);
      requireRole(membership, MODERATOR_ROLES);
      if (message.deletedAt === null) throw new HttpError('STATE_MACHINE_VIOLATION', { deleted: false });
      return { body: message.body, deletedAt: message.deletedAt, deletedBy: message.deletedBy };
    },

    /**
     * 已读回执（spec 4.4.3 / 路由表 667 行）。
     *
     * Deliberately not messageInGroup: the path carries a :gid that need not be
     * the group the message really lives in, and the mismatch has to be answered
     * before any membership question. Otherwise a member of A could pass gid=A
     * with a message id from B and read group existence off which error came
     * back - the same leak decision 0004 closes for group detail.
     */
    async receipts(actor: string, groupId: string, messageId: string, detail: boolean): Promise<MessageReceiptsDto> {
      const message = await repo.findMessage(messageId);
      if (!message || message.groupId !== groupId) throw new HttpError('NOT_FOUND');
      // 403, not 404: spec line 1642 pins that for message reads, which is the
      // opposite of the group-detail rule above. Both are intentional.
      await requireMembership(groups, message.groupId, actor);
      return repo.receipts({
        groupId: message.groupId,
        senderId: message.senderId,
        seq: message.seq,
        detail,
      });
    },

    async history(
      actor: string,
      groupId: string,
      query: MessageHistoryQuery,
    ): Promise<{ items: MessageDto[]; nextCursor: string | null; hasMore: boolean }> {
      if (!(await groups.getGroup(groupId))) throw new HttpError('NOT_FOUND');
      await requireMembership(groups, groupId, actor);
      const { items, hasMore } = await repo.listBefore({
        groupId,
        beforeSeq: query.beforeSeq ?? null,
        limit: query.limit,
      });
      const oldest = items[0];
      return {
        items,
        nextCursor: hasMore && oldest ? String(oldest.seq) : null,
        hasMore,
      };
    },
  };
}

export type MessagesService = ReturnType<typeof createMessagesService>;
