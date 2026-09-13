import type { GroupDto, GroupRole, GroupUpdate, GroupCreate, LastMessagePreview } from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';
import { requireMembership, requireRole, requireWritable, type GroupAccess, type GroupMembership } from './guards.js';

export type GroupRecord = {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  isSystem: boolean;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
};

export type GroupSummary = GroupRecord & {
  memberCount: number;
  unreadCount: number;
  myLastReadSeq: number;
  lastMessagePreview: LastMessagePreview | null;
};

export type GroupMemberRecord = {
  userId: string;
  username: string;
  displayName: string;
  role: GroupRole;
  joinedAt: string;
};

export type GroupsRepository = GroupAccess & {
  createGroup(input: { name: string; description: string | null; ownerId: string }): Promise<GroupRecord>;
  listGroups(userId: string, includeArchived: boolean): Promise<GroupSummary[]>;
  getGroup(groupId: string): Promise<GroupRecord | null>;
  getMembership(groupId: string, userId: string): Promise<GroupMembership | null>;
  listMembers(groupId: string): Promise<GroupMemberRecord[]>;
  updateGroup(groupId: string, input: { name?: string; description?: string | null }): Promise<GroupRecord | null>;
};

export type GroupDetail = GroupDto & { myMembership: { role: GroupRole } };

function toDto(group: GroupRecord): GroupDto {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    isArchived: group.isArchived,
    isSystem: group.isSystem,
    lastSeq: group.lastSeq,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

export function createGroupsService(repo: GroupsRepository) {
  /** Reads must not reveal group existence to strangers (spec 8.1 NOT_FOUND covers "不可见"). */
  async function readMembershipOrHidden(groupId: string, userId: string): Promise<GroupMembership> {
    const membership = await repo.getMembership(groupId, userId);
    if (!membership) throw new HttpError('NOT_FOUND');
    return membership;
  }

  return {
    async create(actor: string, input: GroupCreate): Promise<GroupDto> {
      return toDto(await repo.createGroup({ name: input.name, description: input.description ?? null, ownerId: actor }));
    },

    async list(actor: string, includeArchived: boolean): Promise<(GroupDto & Omit<GroupSummary, keyof GroupDto>)[]> {
      return await repo.listGroups(actor, includeArchived);
    },

    async detail(actor: string, groupId: string): Promise<GroupDetail> {
      const group = await repo.getGroup(groupId);
      if (!group) throw new HttpError('NOT_FOUND');
      const membership = await readMembershipOrHidden(groupId, actor);
      return { ...toDto(group), myMembership: { role: membership.role } };
    },

    async members(actor: string, groupId: string): Promise<GroupMemberRecord[]> {
      if (!(await repo.getGroup(groupId))) throw new HttpError('NOT_FOUND');
      await readMembershipOrHidden(groupId, actor);
      return repo.listMembers(groupId);
    },

    async update(actor: string, groupId: string, input: GroupUpdate): Promise<GroupDto> {
      if (!(await repo.getGroup(groupId))) throw new HttpError('NOT_FOUND');
      const membership = await requireMembership(repo, groupId, actor);
      requireRole(membership, ['owner', 'admin']);
      requireWritable(membership);
      const updated = await repo.updateGroup(groupId, input);
      if (!updated) throw new HttpError('NOT_FOUND');
      return toDto(updated);
    },
  };
}

export type GroupsService = ReturnType<typeof createGroupsService>;
