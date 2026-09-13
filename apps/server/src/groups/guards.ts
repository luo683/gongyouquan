import type { GroupRole } from '@gongyouquan/contracts';
import { HttpError } from '../http/errors.js';

export type GroupMembership = {
  role: GroupRole;
  /** Archived groups stay readable; writes are refused separately (spec 3.3, decision 0004). */
  archived: boolean;
};

export type GroupAccess = {
  getMembership(groupId: string, userId: string): Promise<GroupMembership | null>;
};

/** GroupMemberGuard: membership only; never mixes in the archived or role question. */
export async function requireMembership(access: GroupAccess, groupId: string, userId: string): Promise<GroupMembership> {
  const membership = await access.getMembership(groupId, userId);
  if (!membership) throw new HttpError('FORBIDDEN_NOT_MEMBER');
  return membership;
}

/** GroupRoleGuard: runs after requireMembership so the two error codes stay distinguishable. */
export function requireRole(membership: GroupMembership, allowed: GroupRole[]): GroupMembership {
  if (!allowed.includes(membership.role)) throw new HttpError('FORBIDDEN_ROLE');
  return membership;
}

/** Service-level write gate for archived groups: 409, not 403 (spec 8.1). */
export function requireWritable(membership: GroupMembership): GroupMembership {
  if (membership.archived) throw new HttpError('GROUP_ARCHIVED');
  return membership;
}
