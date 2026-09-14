import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAuthenticator } from '../src/http/auth.js';
import { registerGroupRoutes } from '../src/groups/routes.js';

import { createGroupsService, type GroupMemberRecord, type GroupRecord, type GroupSummary, type GroupsRepository } from '../src/groups/service.js';
import type { GroupMembership } from '../src/groups/guards.js';

const secret = new TextEncoder().encode('test-secret');

async function accessToken(sub: string, expiry = '5m') {
  return new SignJWT({ sid: 'session-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(secret);
}

type MemberRow = { userId: string; role: 'owner' | 'admin' | 'member'; removed: boolean };

class MemoryGroupsRepository implements GroupsRepository {
  groups: GroupRecord[] = [];
  memberships = new Map<string, MemberRow[]>();
  nextId = 1;

  seed(group: GroupRecord, members: MemberRow[]) {
    this.groups.push(group);
    this.memberships.set(group.id, members);
  }

  async createGroup({ name, description, ownerId }: { name: string; description: string | null; ownerId: string }) {
    const group: GroupRecord = {
      id: String(this.nextId++),
      name,
      description,
      isArchived: false,
      isSystem: false,
      lastSeq: 0,
      createdAt: '2026-09-13T12:00:00+08:00',
      updatedAt: '2026-09-13T12:00:00+08:00',
    };
    this.groups.push(group);
    this.memberships.set(group.id, [{ userId: ownerId, role: 'owner', removed: false }]);
    return group;
  }

  async listGroups(userId: string, includeArchived: boolean): Promise<(GroupSummary)[]> {
    return this.groups
      .filter((group) => (this.memberships.get(group.id) ?? []).some((m) => m.userId === userId && !m.removed))
      .filter((group) => includeArchived || !group.isArchived)
      .map((group) => ({
        ...group,
        memberCount: (this.memberships.get(group.id) ?? []).filter((m) => !m.removed).length,
        unreadCount: 100,
        myLastReadSeq: 3,
        lastMessagePreview: null,
      }));
  }

  async getGroup(groupId: string) {
    return this.groups.find((group) => group.id === groupId) ?? null;
  }

  async getMembership(groupId: string, userId: string): Promise<GroupMembership | null> {
    const group = this.groups.find((item) => item.id === groupId);
    const member = (this.memberships.get(groupId) ?? []).find((m) => m.userId === userId && !m.removed);
    if (!group || !member) return null;
    return { role: member.role, archived: group.isArchived };
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    return (this.memberships.get(groupId) ?? [])
      .filter((m) => !m.removed)
      .map((m) => ({ userId: m.userId, username: m.userId, displayName: m.userId, role: m.role, joinedAt: '2026-09-13T12:00:00+08:00' }));
  }

  async memberUserIds(groupIds: string[]): Promise<string[]> {
    const seen = new Set<string>();
    for (const groupId of groupIds) {
      for (const member of this.memberships.get(groupId) ?? []) {
        if (!member.removed) seen.add(member.userId);
      }
    }
    return [...seen];
  }

  async updateGroup(groupId: string, input: { name?: string; description?: string | null }) {
    const group = this.groups.find((item) => item.id === groupId);
    if (!group) return null;
    const updated: GroupRecord = {
      ...group,
      name: input.name ?? group.name,
      description: input.description === undefined ? group.description : input.description,
    };
    this.groups[this.groups.indexOf(group)] = updated;
    return updated;
  }
}

async function appWith(repo: MemoryGroupsRepository) {
  const app = Fastify();
  await registerGroupRoutes(app, createGroupsService(repo), createAuthenticator(secret));
  return app;
}

function activeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    id: '10', name: '工地B组', description: null, isArchived: false, isSystem: false, lastSeq: 7,
    createdAt: '2026-09-13T12:00:00+08:00', updatedAt: '2026-09-13T12:00:00+08:00', ...overrides,
  };
}

describe('group http slice', () => {
  it('creates a group for the authenticated owner and rejects missing/expired bearer tokens', async () => {
    const repo = new MemoryGroupsRepository();
    const app = await appWith(repo);

    const missing = await app.inject({ method: 'POST', url: '/api/v1/groups', payload: { name: '新工地' } });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe('UNAUTHENTICATED');

    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: { authorization: `Bearer ${await accessToken('user-1', '-10s')}` },
      payload: { name: '新工地' },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('TOKEN_EXPIRED');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: { authorization: `Bearer ${await accessToken('user-1')}` },
      payload: { name: '新工地', description: '夜间班' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: '新工地', description: '夜间班', isArchived: false });
    expect(await repo.getMembership('1', 'user-1')).toEqual({ role: 'owner', archived: false });
  });

  it('lists my groups with the bounded unread count and no pagination', async () => {
    const repo = new MemoryGroupsRepository();
    repo.seed(activeGroup(), [{ userId: 'user-2', role: 'member', removed: false }]);
    const app = await appWith(repo);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/groups',
      headers: { authorization: `Bearer ${await accessToken('user-2')}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({ id: '10', unreadCount: 100, myLastReadSeq: 3, lastMessagePreview: null });
  });

  it('reads an archived group but hides its existence from non-members', async () => {
    const repo = new MemoryGroupsRepository();
    repo.seed(activeGroup({ isArchived: true }), [{ userId: 'user-3', role: 'member', removed: false }]);
    const app = await appWith(repo);

    const member = await app.inject({
      method: 'GET',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('user-3')}` },
    });
    expect(member.statusCode).toBe(200);
    expect(member.json()).toMatchObject({ id: '10', isArchived: true, myMembership: { role: 'member' } });

    const stranger = await app.inject({
      method: 'GET',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('user-9')}` },
    });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json().error.code).toBe('NOT_FOUND');
  });

  it('separates role failures from membership failures on updates', async () => {
    const repo = new MemoryGroupsRepository();
    repo.seed(activeGroup(), [
      { userId: 'owner-1', role: 'owner', removed: false },
      { userId: 'plain-1', role: 'member', removed: false },
    ]);
    const app = await appWith(repo);

    const stranger = await app.inject({
      method: 'PATCH',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('outsider')}` },
      payload: { name: '改名' },
    });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('FORBIDDEN_NOT_MEMBER');

    const member = await app.inject({
      method: 'PATCH',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('plain-1')}` },
      payload: { name: '改名' },
    });
    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe('FORBIDDEN_ROLE');

    const owner = await app.inject({
      method: 'PATCH',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('owner-1')}` },
      payload: { name: '改名' },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ name: '改名' });
  });

  it('answers writes to an archived group with 409 GROUP_ARCHIVED', async () => {
    const repo = new MemoryGroupsRepository();
    repo.seed(activeGroup({ isArchived: true }), [{ userId: 'owner-1', role: 'owner', removed: false }]);
    const app = await appWith(repo);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/groups/10',
      headers: { authorization: `Bearer ${await accessToken('owner-1')}` },
      payload: { name: '归档还想改' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('GROUP_ARCHIVED');
  });

  it('lists members for group members only', async () => {
    const repo = new MemoryGroupsRepository();
    repo.seed(activeGroup(), [{ userId: 'user-5', role: 'admin', removed: false }]);
    const app = await appWith(repo);

    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/groups/10/members',
      headers: { authorization: `Bearer ${await accessToken('user-5')}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([
      { userId: 'user-5', username: 'user-5', displayName: 'user-5', role: 'admin', joinedAt: '2026-09-13T12:00:00+08:00' },
    ]);

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/groups/10/members',
      headers: { authorization: `Bearer ${await accessToken('user-6')}` },
    });
    expect(denied.statusCode).toBe(404);
  });
});
