import { describe, expect, it } from 'vitest';
import { createAuthService, type AuthRepository, type AuthSession, type AuthUser, type GroupInvite } from '../src/auth/service.js';

class MemoryAuthRepository implements AuthRepository {
  users: AuthUser[] = [];
  invites: GroupInvite[] = [];
  sessions: AuthSession[] = [];
  nextUserId = 1;
  nextSessionId = 1;

  async findUserByUsername(username: string) {
    return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase()) ?? null;
  }

  async findUserById(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async registerWithInvite(input: {
    code: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }) {
    const invite = this.invites.find((item) => item.code === input.code);
    if (!invite || invite.revokedAt || (invite.expiresAt && invite.expiresAt <= new Date()) ||
      (invite.maxUses !== null && invite.usedCount >= invite.maxUses)) {
      throw new Error('INVITE_INVALID');
    }
    if (this.users.some((user) => user.username.toLowerCase() === input.username.toLowerCase())) {
      throw new Error('USERNAME_TAKEN');
    }

    const user: AuthUser = {
      id: String(this.nextUserId++),
      username: input.username,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      disabledAt: null,
    };
    invite.usedCount += 1;
    this.users.push(user);
    return { user, groups: [{ id: invite.groupId, role: invite.role }] };
  }

  async createSession(input: Omit<AuthSession, 'id'>) {
    const session = { ...input, id: `session-${this.nextSessionId++}` };
    this.sessions.push(session);
    return session;
  }

  async findSessionByRefreshHash(hash: string) {
    return this.sessions.find((session) => session.refreshTokenHash === hash) ?? null;
  }

  async rotateSession(input: {
    current: AuthSession;
    replacement: Omit<AuthSession, 'id'>;
    now: Date;
  }) {
    const current = this.sessions.find((session) => session.id === input.current.id);
    if (!current) return { kind: 'invalid' as const };
    if (current.replacedBy) {
      for (const session of this.sessions) {
        if (session.familyId === current.familyId) {
          session.revokedAt = input.now;
          session.revokedReason = 'reuse_detected';
        }
      }
      return { kind: 'reused' as const };
    }
    if (current.revokedAt || current.expiresAt <= input.now) return { kind: 'invalid' as const };

    const replacement = { ...input.replacement, id: `session-${this.nextSessionId++}` };
    current.replacedBy = replacement.id;
    current.revokedAt = input.now;
    current.revokedReason = 'rotated';
    this.sessions.push(replacement);
    return { kind: 'rotated' as const, session: replacement };
  }

  async revokeSession(session: AuthSession, now: Date) {
    session.revokedAt = now;
    session.revokedReason = 'logout';
  }
}

function repository() {
  const repo = new MemoryAuthRepository();
  repo.invites.push({
    code: 'invite-1',
    groupId: 'group-1',
    role: 'member',
    maxUses: 1,
    usedCount: 0,
    expiresAt: null,
    revokedAt: null,
  });
  return repo;
}

describe('auth service', () => {
  it('registers with an invite and consumes it once', async () => {
    const repo = repository();
    const auth = createAuthService({ repo, jwtSecret: 'test-secret' });

    const result = await auth.register({
      code: 'invite-1',
      username: 'Worker',
      displayName: '工友',
      password: 'password123',
    });

    expect(result.user.username).toBe('Worker');
    expect(result.groups).toEqual([{ id: 'group-1', role: 'member' }]);
    expect(repo.invites[0].usedCount).toBe(1);
  });

  it('uses one error for unknown users and wrong passwords', async () => {
    const repo = repository();
    const auth = createAuthService({ repo, jwtSecret: 'test-secret' });
    await auth.register({ code: 'invite-1', username: 'worker', displayName: '工友', password: 'password123' });

    await expect(auth.login({ username: 'missing', password: 'wrong', clientKind: 'desktop' }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    await expect(auth.login({ username: 'worker', password: 'wrong', clientKind: 'desktop' }))
      .rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const repo = repository();
    const auth = createAuthService({ repo, jwtSecret: 'test-secret' });
    await auth.register({ code: 'invite-1', username: 'worker', displayName: '工友', password: 'password123' });
    const first = await auth.login({ username: 'worker', password: 'password123', clientKind: 'desktop' });

    const second = await auth.refresh(first.refreshToken!);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    await expect(auth.refresh(first.refreshToken!)).rejects.toMatchObject({ code: 'REFRESH_REUSED' });
    expect(repo.sessions.every((session) => session.revokedReason === 'reuse_detected')).toBe(true);
  });
});
