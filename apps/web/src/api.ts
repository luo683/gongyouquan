import {
  errorEnvelopeSchema,
  groupDtoSchema,
  groupSummaryDtoSchema,
  inviteDtoSchema,
  memberDtoSchema,
  messageDtoSchema,
  messageReceiptsDtoSchema,
  messageSendResultSchema,
  inviteCreatedDtoSchema,
  type GroupDto,
  type GroupSummaryDto,
  type InviteDto,
  type MemberDto,
  type MessageDto,
  type MessageReceiptsDto,
  type MessageSendResult,
} from '@gongyouquan/contracts';
import { copyFor } from './copy.js';

/**
 * Every response is parsed through the same Zod schemas the backend uses. That
 * is not decoration: an id that arrives as a JSON number instead of a string
 * would silently lose precision past 2^53, and the schema is what makes that a
 * loud failure at the boundary instead of a wrong conversation later.
 */

type Page = { items: unknown[]; nextCursor: string | null; hasMore: boolean };
type InviteCreated = { id: string; code: string; expiresAt: string | null };
type RegisterResult = { user: { id: string }; groups: Array<{ id: string }> };

const BASE = '/api/v1';

export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  user: { id: string; username: string; displayName: string };
};

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly details?: unknown,
  ) {
    super(copyFor(code, details));
    this.name = 'ApiError';
  }
}

let accessToken = '';
let refreshToken = '';

export function setSession(tokens: Partial<Tokens>): void {
  if (tokens.accessToken) accessToken = tokens.accessToken;
  if (tokens.refreshToken) refreshToken = tokens.refreshToken;
}

export function clearSession(): void {
  accessToken = '';
  refreshToken = '';
}

export function hasSession(): boolean {
  return accessToken.length > 0;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; schema: { parse(value: unknown): T } },
): Promise<T> {
  const headers: Record<string, string> = {};
  /**
   * The content-type goes on only when there is a body to describe. A bodyless
   * DELETE that claims application/json is rejected by Fastify with 400
   * FST_ERR_CTP_EMPTY_JSON_BODY, and that response is not our error envelope - so
   * it maps to no code and reaches the user as a generic failure for a write that
   * never ran. Found by driving 移出群 in a real browser; api.revoke had the same
   * defect from the day it was written and nobody noticed, because message
   * revocation travels over the socket instead.
   */
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers,
    credentials: 'include',
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(payload);
    const code = parsed.success ? parsed.data.error.code : 'INTERNAL_ERROR';
    const details = parsed.success ? parsed.data.error.details : undefined;
    throw new ApiError(code, response.status, details);
  }

  return init.schema.parse(payload);
}

/**
 * Joining a second group is still not offered in the UI, and for the original
 * reason: spec 3.1 line 209 makes an invite code something *registration*
 * consumes, and no endpoint lets an already-signed-in account redeem one.
 * createInvite() below mints codes for new people; it is not a join button.
 */
export const api = {
  register: (input: { code: string; username: string; displayName: string; password: string }) =>
    call<{ user: { id: string }; groups: Array<{ id: string }> }>(
      '/auth/register',
      { method: 'POST', body: input, schema: { parse: (value: unknown): RegisterResult => value as RegisterResult } },
    ),

  login: (input: { username: string; password: string; clientKind: 'desktop' | 'web' }) =>
    call<Tokens>('/auth/login', { method: 'POST', body: input, schema: { parse: (v: unknown) => v as Tokens } }),

  groups: async (): Promise<GroupSummaryDto[]> => {
    const list = await call<unknown>('/groups', {
      method: 'GET',
      schema: { parse: (value: unknown): unknown[] => value as unknown[] },
    });
    return (Array.isArray(list) ? list : []).map((row) => groupSummaryDtoSchema.parse(row));
  },

  createGroup: (input: { name: string; description?: string }) =>
    call<GroupDto>('/groups', { method: 'POST', body: input, schema: groupDtoSchema }),

  /**
   * MessageDto carries senderId, not a name - spec 5.4 never puts a display name
   * on it (only lastMessagePreview has senderDisplayName). So the roster is the
   * client's only source for "who said this", and it is fetched once per group
   * rather than guessed at.
   *
   * It is also where the client learns its own role: GET /groups/:gid does return
   * a myMembership, but no contracts schema describes that field, and the caller is
   * in this list anyway.
   */
  members: async (groupId: string): Promise<MemberDto[]> => {
    const rows = await call<unknown>(`/groups/${groupId}/members`, {
      method: 'GET',
      schema: { parse: (value: unknown): unknown[] => value as unknown[] },
    });
    return (Array.isArray(rows) ? rows : []).map((row) => memberDtoSchema.parse(row));
  },

  /** POST /groups/:gid/members - adds someone who already has an account. New people arrive by invite code instead. */
  addMember: (groupId: string, input: { userId: string; role?: 'admin' | 'member' }) =>
    call<MemberDto>(`/groups/${groupId}/members`, { method: 'POST', body: input, schema: memberDtoSchema }),

  /**
   * PATCH /groups/:gid/members/:uid is two mutually exclusive operations sharing
   * one endpoint: appointing or revoking an admin, or handing the group over. The
   * server rejects a body that names both and one that names neither, so the union
   * here is what keeps the client from constructing either.
   */
  updateMember: (
    groupId: string,
    userId: string,
    input: { role: 'admin' | 'member' } | { transferOwnership: true },
  ) => call<MemberDto>(`/groups/${groupId}/members/${userId}`, { method: 'PATCH', body: input, schema: memberDtoSchema }),

  /** DELETE /groups/:gid/members/:uid - 204. Pointing it at yourself is 退出群, and an owner is refused until they transfer. */
  removeMember: (groupId: string, userId: string) =>
    call<void>(`/groups/${groupId}/members/${userId}`, { method: 'DELETE', schema: { parse: (value: unknown) => value } }),

  /** POST /groups/:gid/invites - the code comes back once and is not listed again. */
  createInvite: (
    groupId: string,
    input: { role?: 'admin' | 'member'; maxUses?: number; expiresInHours?: number },
  ) =>
    call<InviteCreated>(`/groups/${groupId}/invites`, {
      method: 'POST',
      body: input,
      schema: inviteCreatedDtoSchema,
    }),

  /** GET /groups/:gid/invites - deliberately carries no plaintext code, only usedCount and revocation state. */
  invites: async (groupId: string): Promise<InviteDto[]> => {
    const rows = await call<unknown>(`/groups/${groupId}/invites`, {
      method: 'GET',
      schema: { parse: (value: unknown): unknown[] => value as unknown[] },
    });
    return (Array.isArray(rows) ? rows : []).map((row) => inviteDtoSchema.parse(row));
  },

  /** DELETE /groups/:gid/invites/:iid - 204, and idempotent: revoking an already-revoked code is not an error. */
  revokeInvite: (groupId: string, inviteId: string) =>
    call<void>(`/groups/${groupId}/invites/${inviteId}`, { method: 'DELETE', schema: { parse: (value: unknown) => value } }),

  history: async (
    groupId: string,
    beforeSeq?: string,
  ): Promise<{ items: MessageDto[]; nextCursor: string | null; hasMore: boolean }> => {
    const query = new URLSearchParams({ limit: '50' });
    if (beforeSeq) query.set('beforeSeq', beforeSeq);
    const page = await call<{ items: unknown[]; nextCursor: string | null; hasMore: boolean }>(
      `/groups/${groupId}/messages?${query.toString()}`,
      { method: 'GET', schema: { parse: (value: unknown): Page => value as Page } },
    );
    return { items: page.items.map((row) => messageDtoSchema.parse(row)), nextCursor: page.nextCursor, hasMore: page.hasMore };
  },

  send: async (groupId: string, input: { clientMsgId: string; body: string }): Promise<MessageSendResult> => {
    const raw = await call<unknown>(`/groups/${groupId}/messages`, {
      method: 'POST',
      body: { ...input, kind: 'text' },
      schema: { parse: (value: unknown): Record<string, unknown> => value as Record<string, unknown> },
    });
    return messageSendResultSchema.parse(raw);
  },

  edit: (messageId: string, body: string) =>
    call<MessageDto>(`/messages/${messageId}`, { method: 'PATCH', body: { body }, schema: messageDtoSchema }),

  revoke: (messageId: string) => call<void>(`/messages/${messageId}`, { method: 'DELETE', schema: { parse: (v: unknown) => v } }),

  read: (groupId: string, lastReadSeq: number) =>
    call<{ lastReadSeq: number; mentionsReadSeq: number }>(`/groups/${groupId}/read`, {
      method: 'POST',
      body: { lastReadSeq },
      schema: { parse: (value: unknown) => value as { lastReadSeq: number; mentionsReadSeq: number } },
    }),

  /**
   * GET /groups/:gid/messages/:mid/receipts - 4.4.3's two tiers. 0 is the cheap
   * aggregate the stream shows at a glance, 1 adds the name list and is only ever
   * asked for on a click. A GET carries no body, so it must not claim a JSON
   * content-type; see the note on call().
   */
  receipts: (groupId: string, messageId: string, detail: 0 | 1) =>
    call<MessageReceiptsDto>(`/groups/${groupId}/messages/${messageId}/receipts?detail=${detail}`, {
      method: 'GET',
      schema: messageReceiptsDtoSchema,
    }),
};

export { refreshToken };
