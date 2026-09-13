import type {
  GroupRole,
  InviteCreate,
  InviteCreatedDto,
  InviteDto,
  MemberAdd,
  MemberUpdate,
} from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';
import type { GroupMemberRecord } from './service.js';
import type { MembersRepository } from './members.js';
import type { GroupMembership } from './guards.js';

export type MembersGroupAccess = {
  getGroup(groupId: string): Promise<{ id: string } | null>;
  getMembership(groupId: string, userId: string): Promise<GroupMembership | null>;
};

export type MembersServiceOptions = {
  /** Clock for invite expiry; injected so a test can mint an already-stale link. */
  now?: () => Date;
};

const MAX_INVITE_HOURS = 24 * 30;

/**
 * Spec 3.4 is the only authority for who may do what. Each rule below is one
 * cell of that table, and the comments name the row so a future edit has to
 * disagree with the document out loud rather than quietly.
 */
export function createMembersService(repo: MembersRepository, groups: MembersGroupAccess, options: MembersServiceOptions = {}) {
  const now = options.now ?? (() => new Date());

  async function requireGroup(groupId: string): Promise<void> {
    if (!(await groups.getGroup(groupId))) throw new HttpError('NOT_FOUND');
  }

  async function membershipOf(groupId: string, userId: string): Promise<GroupMembership> {
    const found = await groups.getMembership(groupId, userId);
    if (!found) throw new HttpError('FORBIDDEN_NOT_MEMBER');
    return found;
  }

  function requireWritable(membership: GroupMembership): GroupMembership {
    // Archived groups refuse every write with 409, not 403 (spec 8.1, decision 0004).
    if (membership.archived) throw new HttpError('GROUP_ARCHIVED');
    return membership;
  }

  /** 生成邀请码 / 直接加人进群: owner ✓ admin ✓ member ✗ — a WRITE, so archived blocks it. */
  async function requireInviter(groupId: string, actor: string): Promise<GroupMembership> {
    const membership = await membershipOf(groupId, actor);
    requireWritable(membership);
    if (membership.role === 'member') throw new HttpError('FORBIDDEN_ROLE');
    return membership;
  }

  /** The same role gate without the archived gate: listing is a READ. */
  async function requireInviterReading(groupId: string, actor: string): Promise<GroupMembership> {
    const membership = await membershipOf(groupId, actor);
    if (membership.role === 'member') throw new HttpError('FORBIDDEN_ROLE');
    return membership;
  }

  /** 改成员角色 / 转让群主 / 归档: owner only. */
  async function requireOwner(groupId: string, actor: string): Promise<GroupMembership> {
    const membership = await membershipOf(groupId, actor);
    requireWritable(membership);
    if (membership.role !== 'owner') throw new HttpError('FORBIDDEN_ROLE');
    return membership;
  }

  return {
    async add(actor: string, groupId: string, input: MemberAdd): Promise<GroupMemberRecord> {
      await requireGroup(groupId);
      await requireInviter(groupId, actor);

      if (input.userId === actor) {
        // Adding yourself is not a privilege escalation today, but it is a
        // membership write whose semantics nobody has decided; refuse loudly.
        throw new HttpError('INVALID_ARGUMENT', { field: 'userId' });
      }
      // Read through the repository rather than an injected hook: a caller that
      // forgets to wire one would otherwise turn a bad userId into a foreign key
      // error escaping from the database instead of a 404.
      if (!(await repo.userExists(input.userId))) {
        // 5.3: this endpoint adds an existing system user. New people arrive via
        // an invite code, so the two paths stay distinguishable in the audit trail.
        throw new HttpError('NOT_FOUND');
      }

      const existing = await repo.memberRole(groupId, input.userId);
      if (existing === 'owner') throw new HttpError('STATE_MACHINE_VIOLATION', { reason: 'group already has an owner' });

      const member = await repo.addMember({
        groupId,
        userId: input.userId,
        role: input.role,
        invitedBy: actor,
      });
      if (!member) throw new HttpError('NOT_FOUND');
      return member;
    },

    /**
     * 踢人: owner ✓; admin ✓ but not the owner and not a fellow admin; member ✗.
     * A member may remove *themselves* - that is 退出群, a different row.
     */
    async remove(actor: string, groupId: string, targetUserId: string): Promise<void> {
      await requireGroup(groupId);
      const actorMembership = await membershipOf(groupId, actor);
      requireWritable(actorMembership);

      if (targetUserId === actor) {
        // 退出群（owner 不可直接退，须先转让）
        if (actorMembership.role === 'owner') throw new HttpError('FORBIDDEN_ROLE');
        const removed = await repo.removeMember(groupId, actor, actor);
        if (!removed) throw new HttpError('NOT_FOUND');
        return;
      }

      if (actorMembership.role === 'member') throw new HttpError('FORBIDDEN_NOT_MEMBER');

      const targetRole = await repo.memberRole(groupId, targetUserId);
      if (targetRole === null) throw new HttpError('NOT_FOUND');
      if (targetRole === 'owner') throw new HttpError('FORBIDDEN_ROLE');
      if (actorMembership.role === 'admin' && targetRole === 'admin') throw new HttpError('FORBIDDEN_ROLE');

      const removed = await repo.removeMember(groupId, targetUserId, actor);
      if (!removed) throw new HttpError('NOT_FOUND');
    },

    /** 改成员角色（任命/撤销 admin）: owner only, and never by self-demotion. */
    async update(actor: string, groupId: string, targetUserId: string, input: MemberUpdate): Promise<GroupMemberRecord> {
      await requireGroup(groupId);

      if (input.transferOwnership === true) {
        await requireOwner(groupId, actor);
        if (targetUserId === actor) throw new HttpError('INVALID_ARGUMENT', { field: 'userId' });
        const targetRole = await repo.memberRole(groupId, targetUserId);
        if (targetRole === null) throw new HttpError('NOT_FOUND');
        if (targetRole === 'owner') throw new HttpError('STATE_MACHINE_VIOLATION', { reason: 'already owner' });

        const transferred = await repo.transferOwnership({ groupId, fromUserId: actor, toUserId: targetUserId });
        if (!transferred) throw new HttpError('STATE_MACHINE_VIOLATION', { reason: 'transfer failed' });

        const demoted = await repo.memberRole(groupId, actor);
        if (demoted !== 'admin') throw new HttpError('STATE_MACHINE_VIOLATION', { reason: 'previous owner not demoted' });
        if ((await repo.liveOwnerCount(groupId)) !== 1) throw new HttpError('STATE_MACHINE_VIOLATION', { reason: 'owner count' });

        const promoted = await repo.addMember({ groupId, userId: targetUserId, role: 'owner', invitedBy: actor });
        if (!promoted) throw new HttpError('NOT_FOUND');
        return promoted;
      }

      await requireOwner(groupId, actor);
      if (input.role === undefined) throw new HttpError('INVALID_ARGUMENT');
      // input.role is admin|member by schema, so being made owner arrives here only
      // via transferOwnership - the other branch of this endpoint.
      if (targetUserId === actor) throw new HttpError('FORBIDDEN_ROLE');

      const current = await repo.memberRole(groupId, targetUserId);
      if (current === null) throw new HttpError('NOT_FOUND');
      if (current === 'owner') throw new HttpError('FORBIDDEN_ROLE');

      const updated = await repo.changeRole(groupId, targetUserId, input.role);
      if (!updated) throw new HttpError('NOT_FOUND');
      return updated;
    },

    async createInvite(actor: string, groupId: string, input: InviteCreate): Promise<InviteCreatedDto> {
      await requireGroup(groupId);
      await requireInviter(groupId, actor);
      const role: GroupRole = input.role ?? 'member';
      if (role === 'owner') throw new HttpError('FORBIDDEN_ROLE');
      const hours = input.expiresInHours ?? null;
      if (hours !== null && (hours < 1 || hours > MAX_INVITE_HOURS)) throw new HttpError('INVALID_ARGUMENT', { field: 'expiresInHours' });

      return repo.createInvite({
        groupId,
        role,
        maxUses: input.maxUses ?? null,
        expiresAt: hours === null ? null : new Date(now().getTime() + hours * 3_600_000),
        createdBy: actor,
      });
    },

    async listInvites(actor: string, groupId: string): Promise<InviteDto[]> {
      await requireGroup(groupId);
      // Reads on an archived group stay open, so a member can still see the
      // codes that were issued before it was put away.
      await requireInviterReading(groupId, actor);
      return repo.listInvites(groupId);
    },

    async revokeInvite(actor: string, groupId: string, inviteId: string): Promise<void> {
      await requireGroup(groupId);
      await requireInviter(groupId, actor);
      const revoked = await repo.revokeInvite(groupId, inviteId);
      // Revoking something already revoked is a no-op, not an error: the DELETE is
      // idempotent, so a client that retries over a flaky link is not shown a 404.
      if (!revoked) {
        const still = (await repo.listInvites(groupId)).find((invite) => invite.id === inviteId);
        if (!still) throw new HttpError('NOT_FOUND');
      }
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
