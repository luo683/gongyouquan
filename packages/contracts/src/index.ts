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
  'CANNOT_REVIEW_OWN_SUBMISSION',
  'NOT_FOUND',
  'STATE_MACHINE_VIOLATION',
  'EDIT_WINDOW_EXPIRED',
  'DELETE_WINDOW_EXPIRED',
  'GROUP_ARCHIVED',
  'RATE_LIMITED',
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
  /** UUID, not any string: the column is UUID and the retry-reuse contract (spec 5.4) only works if the client cannot invent a non-reusable key. */
  clientMsgId: z.string().uuid(),
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

/** ISO 8601 with an explicit timezone offset, per backend spec 1.3 (no naive local times). */
export const apiTimestampSchema = z.string().datetime({ offset: true });

export const groupRoleSchema = z.enum(['owner', 'admin', 'member']);
export type GroupRole = z.infer<typeof groupRoleSchema>;

export const groupCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
});
export type GroupCreate = z.infer<typeof groupCreateSchema>;

export const groupUpdateSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(500).nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });
export type GroupUpdate = z.infer<typeof groupUpdateSchema>;

export const groupDtoSchema = z.object({
  id: entityIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  isArchived: z.boolean(),
  isSystem: z.boolean(),
  lastSeq: z.number().int().nonnegative(),
  createdAt: apiTimestampSchema,
  updatedAt: apiTimestampSchema,
});
export type GroupDto = z.infer<typeof groupDtoSchema>;

export const lastMessagePreviewSchema = z.object({
  messageId: entityIdSchema,
  kind: messageKindSchema,
  body: z.string().nullable(),
  senderDisplayName: z.string(),
  createdAt: apiTimestampSchema,
});
export type LastMessagePreview = z.infer<typeof lastMessagePreviewSchema>;

export const groupSummaryDtoSchema = groupDtoSchema.extend({
  memberCount: z.number().int().nonnegative(),
  /** Bounded count per spec 4.4.2: the query caps at 100; 100 is the "99+" sentinel. */
  unreadCount: z.number().int().min(0).max(100),
  myLastReadSeq: z.number().int().nonnegative(),
  lastMessagePreview: lastMessagePreviewSchema.nullable(),
});
export type GroupSummaryDto = z.infer<typeof groupSummaryDtoSchema>;

export const memberDtoSchema = z.object({
  userId: entityIdSchema,
  username: z.string(),
  displayName: z.string(),
  role: groupRoleSchema,
  joinedAt: apiTimestampSchema,
});
export type MemberDto = z.infer<typeof memberDtoSchema>;

// ============================================================
// messages / sync —— 说明书 4.2 / 4.3 / 4.4 / 5.4 / 6.4
// ============================================================

/** 一条附件的展示所需最小集；上传本身走 files 模块，本轮不实现。 */
export const messageAttachmentDtoSchema = z.object({
  fileId: entityIdSchema,
  kind: messageKindSchema,
  fileName: z.string(),
  sortIndex: z.number().int().nonnegative(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});
export type MessageAttachmentDto = z.infer<typeof messageAttachmentDtoSchema>;

/**
 * The message row's current state, not a diff.
 *
 * `updatedAt` is load-bearing, not decoration: spec 4.3.4 lets a client resolve
 * out-of-order `message:updated` / `message:deleted` events only by comparing it
 * against the locally stored copy. Requires messages.updated_at (migration 0002).
 */
export const messageDtoSchema = z.object({
  id: entityIdSchema,
  groupId: entityIdSchema,
  seq: z.number().int().nonnegative(),
  /** null = 系统 / 机器人消息，见 messages.sender_id 注释。 */
  senderId: entityIdSchema.nullable(),
  /** Idempotency key; the client must reuse it across retries (spec 5.4). */
  clientMsgId: z.string().uuid().nullable(),
  kind: messageKindSchema,
  body: z.string().nullable(),
  taskId: entityIdSchema.nullable(),
  refMessageId: entityIdSchema.nullable(),
  attachments: z.array(messageAttachmentDtoSchema).default([]),
  mentions: z.array(entityIdSchema).default([]),
  meta: z.record(z.unknown()).nullable(),
  createdAt: apiTimestampSchema,
  editedAt: apiTimestampSchema.nullable(),
  deletedAt: apiTimestampSchema.nullable(),
  deletedBy: entityIdSchema.nullable(),
  updatedAt: apiTimestampSchema,
});
export type MessageDto = z.infer<typeof messageDtoSchema>;

/**
 * Ack for `message:send` (WS) and POST /groups/:gid/messages.
 * `deduplicated` is true when (senderId, clientMsgId) already existed and the
 * original row is being handed back instead of a second copy (spec 5.4).
 */
export const messageSendResultSchema = z.object({
  message: messageDtoSchema,
  deduplicated: z.boolean().default(false),
});
export type MessageSendResult = z.infer<typeof messageSendResultSchema>;

export const messageEditSchema = z.object({
  messageId: entityIdSchema,
  /** 仅 text 类型可编辑；空串无意义，所以 min(1)。 */
  body: z.string().min(1).max(4000),
});
export type MessageEdit = z.infer<typeof messageEditSchema>;

export const messageEditBodySchema = z.object({ body: z.string().min(1).max(4000) });
export type MessageEditBody = z.infer<typeof messageEditBodySchema>;

/** 向前翻历史：游标是 beforeSeq（不含），不反转排序。 */
export const messageHistoryQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export const messagePageSchema = z.object({
  items: z.array(messageDtoSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

// ---------- sync:hello / sync:ready / sync:pull -------------------------

/** 客户端每个群上报自己已连续应用的最高 seq；未上报的群收不到增量。 */
export const syncHelloSchema = z.object({
  groups: z
    .array(z.object({ groupId: entityIdSchema, syncedSeq: z.number().int().nonnegative() }))
    .max(500),
});
export type SyncHello = z.infer<typeof syncHelloSchema>;

/**
 * Server's authoritative per-group watermark, plus the contract hash so an old
 * client can warn without being refused service (spec §7 acceptance item 4).
 */
export const syncReadySchema = z.object({
  groups: z.array(z.object({ groupId: entityIdSchema, lastSeq: z.number().int().nonnegative() })),
  contractVersion: z.string().min(1),
});
export type SyncReady = z.infer<typeof syncReadySchema>;

export const syncPullSchema = z.object({
  groupId: entityIdSchema,
  sinceSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200).default(200),
});
export type SyncPull = z.infer<typeof syncPullSchema>;

/**
 * `asOfSeq` is computed by the server, never by the client (spec 4.3.3):
 * last item's seq when items is non-empty, otherwise groups.last_seq.
 * The client advances syncedSeq to it unconditionally, even across holes.
 */
export const messageSyncPageSchema = z.object({
  items: z.array(messageDtoSchema),
  asOfSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type MessageSyncPage = z.infer<typeof messageSyncPageSchema>;

// ---------- read positions ----------------------------------------------

export const readUpdateSchema = z.object({
  groupId: entityIdSchema,
  lastReadSeq: z.number().int().nonnegative().optional(),
  mentionsReadSeq: z.number().int().nonnegative().optional(),
});
export type ReadUpdate = z.infer<typeof readUpdateSchema>;

/** Both positions only ever move forward: the server applies GREATEST (spec 4.4.1). */
export const readPositionDtoSchema = z.object({
  lastReadSeq: z.number().int().nonnegative(),
  mentionsReadSeq: z.number().int().nonnegative(),
});
export type ReadPositionDto = z.infer<typeof readPositionDtoSchema>;

export const readUpdatedEventSchema = z.object({
  groupId: entityIdSchema,
  userId: entityIdSchema,
  lastReadSeq: z.number().int().nonnegative(),
});
export type ReadUpdatedEvent = z.infer<typeof readUpdatedEventSchema>;

/** 已读回执分级：detail=0 只要两个数，detail=1 才付 readers。 */
export const messageReceiptsDtoSchema = z.object({
  readCount: z.number().int().nonnegative(),
  totalMembers: z.number().int().nonnegative(),
  readers: z
    .array(z.object({
      userId: entityIdSchema,
      displayName: z.string(),
      lastReadSeq: z.number().int().nonnegative(),
    }))
    .optional(),
});
export type MessageReceiptsDto = z.infer<typeof messageReceiptsDtoSchema>;

export const syncStateDtoSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  myLastReadSeq: z.number().int().nonnegative(),
  myMentionsReadSeq: z.number().int().nonnegative(),
});
export type SyncStateDto = z.infer<typeof syncStateDtoSchema>;

// ---------- best-effort / presence / mention events ----------------------

export const groupIdPayloadSchema = z.object({ groupId: entityIdSchema });

export const presenceUpdatedEventSchema = z.object({
  groupId: entityIdSchema,
  userId: entityIdSchema,
  online: z.boolean(),
  at: apiTimestampSchema,
});
export type PresenceUpdatedEvent = z.infer<typeof presenceUpdatedEventSchema>;

export const mentionNewEventSchema = z.object({
  messageId: entityIdSchema,
  groupId: entityIdSchema,
  fromUserId: entityIdSchema,
});
export type MentionNewEvent = z.infer<typeof mentionNewEventSchema>;

/** A WS ack failure carries the envelope without an HTTP requestId. */
export const wsErrorPayloadSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type WsErrorPayload = z.infer<typeof wsErrorPayloadSchema>;
