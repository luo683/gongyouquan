import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../src/auth/repository.js';

type Call = { text: string; values?: unknown[] };

class FakeDatabase {
  calls: Call[] = [];
  async withSession<T>(fn: (client: FakeDatabase) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async query<T = unknown>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    if (text.includes('FROM users') && text.includes('lower(username)')) {
      return { rows: [{ id: 1, username: 'worker', display_name: '工友', password_hash: 'hash', disabled_at: null }] } as { rows: T[] };
    }
    return { rows: [] };
  }
}

describe('auth repository', () => {
  it('looks up usernames case-insensitively and maps BIGINT ids to strings', async () => {
    const database = new FakeDatabase();
    const repo = createAuthRepository(database);

    const user = await repo.findUserByUsername('Worker');

    expect(user).toEqual({
      id: '1',
      username: 'worker',
      displayName: '工友',
      passwordHash: 'hash',
      disabledAt: null,
    });
    expect(database.calls[0].text).toContain('lower(username) = lower($1)');
  });

  it('uses one session transaction for invite registration', async () => {
    const database = new FakeDatabase();
    const repo = createAuthRepository(database);

    await expect(repo.registerWithInvite({
      code: 'invite-1',
      username: 'worker-2',
      displayName: '工友二',
      passwordHash: 'argon-hash',
    })).rejects.toThrow('INVITE_INVALID');

    expect(database.calls.some((call) => call.text === 'BEGIN')).toBe(true);
    expect(database.calls.some((call) => call.text === 'ROLLBACK')).toBe(true);
  });
});
