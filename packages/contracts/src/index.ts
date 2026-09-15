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
  /** Only /hooks/* can answer these two. */
  'HOOK_SIGNATURE_INVALID',
  /** 503: the endpoint works, the deployment has nowhere to put the alert. */
  'OPS_GROUP_NOT_CONFIGURED',
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
export type MessageKind = z.infer<typeof messageKindSchema>;
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

/** WS `message:delete` payload (spec event table: `{messageId}` -> `{ok: true}`). */
export const messageDeleteSchema = z.object({ messageId: entityIdSchema });
export type MessageDelete = z.infer<typeof messageDeleteSchema>;

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

/**
 * 说明书 637 行的路由表点名了 `MentionDTO`，却从未定义它的字段——这一份是我们的，
 * 记在 `docs/decisions/0010`。
 *
 * 带上 `groupName` 是因为这个列表**跨群**，光一个 groupId 对人没有意义；带上
 * `fromDisplayName` 是因为 `MessageDto` 刻意不含发送者名字（5.4）。`unread` 由
 * `read_positions.mentions_read_seq` 派生（6.6），那是与 `last_read_seq` 独立的
 * 另一条消费进度线：群消息读完了，不代表「@我的」也处理完了。
 */
export const mentionDtoSchema = z.object({
  messageId: entityIdSchema,
  groupId: entityIdSchema,
  groupName: z.string(),
  seq: z.number().int().nonnegative(),
  fromUserId: entityIdSchema.nullable(),
  fromDisplayName: z.string(),
  body: z.string().nullable(),
  createdAt: apiTimestampSchema,
  unread: z.boolean(),
});
export type MentionDto = z.infer<typeof mentionDtoSchema>;

/** GET /me/mentions —— 游标是 messageId，跨群所以不能用 seq（每个群各自编号）。 */
export const mentionQuerySchema = z.object({
  unreadOnly: z.enum(['0', '1']).optional().transform((value) => value === '1'),
  cursor: entityIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MentionQuery = z.infer<typeof mentionQuerySchema>;

export const mentionPageSchema = z.object({
  items: z.array(mentionDtoSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type MentionPage = z.infer<typeof mentionPageSchema>;

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
  /**
   * 已经在线的人（限调用者真正在的那些群）。
   *
   * 没有这份快照，客户端只能靠 `presence:updated` 的增量去认识在线状态——刷新之后
   * 它要等到某人下次上下线才知道对方在不在，在那之前任何在线标记都是恒假的「全员
   * 离线」。恒为假的指示器比没有指示器更糟，所以补在这里：`sync:hello` 本来就是
   * 连接后第一件事，客户端也本来就在等这个回答，不额外多一次往返。
   * `decisions/0009` 第二节的选项 A。刻意设为必填，让每个生产方都得明确回答。
   */
  online: z.array(entityIdSchema),
});
export type SyncReady = z.infer<typeof syncReadySchema>;

export const syncPullSchema = z.object({
  groupId: entityIdSchema,
  sinceSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(200).default(200),
});
export type SyncPull = z.infer<typeof syncPullSchema>;

/**
 * The HTTP fallback takes the same page over a query string, where every value
 * arrives as text. Coercion lives here rather than in syncPullSchema so the WS
 * path keeps rejecting a JSON string where a number belongs.
 */
export const syncPullQuerySchema = z.object({
  sinceSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;

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

/**
 * 已读回执的分级开关（说明书 667 行：`?detail=0|1`）。
 *
 * 刻意用两值枚举而不是 `z.coerce.number()`：coerce 会把 `?detail=` 这种空值静默
 * 变成 0，一个拼错的请求看起来就像合法的「只要聚合」。枚举让它在契约层就 400。
 */
export const messageReceiptsQuerySchema = z.object({
  detail: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => Number(value)),
});
export type MessageReceiptsQuery = z.infer<typeof messageReceiptsQuerySchema>;

export const syncStateDtoSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  myLastReadSeq: z.number().int().nonnegative(),
  myMentionsReadSeq: z.number().int().nonnegative(),
});
export type SyncStateDto = z.infer<typeof syncStateDtoSchema>;

// ---------- best-effort / presence / mention events ----------------------

export const groupIdPayloadSchema = z.object({ groupId: entityIdSchema });

/**
 * `typing:start` / `typing:stop` from client to server (说明书 739 行)：只有 groupId，
 * **没有 ack**，尽力而为、可丢、不落库。
 */
export const typingSignalSchema = groupIdPayloadSchema;
export type TypingSignal = z.infer<typeof typingSignalSchema>;

/**
 * The relayed form. 说明书的 Server→Client 表（743-756 行）**根本没有 typing 这一行**——
 * 它定义了客户端怎么发，却没说对端怎么收。事件名沿用客户端那两个，载荷补上 `userId`：
 * 没有它，收到的人无从知道是谁在输入，而发送者自己的 id 对发送者毫无意义。
 * 这个缺口登记在 `docs/decisions/0009`。
 */
export const typingEventSchema = z.object({
  groupId: entityIdSchema,
  userId: entityIdSchema,
});
export type TypingEvent = z.infer<typeof typingEventSchema>;

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

// ============================================================
// 成员管理与邀请码 —— 说明书 5.3、3.4 权限矩阵
// ============================================================

/** POST /groups/:gid/invites —— role 默认 member，expiresInHours 省略即长期有效。 */
export const inviteCreateSchema = z.object({
  role: groupRoleSchema.optional(),
  maxUses: z.number().int().min(1).max(1000).optional(),
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
});
export type InviteCreate = z.infer<typeof inviteCreateSchema>;

/** 刚创建出来的邀请码：code 只在这里出现，列表里不再回显。 */
export const inviteCreatedDtoSchema = z.object({
  id: entityIdSchema,
  code: z.string().min(1),
  expiresAt: apiTimestampSchema.nullable(),
});
export type InviteCreatedDto = z.infer<typeof inviteCreatedDtoSchema>;

/** GET /groups/:gid/invites —— 不含 code 本身，含 usedCount 与撤销态。 */
export const inviteDtoSchema = z.object({
  id: entityIdSchema,
  role: groupRoleSchema,
  maxUses: z.number().int().positive().nullable(),
  usedCount: z.number().int().nonnegative(),
  createdBy: entityIdSchema,
  expiresAt: apiTimestampSchema.nullable(),
  revokedAt: apiTimestampSchema.nullable(),
  createdAt: apiTimestampSchema,
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;

/** POST /groups/:gid/members —— 只加已经是系统用户的人。 */
export const memberAddSchema = z.object({
  userId: entityIdSchema,
  role: z.enum(['admin', 'member']).default('member'),
});
export type MemberAdd = z.infer<typeof memberAddSchema>;

/**
 * PATCH /groups/:gid/members/:uid 是两种操作共用一个端点，且互斥：
 * 改角色只有 owner 能做，转让群主也是。校验放在服务端而不是 Zod，
 * 因为「两个都给了」和「两个都没给」的错误语义不同（INVALID_ARGUMENT）。
 */
export const memberUpdateSchema = z
  .object({
    role: z.enum(['admin', 'member']).optional(),
    transferOwnership: z.boolean().optional(),
  })
  .refine((value) => value.role !== undefined || value.transferOwnership === true, {
    message: 'role 或 transferOwnership 至少要给一个',
  });
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

// ============================================================
// 告警接口 —— 说明书 03 的 5.8 与 8.2 表末行（/hooks/*）
// ============================================================

export const alertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

/**
 * POST /hooks/alert 的请求体。无登录态，靠 HMAC 头证明来源（见服务端 ops/hmac.ts）。
 *
 * `source` 是一个标签而不是自由文本，`title` 不许带换行——这两条都不是审美：服务端把
 * 聚合键拼成 `source + \n + title`，分隔符必须出现在任何一半之外，否则
 * `source="a", title="b\nc"` 与 `source="a\nb", title="c"` 会落进同一个窗口，
 * 把两件不相干的故障合并成一条计数消息。单行标题本来也是运维群那条消息要的形状。
 *
 * `idempotencyKey` 是必填而不是可选：这个键是「重复投递只落一条」的唯一依据，
 * 少了它就得改用 (source, title, 时间窗) 猜，而猜出来的幂等会把两分钟内两次
 * 真实故障合并成一条。发送方（notify-alert.sh、ops-collect.sh、Uptime Kuma 的
 * 转发脚本）都握得出生成这个键的材料，所以把它做成必填没有代价。
 *
 * `detail` 的上限放得很宽（20 KB）：这条消息的全部意义是「有一件事坏了」，
 * 因为超长度而 400 掉的告警等于丢掉告警。超限的裁剪发生在渲染那条群消息的时候，
 * 不在入口。
 */
export const alertHookSchema = z.object({
  source: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'source 只能做标签：字母数字与 . _ -'),
  severity: alertSeveritySchema,
  title: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n]/.test(value), 'title 必须是单行'),
  detail: z.string().max(20_000).optional(),
  fingerprint: z.string().max(128).optional(),
  idempotencyKey: z.string().min(1).max(200),
});
export type AlertHook = z.infer<typeof alertHookSchema>;

/**
 * `deduplicated` 是说明书响应 shape 里没写的一个字段。加上它是因为重投的发送方
 * 需要区分「我的告警第一次被收到」和「收到但我早就收过」——前者意味着链路通了，
 * 后者意味着某个上游在重试，这两件事在排障时不是同一个信号。
 *
 * `messageId` 只在一种情况下为 null：重放，而当初那条群消息已经不在了（删掉运维群
 * 会级联删掉它）。发送方把 `deduplicated: true` 理解成「没有新东西发生」即可，
 * 不必依赖这个 id 指到哪一行。
 */
export const alertHookResultSchema = z.object({
  messageId: entityIdSchema.nullable(),
  deduplicated: z.boolean(),
});
export type AlertHookResult = z.infer<typeof alertHookResultSchema>;
