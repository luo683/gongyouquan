import { randomBytes } from 'node:crypto';
import { createAuthRepository } from '../auth/repository.js';
import { createAuthService } from '../auth/service.js';
import { createDatabase, migrateDatabase } from '../db/pool.js';
import { parseEnv } from '../config/env.js';
import argon2 from 'argon2';

/**
 * The one-time bootstrap the deployment otherwise has no way to do.
 *
 * Registration requires an invite code, an invite code requires a group, and a
 * group requires an existing user - so a freshly installed system cannot produce
 * its own first account. Until this existed the only workaround was hand-written
 * SQL against the database, which is precisely the kind of step that gets done
 * differently on every machine and then blamed on the application.
 *
 * Deliberately NOT auto-run at boot. Spec 01 §11 says the explicit operator
 * step is the point: an automatic "create the system group if missing" fails
 * repeatedly when SYSTEM_GROUP_ID is unset, and the failure reads like a
 * database problem in the logs.
 *
 *   docker compose run --rm server node --import tsx src/cli/create-admin.ts \
 *     --username admin --group "#运维告警"
 */

const MIN_PASSWORD_LENGTH = 10;

export type AdminResult = {
  userId: string;
  username: string;
  groupId: string;
  groupName: string;
  inviteCode: string;
  password: string;
};

type Options = {
  username: string;
  displayName: string;
  password: string;
  groupName: string;
  system: boolean;
  maxUses: number;
};

export function parseArgs(argv: string[]): Partial<Options> & { help?: boolean } {
  const out: Partial<Options> & { help?: boolean } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--username': out.username = next(); break;
      case '--display-name': out.displayName = next(); break;
      case '--password': out.password = next(); break;
      case '--group': out.groupName = next(); break;
      case '--system': out.system = true; break;
      case '--max-uses': out.maxUses = Number(next()); break;
      case '--help': out.help = true; break;
      default: throw new Error(`unknown argument ${String(arg)}`);
    }
  }
  return out;
}

/**
 * The same rules auth.register enforces, checked here first so a typo costs a
 * message rather than a half-applied bootstrap.
 */
export function assertUsable(options: Options): void {
  if (options.username.length < 2 || options.username.length > 32 || /\s/.test(options.username)) {
    throw new Error('用户名需要 2-32 个字符，且不含空格');
  }
  if (options.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (!/[A-Za-z]/.test(options.password) || !/[0-9]/.test(options.password)) {
    throw new Error('密码必须同时包含字母和数字');
  }
  if (!Number.isInteger(options.maxUses) || options.maxUses < 1) {
    throw new Error('maxUses 必须是正整数');
  }
}

export function generatedPassword(): string {
  // Letter+digit heavy, no ambiguous glyphs, 14 chars: strong enough for a
  // one-time credential that the operator is told to change.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(14);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  // Guarantee the two classes the policy requires.
  return `a${out}7`;
}

export async function createAdmin(
  databaseUrl: string,
  options: Options,
  log: (line: string) => void = console.log,
): Promise<AdminResult> {
  assertUsable(options);
  const database = createDatabase(databaseUrl);
  try {
    await migrateDatabase(database);

    const existing = await database.query<{ c: string }>(
      `SELECT count(*) AS c FROM users WHERE lower(username) = lower($1)`,
      [options.username],
    );
    const already = Number(existing.rows[0]?.c ?? 0) > 0;
    if (already) {
      // Refusing twice is what keeps a retried deploy from minting a second
      // admin the operator never asked for.
      throw new Error(`用户 ${options.username} 已存在。这个脚本只能运行一次。`);
    }

    const passwordHash = await argon2.hash(options.password, { type: argon2.argon2id });
    const inserted = await database.query<{ id: string }>(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [options.username, options.displayName, passwordHash],
    );
    const userId = String(inserted.rows[0]?.id);

    const group = await database.query<{ id: string }>(
      `INSERT INTO groups (name, description, created_by, is_system)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [options.groupName, options.system ? '系统群：运维告警与审批' : null, userId, options.system],
    );
    const groupId = String(group.rows[0]?.id);

    // The creator is an owner, not just a member: everything in 3.4 that makes a
    // group administrable hangs off that role.
    await database.query(
      `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [groupId, userId],
    );

    const inviteCode = `BOOT-${randomBytes(6).toString('hex').toUpperCase()}`;
    await database.query(
      `INSERT INTO group_invites (group_id, code, role, max_uses, created_by)
       VALUES ($1, $2, 'admin', $3, $4)`,
      [groupId, inviteCode, options.maxUses, userId],
    );

    const result: AdminResult = {
      userId,
      username: options.username,
      groupId,
      groupName: options.groupName,
      inviteCode,
      password: options.password,
    };

    // Printed for one reason: the invite code cannot be recovered any other way,
    // and a password nobody was told is a password that locks the operator out.
    log('');
    log('首个管理员已创建。请立即保存下面三项，它们不会再次打印。');
    log(`  用户名      ${result.username}`);
    log(`  密码        ${result.password}`);
    log(`  邀请码      ${result.inviteCode}   （分发给同事，每个新用户注册消耗一次）`);
    log('');
    log(`把系统群 ID 写入环境变量后重启 API：SYSTEM_GROUP_ID=${result.groupId}`);
    log('');

    // Prove the credential actually works before telling anyone it does: the
    // repository writes and the service reads have to agree about hashing.
    const auth = createAuthService({
      repo: createAuthRepository(database),
      jwtSecret: 'create-admin-verification-only',
    });
    const login = await auth.login({
      username: options.username,
      password: options.password,
      clientKind: 'desktop',
    });
    log(`登录验证通过，access token 长度 ${login.accessToken.length}`);

    return result;
  } finally {
    await database.end();
  }
}

const isMain = process.argv[1]?.includes('create-admin');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: create-admin --username <名字> [--display-name <显示名>] [--password <口令>] [--group <群名>] [--system] [--max-uses <次数>]');
    console.log('缺少 --password 时会生成一个随机口令并打印一次。');
  } else {
    const env = parseEnv(process.env);
    const options: Options = {
      username: args.username ?? 'admin',
      displayName: args.displayName ?? args.username ?? '管理员',
      password: args.password ?? generatedPassword(),
      groupName: args.groupName ?? '#运维告警',
      system: args.system ?? true,
      maxUses: args.maxUses ?? 50,
    };
    createAdmin(env.databaseUrl, options)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error((error as Error).message);
        process.exitCode = 1;
      });
  }
}
