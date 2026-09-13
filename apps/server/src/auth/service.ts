import { randomBytes, randomUUID, createHash } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT } from 'jose';
import { HttpError, RateLimitedError } from '../http/errors.js';
import { LIMITS } from '../http/rate-limit.js';

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  disabledAt: Date | null;
};

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
};

export type GroupInvite = {
  code: string;
  groupId: string;
  role: 'owner' | 'admin' | 'member';
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type AuthSession = {
  id: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  replacedBy: string | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  expiresAt: Date;
};

export type AuthRepository = {
  findUserByUsername(username: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  registerWithInvite(input: {
    code: string;
    username: string;
    displayName: string;
    passwordHash: string;
  }): Promise<{ user: AuthUser; groups: Array<{ id: string; role: GroupInvite['role'] }> }>;
  createSession(input: Omit<AuthSession, 'id'>): Promise<AuthSession>;
  findSessionByRefreshHash(hash: string): Promise<AuthSession | null>;
  rotateSession(input: {
    current: AuthSession;
    replacement: Omit<AuthSession, 'id'>;
    now: Date;
  }): Promise<{ kind: 'invalid' | 'reused' | 'rotated'; session?: AuthSession }>;
  revokeSession(session: AuthSession, now: Date): Promise<void>;
  revokeAllForUser(userId: string, now: Date): Promise<number>;
};

export class AuthError extends HttpError {}

type AuthServiceOptions = {
  repo: AuthRepository;
  jwtSecret: string;
  now?: () => Date;
  /**
   * The 30/分钟 refresh bucket is keyed on the session family, and the family is
   * only knowable from the token - which means this one limit cannot sit in front
   * of a database read the way 8.2 asks. It is taken after the lookup and before
   * the rotation write, so a refresh storm still costs one indexed SELECT rather
   * than an INSERT plus two UPDATEs per attempt. docs/decisions/0007 records the
   * deviation instead of pretending the rule was met verbatim.
   */
  limiter?: import('../http/rate-limit.js').RateLimiter;
};

const ACCESS_TOKEN_SECONDS = 15 * 60;
const REFRESH_TOKEN_DAYS = 30;

function publicUser(user: AuthUser): PublicUser {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createAuthService(options: AuthServiceOptions) {
  const now = options.now ?? (() => new Date());
  const limiter = options.limiter;
  const secret = new TextEncoder().encode(options.jwtSecret);

  async function accessToken(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_SECONDS}s`)
      .sign(secret);
  }

  async function issueSession(user: AuthUser, clientKind: 'desktop' | 'web', familyId = randomUUID()) {
    const refreshToken = newRefreshToken();
    const session = await options.repo.createSession({
      userId: user.id,
      familyId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      replacedBy: null,
      revokedAt: null,
      revokedReason: null,
      expiresAt: new Date(now().getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
    });
    return {
      accessToken: await accessToken(user.id, session.id),
      refreshToken,
      expiresIn: ACCESS_TOKEN_SECONDS,
      user: publicUser(user),
    };
  }

  return {
    async register(input: { code: string; username: string; displayName: string; password: string }) {
      if (input.username.length < 2 || input.username.length > 32 ||
        !/^\S+$/.test(input.username) || input.password.length < 10 ||
        !/[A-Za-z]/.test(input.password) || !/[0-9]/.test(input.password)) {
        throw new AuthError('INVALID_ARGUMENT');
      }
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      try {
        const result = await options.repo.registerWithInvite({ ...input, passwordHash });
        return { ...result, user: publicUser(result.user) };
      } catch (error) {
        if (error instanceof Error && error.message === 'INVITE_INVALID') {
          throw new AuthError('INVITE_INVALID');
        }
        throw error;
      }
    },

    async login(input: { username: string; password: string; clientKind: 'desktop' | 'web' }) {
      const user = await options.repo.findUserByUsername(input.username);
      if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
        throw new AuthError('AUTH_INVALID_CREDENTIALS');
      }
      if (user.disabledAt) throw new AuthError('ACCOUNT_DISABLED');
      return issueSession(user, input.clientKind);
    },

    /**
     * clientKind is accepted for symmetry with login and is deliberately unused:
     * the only transport difference is where the refresh token travels (desktop
     * body vs web HttpOnly cookie), which is the route's business, not the
     * rotation's. Underscore-prefixed so the linter objects if anyone later gives
     * it an effect that the callers do not know about.
     */
    async refresh(refreshToken: string, _clientKind: 'desktop' | 'web' = 'desktop') {
      const current = await options.repo.findSessionByRefreshHash(hashRefreshToken(refreshToken));
      const timestamp = now();
      if (!current) throw new AuthError('REFRESH_INVALID');
      if (limiter) {
        const decision = limiter.take(
          `auth/refresh:family:${current.familyId}`,
          LIMITS.refreshPerFamily.limit,
          LIMITS.refreshPerFamily.windowMs,
        );
        if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, 'auth/refresh');
      }
      if (current.replacedBy) {
        const result = await options.repo.rotateSession({
          current,
          now: timestamp,
          replacement: {
            userId: current.userId,
            familyId: current.familyId,
            refreshTokenHash: hashRefreshToken(newRefreshToken()),
            replacedBy: null,
            revokedAt: null,
            revokedReason: null,
            expiresAt: new Date(timestamp.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
          },
        });
        if (result.kind === 'reused') throw new AuthError('REFRESH_REUSED');
        throw new AuthError('REFRESH_INVALID');
      }
      if (current.revokedAt || current.expiresAt <= timestamp) {
        throw new AuthError('REFRESH_INVALID');
      }
      const replacementToken = newRefreshToken();
      const replacement = await options.repo.rotateSession({
        current,
        now: timestamp,
        replacement: {
          userId: current.userId,
          familyId: current.familyId,
          refreshTokenHash: hashRefreshToken(replacementToken),
          replacedBy: null,
          revokedAt: null,
          revokedReason: null,
          expiresAt: new Date(timestamp.getTime() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      if (replacement.kind === 'reused') throw new AuthError('REFRESH_REUSED');
      if (replacement.kind !== 'rotated' || !replacement.session) throw new AuthError('REFRESH_INVALID');
      const user = await options.repo.findUserById(current.userId);
      if (!user || user.disabledAt) throw new AuthError('REFRESH_INVALID');
      return {
        accessToken: await accessToken(user.id, replacement.session.id),
        refreshToken: replacementToken,
        expiresIn: ACCESS_TOKEN_SECONDS,
        user: publicUser(user),
      };
    },

    async logout(refreshToken: string) {
      const session = await options.repo.findSessionByRefreshHash(hashRefreshToken(refreshToken));
      if (session) await options.repo.revokeSession(session, now());
    },

    async logoutAll(userId: string): Promise<number> {
      return options.repo.revokeAllForUser(userId, now());
    },
  };
}
