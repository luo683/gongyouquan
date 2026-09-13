import type { GroupRole, MessageDto, MessageHistoryQuery, MessageSend } from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';
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

export function createMessagesService(repo: MessageRepository, groups: MessagesGroupAccess) {
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

      await writableMembership(input.groupId, actor);
      const outcome = await repo.send({
        groupId: input.groupId,
        senderId: actor,
        clientMsgId: input.clientMsgId,
        body: input.body,
      });
      return { message: outcome.message, deduplicated: outcome.kind === 'duplicate' };
    },

    async edit(actor: string, messageId: string, body: string): Promise<MessageDto> {
      const { membership } = await messageInGroup(messageId, actor);
      requireWritable(membership);
      // Authorship is enforced by the UPDATE itself so the clock and the
      // author check cannot be separated by a race.
      const outcome = await repo.applyEdit({ messageId, actorId: actor, body });
      switch (outcome.kind) {
        case 'edited':
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
      const { membership } = await messageInGroup(messageId, actor);
      requireWritable(membership);
      const outcome = await repo.applyRevoke({ messageId, actorId: actor, moderator: isModerator(membership.role) });
      switch (outcome.kind) {
        case 'revoked':
        case 'alreadyRevoked':
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
