import type { MessageDto, MessageSyncPage } from '@gongyouquan/contracts';

/**
 * The client-side half of spec 4.3 - written as a pure module so the rules that
 * are easiest to get wrong can be tested without a browser, a socket or a clock.
 *
 * Three state pieces per group, exactly as 4.3.1 names them:
 *   syncedSeq     the highest seq applied contiguously, per the server's word
 *   pendingNew    realtime messages held back because they arrived across a gap
 *   eventBuffer   edits and revokes received while a replay was in flight
 */

export type GroupState = {
  syncedSeq: number;
  /** Ordered by seq ascending; a Map so dedupe by id is exact and cheap. */
  messages: Map<string, MessageDto>;
  pendingNew: MessageDto[];
  eventBuffer: MessageDto[];
  replaying: boolean;
};

export type ApplyResult =
  | { kind: 'applied'; message: MessageDto }
  | { kind: 'held'; reason: 'gap' }
  | { kind: 'dropped'; reason: 'duplicate' | 'stale' };

export function emptyGroup(syncedSeq = 0): GroupState {
  return { syncedSeq, messages: new Map(), pendingNew: [], eventBuffer: [], replaying: false };
}

/**
 * 4.3.4's hard requirement: `message:updated` / `message:deleted` carry the
 * whole DTO, never a diff, so applying one is idempotent and the only thing that
 * decides a winner is updatedAt. Comparing timestamps instead of arrival order
 * is what lets an out-of-order revoke still land correctly.
 */
function merge(local: MessageDto | undefined, incoming: MessageDto): MessageDto | null {
  if (!local) return incoming;
  const localTime = Date.parse(local.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (incomingTime > localTime) return incoming;
  if (incomingTime === localTime && incoming.id === local.id && incoming.body === local.body) {
    // Same revision arriving twice is a redelivery, not a conflict.
    return null;
  }
  return null;
}

export function applyNew(group: GroupState, message: MessageDto): ApplyResult {
  if (group.messages.has(message.id)) {
    return { kind: 'dropped', reason: 'duplicate' };
  }

  if (message.seq <= group.syncedSeq) {
    // Overlapping delivery after a reconnect: the server already accounted for
    // this position, so it is dropped by id and never re-rendered.
    if (merge(group.messages.get(message.id), message) === null) return { kind: 'dropped', reason: 'duplicate' };
    return { kind: 'dropped', reason: 'stale' };
  }

  if (message.seq === group.syncedSeq + 1) {
    group.messages.set(message.id, message);
    group.syncedSeq = message.seq;
    drainPending(group);
    return { kind: 'applied', message };
  }

  // A gap means the replay has not landed yet; buffering instead of applying is
  // what stops the client from showing a hole as if it were the whole history.
  group.pendingNew.push(message);
  return { kind: 'held', reason: 'gap' };
}

/**
 * Edits and revokes are NEVER dropped, even mid-replay (4.3.4). They are
 * buffered and folded in after the replay, because the replay itself returns
 * current state and may already contain the change.
 */
export function applyEvent(group: GroupState, message: MessageDto): ApplyResult {
  if (group.replaying) {
    group.eventBuffer.push(message);
    return { kind: 'held', reason: 'gap' };
  }

  const merged = merge(group.messages.get(message.id), message);
  if (merged === null) return { kind: 'dropped', reason: 'stale' };

  group.messages.set(message.id, merged);
  if (message.seq > group.syncedSeq && !group.pendingNew.some((p) => p.seq === message.seq)) {
    // An edit can outrun the send it belongs to when the send itself has not
    // arrived; the row is kept so the later send has something to overwrite.
    group.pendingNew.push(merged);
  }
  return { kind: 'applied', message: merged };
}

/**
 * Fold one replay page in. `asOfSeq` is adopted unconditionally, even across a
 * jump: 4.3.3 calls this the foundation of the whole mechanism, and a client
 * that insists on contiguity either stalls forever or retries a hole endlessly.
 */
export function applyPage(group: GroupState, page: MessageSyncPage): void {
  for (const message of page.items) {
    const merged = merge(group.messages.get(message.id), message);
    group.messages.set(message.id, merged ?? message);
  }
  group.syncedSeq = Math.max(group.syncedSeq, page.asOfSeq);
  group.replaying = page.hasMore;
  if (!page.hasMore) {
    drainPending(group);
    drainEvents(group);
  }
}

export function startReplay(group: GroupState): void {
  group.replaying = true;
}

function drainPending(group: GroupState): void {
  if (group.pendingNew.length === 0) return;
  const ordered = [...group.pendingNew].sort((a, b) => a.seq - b.seq);
  group.pendingNew = [];
  for (const message of ordered) {
    if (message.seq <= group.syncedSeq) {
      if (!group.messages.has(message.id)) group.messages.set(message.id, message);
      continue;
    }
    if (message.seq === group.syncedSeq + 1) {
      group.messages.set(message.id, message);
      group.syncedSeq = message.seq;
      continue;
    }
    // Still short of a contiguity: keep waiting, the next page or event closes it.
    group.pendingNew.push(message);
  }
}

function drainEvents(group: GroupState): void {
  const buffered = group.eventBuffer.splice(0, group.eventBuffer.length);
  // Arrival order, per 4.3.4; merge() decides whether a given one still matters,
  // which is why the buffer may be applied in any order without corrupting state.
  for (const message of buffered) {
    const merged = merge(group.messages.get(message.id), message);
    if (merged) group.messages.set(message.id, merged);
  }
}

/** Rendering order. seq is the only sort key that is correct across a replay. */
export function orderedMessages(group: GroupState): MessageDto[] {
  return [...group.messages.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * A locally optimistic bubble. It has no seq and no server id; when the ack
 * arrives it is replaced rather than appended, which is what stops the sender
 * from seeing their own message twice.
 */
export type PendingSend = {
  clientMsgId: string;
  body: string;
  failedCode?: string;
};
