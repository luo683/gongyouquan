import { z } from 'zod';

export const entityIdSchema = z.string().min(1);
export type EntityId = z.infer<typeof entityIdSchema>;

export const cursorPageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export const syncPageSchema = z.object({
  items: z.array(z.unknown()),
  asOfSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type SyncPage<T> = {
  items: T[];
  asOfSeq: number;
  hasMore: boolean;
};

export const errorCodeSchema = z.enum([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'AUTH_INVALID_CREDENTIALS',
  'INVITE_INVALID',
  'REFRESH_INVALID',
  'REFRESH_REUSED',
  'FORBIDDEN_NOT_MEMBER',
  'FORBIDDEN_ROLE',
  'ACCOUNT_DISABLED',
  'NOT_FOUND',
  'STATE_MACHINE_VIOLATION',
  'EDIT_WINDOW_EXPIRED',
  'DELETE_WINDOW_EXPIRED',
  'GROUP_ARCHIVED',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
    requestId: z.string().min(1),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const messageKindSchema = z.enum(['text', 'image', 'file', 'system', 'task_card']);
export const messageSendSchema = z.object({
  groupId: entityIdSchema,
  clientMsgId: z.string().min(1),
  kind: messageKindSchema,
  body: z.string().optional(),
  refMessageId: entityIdSchema.optional(),
  attachments: z.array(entityIdSchema).optional(),
  mentions: z.array(entityIdSchema).optional(),
});
export type MessageSend = z.infer<typeof messageSendSchema>;

export const authRegisterSchema = z.object({
  code: z.string().min(1),
  username: z.string().min(2).max(32),
  displayName: z.string().min(1).max(64),
  password: z.string().min(10).regex(/[A-Za-z]/).regex(/[0-9]/),
});
export type AuthRegister = z.infer<typeof authRegisterSchema>;

export const authLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  clientKind: z.enum(['desktop', 'web']),
});
export type AuthLogin = z.infer<typeof authLoginSchema>;

export const authRefreshSchema = z.object({
  refreshToken: z.string().min(1).optional(),
});
export type AuthRefresh = z.infer<typeof authRefreshSchema>;
