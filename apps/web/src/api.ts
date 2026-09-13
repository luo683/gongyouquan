import {
  errorEnvelopeSchema,
  groupDtoSchema,
  groupSummaryDtoSchema,
  messageDtoSchema,
  messageSendResultSchema,
  type GroupDto,
  type GroupSummaryDto,
  type MessageDto,
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
  const headers: Record<string, string> = { 'content-type': 'application/json' };
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
 * There is deliberately no createInvite() here. The server has no invite
 * management endpoint yet (docs/HANDOVER lists it as outstanding), and a client
 * that fabricated a code locally would appear to work right up until the invitee
 * could not actually use it. Joining a second group is blocked in the UI until
 * that route exists.
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

  history: async (groupId: string, beforeSeq?: string): Promise<{ items: MessageDto[]; nextCursor: string | null; hasMore: boolean }> => {
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
};

export { refreshToken };
