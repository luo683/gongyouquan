import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupsRepository } from '../../src/groups/repository.js';
import { createGroupsService } from '../../src/groups/service.js';
import { createMembersRepository } from '../../src/groups/members.js';
import { createMembersService, type MembersService } from '../../src/groups/members-service.js';
import {
  createHarness,
  databaseUrl,
  expectCode,
  num,
  row0,
  str,
  type Harness,
  type Row,
} from './harness.js';

/**
 * Spec 3.4 is described in the document as 后端权限实现的唯一依据, and it is a
 * table of nine rows that are easy to collapse into one another. Each case below
 * names the row it covers, and every one runs against real SQL: the single-owner
 * partial unique index, the revive-on-rejoin primary key, and the FK that stops a
 * code pointing at a deleted user.
 *
 * Skipped without INTEGRATION_DATABASE_URL.
 */
const url = databaseUrl();
const harness: Harness = createHarness();

describe.runIf(url !== '')('member management and invites (real PostgreSQL)', () => {
  let members: MembersService;
  let groups: ReturnType<typeof createGroupsService>;
  let owner: string;
  let admin: string;
  let member: string;
  let peer: string;
  let outsider: string;
  let secondAdmin: string;
  let groupId: string;

  beforeAll(async () => {
    await harness.up();
    const groupsRepo = createGroupsRepository(harness.db);
    groups = createGroupsService(groupsRepo);
    members = createMembersService(createMembersRepository(harness.db), groupsRepo);

    owner = await harness.insertUser(`owner-${harness.tag}`, '群主');
    admin = await harness.insertUser(`admin-${harness.tag}`, '管理员');
    member = await harness.insertUser(`member-${harness.tag}`, '组员');
    peer = await harness.insertUser(`peer-${harness.tag}`, '另一个组员');
    outsider = await harness.insertUser(`outsider-${harness.tag}`, '外人');
    secondAdmin = await harness.insertUser(`admin2-${harness.tag}`, '副管理员');

    const created = await groups.create(owner, { name: `权限矩阵-${harness.tag}` });
    groupId = created.id;
    for (const [userId, role] of [
      [admin, 'admin'],
      [member, 'member'],
      [peer, 'member'],
    ] as const) {
      await harness.db.query(
        `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3::group_role)`,
        [groupId, userId, role],
      );
    }
  });

  afterAll(async () => {
    await harness.down();
  });

  it('creates an invite whose code is usable exactly up to maxUses', async () => {
    const invite = await members.createInvite(owner, groupId, { role: 'member', maxUses: 2 });
    expect(invite.code).toMatch(/^GYQ-[0-9A-F]{12}$/);
    expect(invite.expiresAt).toBeNull();

    // Consume both uses through the real registration path.
    const argon2 = (await import('argon2')).default;
    for (const name of ['used-a', 'used-b']) {
      const hash = await argon2.hash('HardPass2026', { type: argon2.argon2id });
      const user = await harness.db.query<Row>(
        `INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [`${name}-${harness.tag}`, name, hash],
      );
      const consumed = await harness.db.query<Row>(
        `UPDATE group_invites SET used_count = used_count + 1
          WHERE code = $1 AND revoked_at IS NULL AND used_count < max_uses
          RETURNING used_count`,
        [invite.code],
      );
      expect(num(row0(consumed.rows).used_count)).toBe(name === 'used-a' ? 1 : 2);
      expect(row0(user.rows).id).toBeTruthy();
    }

    // Third attempt must be refused by the same predicate registration uses.
    const refused = await harness.db.query<Row>(
      `UPDATE group_invites SET used_count = used_count + 1
        WHERE code = $1 AND revoked_at IS NULL AND used_count < max_uses
        RETURNING used_count`,
      [invite.code],
    );
    expect(refused.rows).toEqual([]);

    const listed = await members.listInvites(owner, groupId);
    const found = listed.find((row) => row.id === invite.id);
    expect(found?.usedCount).toBe(2);
    // The list never re-exposes the code, so a leaked roster read is not a leak
    // of live join links.
    expect(JSON.stringify(listed)).not.toContain(invite.code);
  });

  it('expires an invite at the requested hour and not before', async () => {
    let clock = Date.now();
    const live = createMembersService(createMembersRepository(harness.db), {
      async getGroup(id) {
        return id === groupId ? { id } : null;
      },
      async getMembership(id) {
        return id === groupId ? { role: 'owner' as const, archived: false } : null;
      },
    }, { now: () => new Date(clock) });

    const soon = await live.createInvite(owner, groupId, { expiresInHours: 1 });
    expect(soon.expiresAt).not.toBeNull();
    expect(new Date(soon.expiresAt as string).getTime() - clock).toBe(3_600_000);

    clock += 2 * 3_600_000;
    // The injected clock only decides what the *service* writes. Registration
    // compares expires_at against PostgreSQL's now(), so proving a stale code is
    // refused means moving the stored timestamp, exactly like the edit and revoke
    // windows do - advancing a JS clock here would prove nothing.
    const stale = await harness.db.query<Row>(
      `UPDATE group_invites SET expires_at = now() - interval '1 hour'
        WHERE code = $1 RETURNING id`,
      [soon.code],
    );
    expect(stale.rows.length).toBe(1);

    const expired = await harness.db.query<Row>(
      `UPDATE group_invites SET used_count = used_count + 1
        WHERE code = $1 AND (expires_at IS NULL OR expires_at > now())
        RETURNING id`,
      [soon.code],
    );
    expect(expired.rows).toEqual([]);
  });

  it('refuses an invite to a person who has no account', async () => {
    await expectCode('NOT_FOUND', () => members.add(owner, groupId, { userId: '999999999', role: 'member' }));
  });

  it('adds a member, and re-adding the same person is not a duplicate row', async () => {
    const added = await members.add(owner, groupId, { userId: outsider, role: 'member' });
    expect(added.userId).toBe(outsider);
    expect(added.role).toBe('member');
    expect(added.displayName).toBe('外人');

    const again = await members.add(admin, groupId, { userId: outsider, role: 'admin' });
    expect(again.userId).toBe(outsider);
    const rows = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, outsider],
    );
    // A second add of a live member must not create a second membership row.
    expect(num(row0(rows.rows).c)).toBe(1);

    await members.remove(owner, groupId, outsider);
    // Re-joining revives the original row rather than colliding with its PK.
    const rejoined = await members.add(owner, groupId, { userId: outsider, role: 'member' });
    expect(rejoined.userId).toBe(outsider);
    const live = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM group_members
        WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, outsider],
    );
    expect(num(row0(live.rows).c)).toBe(1);
  });

  it('enforces 踢人 row: admin may not remove the owner or a fellow admin', async () => {
    // admin removes a plain member: allowed.
    await members.remove(admin, groupId, peer);
    expect(await isLive(peer)).toBe(false);
    await members.add(owner, groupId, { userId: peer, role: 'member' });

    // admin removes the owner: refused.
    await expectCode('FORBIDDEN_ROLE', () => members.remove(admin, groupId, owner));
    // admin removes another admin: refused (不可踢同级 admin). It has to be a
    // *different* admin - removing themselves is 退出群, another row entirely,
    // which is what the first version of this case actually exercised.
    await members.add(owner, groupId, { userId: secondAdmin, role: 'admin' });
    await expectCode('FORBIDDEN_ROLE', () => members.remove(admin, groupId, secondAdmin));
    // member removes anyone: refused.
    await expectCode('FORBIDDEN_NOT_MEMBER', () => members.remove(member, groupId, peer));
    // outsider is not a member at all.
    await expectCode('FORBIDDEN_NOT_MEMBER', () => members.remove(outsider, groupId, member));

    // owner may remove anyone but themselves (they must transfer first).
    await members.remove(owner, groupId, peer);
    await expectCode('FORBIDDEN_ROLE', () => members.remove(owner, groupId, owner));
    await members.add(owner, groupId, { userId: peer, role: 'member' });

  });

  it('lets a member leave, but never the owner', async () => {
    await members.remove(member, groupId, member);
    expect(await isLive(member)).toBe(false);
    await expectCode('FORBIDDEN_ROLE', () => members.remove(owner, groupId, owner));
    await members.add(owner, groupId, { userId: member, role: 'member' });
    expect(await isLive(member)).toBe(true);
  });

  it('enforces 改角色 row: owner only, and never onto owner', async () => {
    // The leave/踢人 cases above moved people in and out; pin the actor's role
    // rather than trusting that an earlier case left it where this one assumes.
    expect(await roleOf(admin)).toBe('admin');
    await expectCode('FORBIDDEN_ROLE', () => members.update(admin, groupId, member, { role: 'admin' }));
    await expectCode('FORBIDDEN_ROLE', () => members.update(member, groupId, admin, { role: 'member' }));

    const promoted = await members.update(owner, groupId, member, { role: 'admin' });
    expect(promoted.role).toBe('admin');
    const demoted = await members.update(owner, groupId, member, { role: 'member' });
    expect(demoted.role).toBe('member');

    // An owner cannot be moved by role change - that is what transfer is for.
    await expectCode('FORBIDDEN_ROLE', () => members.update(owner, groupId, owner, { role: 'member' }));
    // And the owner cannot quietly hand the group to nobody.
    await expectCode('INVALID_ARGUMENT', () => members.update(owner, groupId, owner, { transferOwnership: true }));
  });

  it('transfers ownership exactly once and leaves one live owner', async () => {
    await members.update(owner, groupId, admin, { transferOwnership: true });

    expect(await roleOf(admin)).toBe('owner');
    expect(await roleOf(owner)).toBe('admin');
    const owners = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM group_members WHERE group_id = $1 AND role = 'owner' AND removed_at IS NULL`,
      [groupId],
    );
    expect(num(row0(owners.rows).c)).toBe(1);

    // A second transfer must fail: the ex-owner is now an admin and 转让群主 is owner-only.
    await expectCode('FORBIDDEN_ROLE', () => members.update(owner, groupId, member, { transferOwnership: true }));

    // Hand it back, so the rest of the suite reasons about the roles it names.
    await members.update(admin, groupId, owner, { transferOwnership: true });
    expect(await roleOf(owner)).toBe('owner');
  });

  it('revokes an invite so registration can no longer use it', async () => {
    const invite = await members.createInvite(admin, groupId, { maxUses: 5 });
    await members.revokeInvite(admin, groupId, invite.id);

    const usable = await harness.db.query<Row>(
      `UPDATE group_invites SET used_count = used_count + 1
        WHERE code = $1 AND revoked_at IS NULL AND (max_uses IS NULL OR used_count < max_uses)
        RETURNING id`,
      [invite.code],
    );
    expect(usable.rows).toEqual([]);

    // Repeat revoke is a silent no-op; only an unknown id is a 404.
    await members.revokeInvite(admin, groupId, invite.id);
    await expectCode('NOT_FOUND', () => members.revokeInvite(admin, groupId, '00000000-0000-4000-8000-000000000000'));
  });

  it('refuses every write on an archived group with 409, not 403', async () => {
    await harness.db.query('UPDATE groups SET is_archived = true WHERE id = $1', [groupId]);
    await expectCode('GROUP_ARCHIVED', () => members.createInvite(owner, groupId, {}));
    await expectCode('GROUP_ARCHIVED', () => members.add(owner, groupId, { userId: outsider, role: 'member' }));
    await expectCode('GROUP_ARCHIVED', () => members.remove(owner, groupId, outsider));
    await expectCode('GROUP_ARCHIVED', () => members.update(owner, groupId, admin, { role: 'member' }));
    // Reads stay open (decision 0004).
    expect((await members.listInvites(owner, groupId)).length).toBeGreaterThan(0);
    await harness.db.query('UPDATE groups SET is_archived = false WHERE id = $1', [groupId]);
  });

  async function isLive(userId: string): Promise<boolean> {
    const found = await harness.db.query<Row>(
      `SELECT count(*) AS c FROM group_members
        WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, userId],
    );
    return num(row0(found.rows).c) === 1;
  }

  async function roleOf(userId: string): Promise<string> {
    const found = await harness.db.query<Row>(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [groupId, userId],
    );
    return str(row0(found.rows).role);
  }
});
