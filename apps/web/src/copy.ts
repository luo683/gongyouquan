import type { ErrorCode } from '@gongyouquan/contracts';

/**
 * Spec 8.1: the envelope's `message` is English and exists for logs. Every piece
 * of Chinese a worker sees is produced here, keyed off `code`, so the backend can
 * change its log wording without ever changing what a user reads.
 */
const COPY: Record<ErrorCode, string> = {
  INVALID_ARGUMENT: '填写的内容有问题，请检查后重试',
  UNAUTHENTICATED: '请先登录',
  TOKEN_EXPIRED: '登录已过期，正在为你重新登录',
  AUTH_INVALID_CREDENTIALS: '用户名或密码不正确',
  INVITE_INVALID: '邀请码无效或已被用完',
  REFRESH_INVALID: '登录状态已失效，请重新登录',
  REFRESH_REUSED: '该账号已在别处登录，请重新登录',
  FORBIDDEN_NOT_MEMBER: '你已经不在这个群里了',
  FORBIDDEN_ROLE: '你的权限不够，这件事只有群主或管理员能做',
  ACCOUNT_DISABLED: '该账号已被停用，请联系群主',
  CANNOT_REVIEW_OWN_SUBMISSION: '不能验收自己提交的成果',
  NOT_FOUND: '要找的东西不在了',
  STATE_MACHINE_VIOLATION: '当前状态不允许这一步操作',
  EDIT_WINDOW_EXPIRED: '超过 15 分钟不能再改，可以撤回后重发',
  DELETE_WINDOW_EXPIRED: '超过 2 分钟不能撤回了',
  GROUP_ARCHIVED: '这个群已经归档，只能看不能改',
  RATE_LIMITED: '操作太快了，稍等一下再试',
};

export function copyFor(code: string, details?: unknown): string {
  const base = COPY[code as ErrorCode] ?? '出了点问题，请稍后再试';
  const seconds = retryAfterSeconds(details);
  if (code === 'RATE_LIMITED' && seconds) return `${base}（约 ${seconds} 秒后）`;
  return base;
}

/** The WS ack carries the wait in details; the HTTP path also sets Retry-After. */
export function retryAfterSeconds(details: unknown): number | undefined {
  if (details && typeof details === 'object' && 'retryAfterSeconds' in details) {
    const value = (details as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === 'number' && value > 0) return value;
  }
  return undefined;
}

/**
 * A short label for the bubble footer. Kept separate from copyFor because an
 * offline banner wants "已撤回" and nothing else.
 */
export function stateLabel(message: { deletedAt: string | null; editedAt: string | null }): string {
  if (message.deletedAt) return '已撤回';
  if (message.editedAt) return '已编辑';
  return '';
}

/** Spec 3.4's three roles. Unknown values fall through rather than being renamed. */
export function roleLabel(role: string): string {
  switch (role) {
    case 'owner':
      return '群主';
    case 'admin':
      return '管理员';
    case 'member':
      return '成员';
    default:
      return role;
  }
}
