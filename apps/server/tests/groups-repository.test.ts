import { describe, expect, it } from 'vitest';
import { createGroupsRepository } from '../src/groups/repository.js';

type Call = { text: string; values?: unknown[] };

class FakeDatabase {
  calls: Call[] = [];
  rows: Record<string, unknown>[] = [];

  async withSession<T>(fn: (client: FakeDatabase) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async query<T = unknown>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, values });
    return { rows: this.rows } as { rows: T[] };
  }
}

describe('groups repository SQL', () => {
  it('maps BIGINT ids to strings and reads membership only for live rows', async () => {
    const database = new FakeDatabase();
    database.rows = [{ role: 'admin', archived: false }];
    const repo = createGroupsRepository(database);

    const membership = await repo.getMembership('10', '3');

    expect(membership).toEqual({ role: 'admin', archived: false });
    expect(database.calls[0].text).toContain('gm.removed_at IS NULL');
    expect(database.calls[0].values).toEqual(['10', '3']);
  });

  it('creates the group and the owner membership in one session transaction', async () => {
    const database = new FakeDatabase();
    database.rows = [{
      id: '11', name: '新工地', description: null, is_archived: false, is_system: false,
      last_seq: 0, created_at: new Date('2026-09-13T04:00:00Z'), updated_at: new Date('2026-09-13T04:00:00Z'),
    }];
    const repo = createGroupsRepository(database);

    const group = await repo.createGroup({ name: '新工地', description: null, ownerId: '4' });

    expect(group).toMatchObject({ id: '11', name: '新工地', isArchived: false, lastSeq: 0 });
    expect(group.createdAt).toBe('2026-09-13T04:00:00.000Z');
    const texts = database.calls.map((call) => call.text);
    expect(texts).toContain('BEGIN');
    expect(texts.some((text) => text.includes('INSERT INTO groups'))).toBe(true);
    expect(texts.some((text) => text.includes("INSERT INTO group_members") && text.includes("'owner'"))).toBe(true);
    expect(texts).toContain('COMMIT');
  });

  it('bounds the unread count and filters archived groups unless requested', async () => {
    const database = new FakeDatabase();
    const repo = createGroupsRepository(database);

    await repo.listGroups('5', false);

    const call = database.calls[0];
    expect(call.text).toContain('LIMIT 100');
    expect(call.text).toContain('IS DISTINCT FROM');
    expect(call.text).toContain("kind <> 'system'");
    expect(call.text).toContain('$2 = true OR g.is_archived = false');
    expect(call.values).toEqual(['5', false]);
  });
});
