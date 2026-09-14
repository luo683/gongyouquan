import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupSummaryDto, InviteDto, MemberDto, MessageDto, MessageReceiptsDto, ReadUpdatedEvent, TypingEvent } from '@gongyouquan/contracts';
import { io, type Socket } from 'socket.io-client';
import { api, ApiError, clearSession, hasSession, setSession, type Tokens } from './api.js';
import { copyFor, retryAfterSeconds, roleLabel, stateLabel } from './copy.js';
import { applyEvent, applyNew, applyPage, emptyGroup, orderedMessages, type GroupState } from './syncStore.js';

/**
 * The whole client in one file on purpose: it is a transport and a view, not a
 * framework. Everything it shows came from the server through a Zod schema -
 * there is no seeded conversation, no placeholder avatar, no "coming soon"
 * message anywhere in this component tree.
 */

type Phase = 'signed-out' | 'working';

export function App() {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [notice, setNotice] = useState('');
  /**
   * A second channel for the member panel. Verified in a real browser: a refusal
   * from 加人 rendered in the left sidebar while the user was looking at the panel
   * on the right, which is indistinguishable from the click doing nothing. Panel
   * actions report here so the message lands where the click happened.
   */
  const [panelNotice, setPanelNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const groups = useState<GroupSummaryDto[]>([]);
  const [groupList, setGroupList] = groups;
  const [selected, setSelected] = useState<string | null>(null);
  const [streams, setStreams] = useState<Record<string, GroupState>>({});
  /**
   * The member list for the group on screen, straight from GET /groups/:gid/members.
   * MessageDto deliberately has no sender name, so this is the only honest way to
   * label a bubble - and it is also where the client learns its own role, since no
   * contracts schema describes the myMembership that GET /groups/:gid returns.
   */
  const [members, setMembers] = useState<MemberDto[]>([]);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<'admin' | 'member'>('member');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviteMaxUses, setInviteMaxUses] = useState('10');
  /** The plaintext code, shown once: the list endpoint stops returning it. */
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  /**
   * Two-step confirmation for the two actions that are hard to undo. Not
   * window.confirm: a modal dialog cannot be driven by an automated browser, which
   * is the same reason createGroup gave up window.prompt.
   */
  const [confirming, setConfirming] = useState<{ kind: 'remove' | 'transfer'; userId: string } | null>(null);
  /**
   * messageId -> receipts. One entry carries both tiers: `readers` being present
   * is what records that the expensive tier was paid for. Cleared on group switch,
   * so it is bounded by one room's scrollback rather than the whole session.
   */
  const [receipts, setReceipts] = useState<Record<string, MessageReceiptsDto>>({});
  /**
   * A ref mirror, for the same reason selectedRef exists: the socket handlers and
   * the intersection observer are each set up once, and reading the state from
   * those closures would see the cache as it was at mount - always empty.
   */
  const receiptsRef = useRef<Record<string, MessageReceiptsDto>>({});
  /** One name list at a time; spec 4.4.3 wants the names to stay rare. */
  const [openReceipt, setOpenReceipt] = useState<string | null>(null);
  /** Keyed by message AND tier, so a click for names is not swallowed by an aggregate fetch in flight. */
  const inFlight = useRef<Set<string>>(new Set());
  const streamRef = useRef<HTMLOListElement | null>(null);
  /** userId -> true, for the room on screen only. */
  const [typers, setTypers] = useState<Record<string, true>>({});
  const typingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingStart = useRef(0);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const statesRef = useRef<Record<string, GroupState>>({});
  /**
   * The socket handlers are registered once (openSocket closes over [commit]),
   * so reading `selected` from closure there would go stale the moment the user
   * switches rooms. This ref mirrors it, letting message:new decide whether its
   * group is the one actually on screen and therefore being read.
   */
  const selectedRef = useRef<string | null>(null);

  const phase: Phase = tokens && hasSession() ? 'working' : 'signed-out';

  const commit = useCallback((groupId: string, mutate: (state: GroupState) => void) => {
    const current = statesRef.current[groupId] ?? emptyGroup(0);
    const clone: GroupState = {
      ...current,
      messages: new Map(current.messages),
      pendingNew: [...current.pendingNew],
      eventBuffer: [...current.eventBuffer],
    };
    mutate(clone);
    statesRef.current = { ...statesRef.current, [groupId]: clone };
    setStreams({ ...statesRef.current });
  }, []);

  const refreshGroups = useCallback(async () => {
    try {
      setGroupList(await api.groups());
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '群列表拉取失败');
    }
  }, [setGroupList]);

  /**
   * Cold start follows 4.3.2 exactly: hello first, then pull every group whose
   * server watermark is ahead of what is applied locally.
   */
  const openSocket = useCallback(
    (accessTokenValue: string) => {
      const socket = io('/', { auth: { token: accessTokenValue }, transports: ['websocket'] });
      socketRef.current = socket;
      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));

      socket.on('message:new', (message: MessageDto) => {
        commit(message.groupId, (state) => void applyNew(state, message));
        // Only the room on screen is being read; a message in another group has
        // to keep its badge, or unread counts would always be zero.
        if (message.groupId === selectedRef.current) void advanceRead(message.groupId, message.seq);
      });
      socket.on('message:updated', (message: MessageDto) => {
        commit(message.groupId, (state) => void applyEvent(state, message));
      });
      socket.on('message:deleted', (message: MessageDto) => {
        commit(message.groupId, (state) => void applyEvent(state, message));
      });
      /**
       * Someone advanced their position, so every cached count for this room may
       * now be too low. Refetch what is already on screen: dropping the cache
       * would not help, because a row that is already visible will never fire
       * another intersection and would stay stale until the user scrolled it away
       * and back.
       */
      socket.on('read:updated', (event: ReadUpdatedEvent) => {
        if (event.groupId !== selectedRef.current) return;
        for (const messageId of Object.keys(receiptsRef.current)) fetchReceipt(event.groupId, messageId);
      });
      // Only the room on screen is drawn, so a signal for another group is
      // dropped rather than allowed to mark someone typing where nobody can see.
      socket.on('typing:start', (event: TypingEvent) => {
        if (event.groupId !== selectedRef.current) return;
        markTyping(event.userId);
      });
      socket.on('typing:stop', (event: TypingEvent) => {
        if (event.groupId !== selectedRef.current) return;
        clearTyping(event.userId);
      });
      socket.on('sync:ready', (ready: { groups: Array<{ groupId: string; lastSeq: number }> }) => {
        for (const group of ready.groups) {
          const local = statesRef.current[group.groupId] ?? emptyGroup(0);
          if (group.lastSeq > local.syncedSeq) void pull(socket, group.groupId, local.syncedSeq, commit);
        }
      });
    },
    [commit],
  );

  async function signIn(next: Tokens): Promise<void> {
    setSession(next);
    setTokens(next);
    setNotice('');
    await refreshGroups();
    if (next.accessToken) openSocket(next.accessToken);
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!username.trim() || !password) {
      setNotice('用户名和密码都要填');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        if (!inviteCode.trim()) {
          setNotice('没有邀请码注册不了。工友圈只允许邀请加入，请向群主或管理员要一个');
          return;
        }
        await api.register({ code: inviteCode.trim(), username: username.trim(), displayName: username.trim(), password });
      }
      const loggedIn = await api.login({ username: username.trim(), password, clientKind: 'web' });
      await signIn(loggedIn);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      const seconds = error instanceof ApiError ? retryAfterSeconds(error.details) : undefined;
      setNotice(copyFor(code) + (seconds ? `，约 ${seconds} 秒后可再试` : ''));
    } finally {
      setBusy(false);
    }
  }

  async function chooseGroup(groupId: string): Promise<void> {
    // Captured before the mirror moves: the outgoing typing:stop belongs to the
    // room being left, and selectedRef is about to point somewhere else.
    const leaving = selectedRef.current;
    setSelected(groupId);
    // Set the mirror synchronously: the useEffect only runs after render, and a
    // message:new landing mid-await would otherwise be judged against the room we
    // just left.
    selectedRef.current = groupId;
    setNotice('');
    // Panel state belongs to the room we are leaving. Clearing it first is what
    // stops an invite code minted for one group from being displayed against another.
    setMembers([]);
    setInvites([]);
    setMintedCode(null);
    setConfirming(null);
    setAddUserId('');
    setPanelNotice('');
    // Receipts belong to the room being left. The ref mirror and the in-flight set
    // go with it, or a fetch started for the old room would land in the new cache.
    receiptsRef.current = {};
    setReceipts({});
    setOpenReceipt(null);
    inFlight.current.clear();
    // Typists belong to the room being left, and an idle stop armed for it would
    // otherwise fire against the new one.
    clearAllTyping();
    stopTyping(leaving);
    const socket = socketRef.current;
    if (!socket) return;
    const local = statesRef.current[groupId] ?? emptyGroup(0);
    // Names come from the member list, not from the message: MessageDto has senderId
    // only. Fetched before the history so the first paint is already labelled.
    await reloadPeople(groupId);
    // 4.3.2: history first for context, then the replay for anything missed.
    try {
      const page = await api.history(groupId);
      commit(groupId, (state) => {
        for (const message of page.items) state.messages.set(message.id, message);
      });
    } catch (error) {
      if (error instanceof ApiError) setNotice(error.message);
    }
    await pull(socket, groupId, statesRef.current[groupId]?.syncedSeq ?? local.syncedSeq, commit);
    // Opening the room marks everything now loaded as read. advanceRead is
    // monotonic server-side (GREATEST), so this only ever moves the badge forward.
    const synced = statesRef.current[groupId]?.syncedSeq ?? 0;
    if (synced > 0) await advanceRead(groupId, synced);
  }

  /**
   * Re-read after every mutation rather than patching the list locally: the server
   * is the authority on who holds which role, and a local patch drifts the moment
   * anyone else in the room changes it.
   */
  async function reloadPeople(groupId: string, report: (text: string) => void = setNotice): Promise<void> {
    let people: MemberDto[];
    try {
      people = await api.members(groupId);
    } catch (error) {
      if (error instanceof ApiError) report(error.message);
      return;
    }
    setMembers(people);
    // The invite list is owner/admin only. A plain member would get 403, which is
    // the endpoint working correctly, so it is not worth a red banner.
    const mine = people.find((person) => person.userId === tokens?.user.id)?.role;
    if (mine !== 'owner' && mine !== 'admin') {
      setInvites([]);
      return;
    }
    try {
      setInvites(await api.invites(groupId));
    } catch (error) {
      setInvites([]);
      if (error instanceof ApiError) report(error.message);
    }
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    const socket = socketRef.current;
    if (!body || !selected || !socket || !tokens) return;
    setDraft('');
    // The message is the end of the sentence; leaving the indicator up after it
    // lands would be a lie the peers can see.
    stopTyping();
    // clientMsgId is generated once per composition and reused by the server-side
    // idempotency key if we ever retry; the socket ack is what turns it into a
    // real message, so nothing is rendered as sent before then.
    socket.emit('message:send', { groupId: selected, clientMsgId: crypto.randomUUID(), kind: 'text', body }, (
      response: { message?: MessageDto; error?: { code: string; details?: unknown } },
    ) => {
      if (response?.error) {
        setNotice(copyFor(response.error.code));
        return;
      }
      if (response?.message) commit(response.message.groupId, (state) => void applyNew(state, response.message as MessageDto));
    });
  }

  /**
   * Creating a group is the one write the sidebar can offer without guessing at
   * an endpoint: POST /groups exists and makes the caller its owner.
   */
  /**
   * An inline field rather than window.prompt: a modal dialog cannot be driven
   * by an automated browser, is suppressed in some embedded webviews, and gives
   * no way to show the server's reason when the name is rejected.
   */
  async function createGroup(): Promise<void> {
    const name = newGroupName.trim();
    if (!name) {
      setNotice('先给群起个名字');
      return;
    }
    try {
      const created = await api.createGroup({ name });
      setNotice('');
      setNewGroupName('');
      await refreshGroups();
      // Through chooseGroup, not setSelected: setting the id alone leaves the room
      // half-open - the member panel keeps showing the previous group's members,
      // no history or replay is loaded, and the socket room is never joined, so
      // incoming messages are missed until the user happens to send one.
      await chooseGroup(created.id);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '建群失败');
    }
  }

  /**
   * One funnel for every member mutation: clear the stale error, do the write,
   * re-read the list, refresh the sidebar's member counts, and show the server's
   * own reason if it refused. Hiding a button the caller has no role for is
   * politeness - the server's answer is the actual gate, and spec 8.1 puts the
   * wording the user reads in copy.ts, keyed off the code it sends.
   */
  async function mutate(action: (groupId: string) => Promise<unknown>): Promise<void> {
    const groupId = selected;
    if (!groupId) return;
    setPanelNotice('');
    try {
      await action(groupId);
      await reloadPeople(groupId, setPanelNotice);
      await refreshGroups();
    } catch (error) {
      setPanelNotice(error instanceof ApiError ? error.message : '操作失败，请稍后再试');
    } finally {
      setConfirming(null);
    }
  }

  /**
   * Codes are minted here and shown once, because the list endpoint stops
   * returning them after creation - so a leaked roster read is not a leaked
   * join link, and there is no way to recover one from the UI.
   */
  async function mintInvite(): Promise<void> {
    const maxUses = Number.parseInt(inviteMaxUses, 10);
    await mutate(async (groupId) => {
      const invite = await api.createInvite(groupId, {
        role: inviteRole,
        // An empty or nonsensical count means "unlimited", which the server models
        // as maxUses: null rather than as a number it has to validate.
        ...(Number.isInteger(maxUses) && maxUses >= 1 ? { maxUses } : {}),
      });
      setMintedCode(invite.code);
    });
  }

  /**
   * Leaving deliberately does not go through mutate(): the caller has just stopped
   * being a member, so the re-read would answer 403 and paint a successful exit as
   * a failure. Drop the room and let the sidebar show the shorter list.
   */
  async function leaveGroup(): Promise<void> {
    const groupId = selected;
    const me = tokens?.user.id;
    if (!groupId || !me) return;
    setPanelNotice('');
    try {
      await api.removeMember(groupId, me);
      setSelected(null);
      selectedRef.current = null;
      setMembers([]);
      setInvites([]);
      setPeopleOpen(false);
      await refreshGroups();
    } catch (error) {
      // An owner is refused here until they hand the group over; that reason comes
      // from the server and is the whole point of not swallowing it.
      setPanelNotice(error instanceof ApiError ? error.message : '退群失败');
    }
  }

  /**
   * Opening a room, and every message that lands while it is open, advances the
   * read position. Without this the unread badge can never clear - api.read()
   * existed and nothing called it, which is exactly the kind of half-wired
   * feature that looks finished in a screenshot.
   *
   * It is monotonic server-side (GREATEST), so a stale call is harmless rather
   * than a race: this is also why no client-side "highest sent" bookkeeping is needed.
   */
  const lastSentRead = useRef<Record<string, number>>({});
  async function advanceRead(groupId: string, seq: number): Promise<void> {
    if (seq <= (lastSentRead.current[groupId] ?? 0)) return;
    lastSentRead.current[groupId] = seq;
    const socket = socketRef.current;
    if (socket?.connected) {
      socket.emit('read:update', { groupId, lastReadSeq: seq }, () => void refreshGroups());
      return;
    }
    try {
      await api.read(groupId, seq);
      await refreshGroups();
    } catch (error) {
      if (error instanceof ApiError) setNotice(error.message);
    }
  }

  /**
   * Reads the tier back out of the cache unless the caller names one, so a refresh
   * never silently drops a name list the user is currently looking at.
   *
   * Failures are swallowed on purpose. A count that will not load is worth much
   * less than a stream that stops rendering; the chip simply stays absent until
   * the next read:updated asks again.
   */
  function fetchReceipt(groupId: string, messageId: string, detail?: 0 | 1): void {
    const tier: 0 | 1 = detail ?? (receiptsRef.current[messageId]?.readers ? 1 : 0);
    const key = `${messageId}:${tier}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    void api
      .receipts(groupId, messageId, tier)
      .then((dto) => {
        receiptsRef.current = { ...receiptsRef.current, [messageId]: dto };
        setReceipts(receiptsRef.current);
      })
      .catch(() => undefined)
      .finally(() => inFlight.current.delete(key));
  }

  /**
   * Spec 4.4.3: the aggregate is fetched as a message scrolls into view and
   * cached, and the name list only on a click. Observing rows rather than walking
   * the history is what keeps a long scrollback from costing one count query per
   * message on every room open.
   *
   * Rows carry data-mid only when a chip will be drawn on them, so the observer is
   * never asked about a message nobody can expand.
   */
  useEffect(() => {
    const root = streamRef.current;
    const groupId = selected;
    if (!root || !groupId) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const messageId = (entry.target as HTMLElement).dataset.mid;
          if (!messageId || receiptsRef.current[messageId]) continue;
          fetchReceipt(groupId, messageId);
        }
      },
      { root, threshold: 0.5 },
    );
    for (const row of root.querySelectorAll<HTMLElement>('[data-mid]')) observer.observe(row);
    return () => observer.disconnect();
  }, [selected, streams]);

  /**
   * A peer who vanishes mid-sentence never sends typing:stop, and spec line 739
   * says these signals are best effort and may simply be dropped. So every start
   * arms its own expiry - without one, "正在输入" would stick to the room forever
   * and nobody could tell it apart from someone genuinely still typing.
   *
   * Refs and the functional setState only: this is called from a socket handler
   * registered once, so reading state here would see the values from mount.
   */
  const TYPING_TTL_MS = 6_000;
  function clearTyping(userId: string): void {
    clearTimeout(typingTimers.current[userId]);
    delete typingTimers.current[userId];
    setTypers((previous) => {
      if (!previous[userId]) return previous;
      const next = { ...previous };
      delete next[userId];
      return next;
    });
  }

  function markTyping(userId: string): void {
    clearTimeout(typingTimers.current[userId]);
    typingTimers.current[userId] = setTimeout(() => clearTyping(userId), TYPING_TTL_MS);
    setTypers((previous) => (previous[userId] ? previous : { ...previous, [userId]: true }));
  }

  function clearAllTyping(): void {
    for (const userId of Object.keys(typingTimers.current)) clearTyping(userId);
  }

  /**
   * Throttled to one start every few seconds, because emitting per keystroke would
   * put a packet on the wire for every letter and re-render every peer for each
   * one. The idle timeout closes over the group id captured now: by the time it
   * fires, `selected` may well be a different room, and a stop aimed at the wrong
   * room would leave this one showing a typist who has gone.
   */
  const TYPING_THROTTLE_MS = 3_000;
  function announceTyping(): void {
    const socket = socketRef.current;
    const groupId = selected;
    if (!socket?.connected || !groupId) return;
    const now = Date.now();
    if (now - lastTypingStart.current > TYPING_THROTTLE_MS) {
      lastTypingStart.current = now;
      socket.emit('typing:start', { groupId });
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(() => {
      typingIdle.current = null;
      lastTypingStart.current = 0;
      if (socketRef.current?.connected) socketRef.current.emit('typing:stop', { groupId });
    }, TYPING_THROTTLE_MS);
  }

  /**
   * Called on send, where the message arriving is the end of the sentence, and on
   * leaving a room. The group is a parameter because chooseGroup has already
   * repointed selectedRef by the time it wants to cancel: without it the stop
   * would go to the room being entered, which the user never typed in.
   */
  function stopTyping(groupId?: string | null): void {
    if (typingIdle.current) {
      clearTimeout(typingIdle.current);
      typingIdle.current = null;
    }
    lastTypingStart.current = 0;
    const socket = socketRef.current;
    const target = groupId ?? selectedRef.current;
    if (socket?.connected && target) socket.emit('typing:stop', { groupId: target });
  }

  async function revoke(message: MessageDto): Promise<void> {
    const socket = socketRef.current;
    if (!socket) return;
    setNotice('');
    socket.emit('message:delete', { messageId: message.id }, (response: { ok?: boolean; error?: { code: string } }) => {
      if (response?.error) setNotice(copyFor(response.error.code));
    });
  }

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
      for (const timer of Object.values(typingTimers.current)) clearTimeout(timer);
      typingTimers.current = {};
      if (typingIdle.current) clearTimeout(typingIdle.current);
      clearSession();
    };
  }, []);

  const current = useMemo(() => {
    if (!selected) return null;
    const state = statesRef.current[selected] ?? emptyGroup(0);
    const summary = groupList.find((group) => group.id === selected);
    return { state, summary, messages: orderedMessages(state) };
  }, [selected, groupList, streams]);

  const roster = useMemo(
    () => Object.fromEntries(members.map((member) => [member.userId, member.displayName])),
    [members],
  );
  /**
   * Names rather than ids, resolved through the same roster the bubbles use. Empty
   * string means nobody, so the footer can test it directly.
   */
  const typingNames = useMemo(
    () =>
      Object.keys(typers)
        .map((userId) => roster[userId] ?? `工友 ${userId}`)
        .join('、'),
    [typers, roster],
  );
  const myRole = members.find((member) => member.userId === tokens?.user.id)?.role ?? null;
  const isOwner = myRole === 'owner';
  const canInvite = isOwner || myRole === 'admin';
  /**
   * Archived groups stay readable and refuse every write with 409 (decision 0004),
   * so the panel keeps showing the list and drops the buttons rather than offering
   * a form the server has already decided to reject.
   */
  const archived = current?.summary?.isArchived === true;
  /** An owner cannot walk out of their own group; they have to hand it over first. */
  const canLeave = !archived && myRole !== null && !isOwner;

  /**
   * Spec 3.4's 踢人 row: owner ✓, admin ✓ but never against the owner or a fellow
   * admin, member ✗. The caller's own row is excluded because 退出群 is a different
   * row of the same table with different rules.
   *
   * These predicates only decide which buttons to render. The server re-checks all
   * of it, and its answer is what reaches the user when they disagree.
   */
  function canRemove(member: MemberDto): boolean {
    if (archived || member.role === 'owner' || member.userId === tokens?.user.id) return false;
    if (isOwner) return true;
    return myRole === 'admin' && member.role === 'member';
  }

  /** 改角色 and 转让群主 are both owner-only, and never against oneself or the owner row. */
  function canManage(member: MemberDto): boolean {
    return !archived && isOwner && member.role !== 'owner' && member.userId !== tokens?.user.id;
  }

  if (phase === 'signed-out') {
    return (
      <main className="wrap">
        <h1>工友圈</h1>
        <p className="sub">群聊与群内任务协作</p>
        <form onSubmit={(event) => void submit(event)} className="card">
          <div className="tabs">
            <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>
              登录
            </button>
            <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>
              用邀请码注册
            </button>
          </div>
          <label>
            用户名
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </label>
          {mode === 'register' ? (
            <label>
              邀请码
              <input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="向群主或管理员索取" />
            </label>
          ) : null}
          <button type="submit" disabled={busy}>
            {busy ? '正在处理…' : mode === 'login' ? '进入' : '注册并进入'}
          </button>
          {notice ? <p className="warn" role="status">{notice}</p> : null}
        </form>
      </main>
    );
  }

  return (
    <main className={peopleOpen && current ? 'two wide' : 'two'}>
      <aside className="side">
        <header>
          <strong>{tokens?.user.displayName}</strong>
          <span className={connected ? 'dot on' : 'dot'}>{connected ? '已连接' : '连接中'}</span>
        </header>
        <button type="button" className="link" onClick={() => void refreshGroups()}>
          刷新群列表
        </button>
        <form
          className="newgroup"
          onSubmit={(event) => {
            event.preventDefault();
            void createGroup();
          }}
        >
          <input
            value={newGroupName}
            onChange={(event) => setNewGroupName(event.target.value)}
            placeholder="新群名称"
            aria-label="新群名称"
            maxLength={40}
          />
          <button type="submit" disabled={newGroupName.trim().length === 0}>
            新建群
          </button>
        </form>
        {/*
          There is deliberately no "paste an invite code" box for a signed-in
          user. Spec 3.1 line 209 makes an invite code something registration
          consumes, and no endpoint lets an existing account redeem one - so a
          field here would accept the code, call something, and fail. Joining a
          second group therefore means registering, or being added by an owner or
          admin, which is what 新建群 plus the roster is for.
        */}
        <ul>
          {groupList.map((group) => (
            <li key={group.id}>
              <button type="button" className={selected === group.id ? 'row on' : 'row'} onClick={() => void chooseGroup(group.id)}>
                <span>{group.name}</span>
                {/* unreadCount is the server's bounded number, never recomputed here */}
                {group.unreadCount > 0 ? <em className="badge">{group.unreadCount >= 100 ? '99+' : group.unreadCount}</em> : null}
                {group.isArchived ? <span className="tag">已归档</span> : null}
              </button>
            </li>
          ))}
          {groupList.length === 0 ? <li className="empty">你还没有加入任何群。请群主或管理员给你邀请码。</li> : null}
        </ul>
        {notice ? <p className="warn" role="status">{notice}</p> : null}
      </aside>

      <section className="room">
        {!current ? (
          <p className="empty">左边选一个群开始。</p>
        ) : (
          <>
            <header>
              <h2>{current.summary?.name ?? `群 ${selected}`}</h2>
              <span className="sub">
                {current.summary ? `${current.summary.memberCount} 人` : ''} · 已同步到 seq {current.state.syncedSeq}
              </span>
              <button
                type="button"
                className="link"
                aria-expanded={peopleOpen}
                onClick={() => setPeopleOpen((open) => !open)}
              >
                {/* The summary's count, not members.length: the list is still in
                    flight when this first renders, and a failed fetch would leave
                    the toggle saying 0 next to a sidebar saying 2 人. */}
                {peopleOpen
                  ? '收起成员'
                  : `成员 ${current.summary?.memberCount ?? members.length}`}
              </button>
            </header>
            <ol className="stream" ref={streamRef}>
              {current.messages.map((message) => {
                const mine = message.senderId === tokens?.user.id;
                const standing = !message.deletedAt;
                const dto = receipts[message.id];
                const namesOpen = openReceipt === message.id;
                /**
                 * Own messages only, and only while they stand. Spec 4.4.3 leaves
                 * the display policy to the frontend and warns that a count on
                 * every bubble drowns the room; a count under somebody else's
                 * message only tells you what you already know. totalMembers of 0
                 * means the sender is the whole room, and 0/0 is noise.
                 */
                const showReceipt = mine && standing && dto !== undefined && dto.totalMembers > 0;
                return (
                  <li
                    key={message.id}
                    className={message.deletedAt ? 'msg gone' : 'msg'}
                    // Rows the observer should watch, and only those: a chip nobody
                    // can expand is a count nobody asked for.
                    data-mid={mine && standing ? message.id : undefined}
                  >
                    <span className="who">
                      {mine ? '我' : message.senderId === null ? '系统' : (roster[message.senderId] ?? `工友 ${message.senderId}`)}
                    </span>
                    <span className="body">
                      {message.deletedAt ? '该消息已撤回' : message.body}
                      {message.editedAt && !message.deletedAt ? <em className="tag">已编辑</em> : null}
                      {showReceipt && dto ? (
                        <span className="receipt">
                          <button
                            type="button"
                            className="link quiet"
                            aria-expanded={namesOpen}
                            // 4.4.4: a position retro-credits every older message, so
                            // 已读到 is the honest claim and 已读 would overstate it.
                            title="位点会追认：读到更新的消息即算读到此条"
                            onClick={() => {
                              if (namesOpen) {
                                setOpenReceipt(null);
                                return;
                              }
                              setOpenReceipt(message.id);
                              // The expensive tier, and the only place it is ever
                              // paid for: a click, never a scroll.
                              if (!dto.readers && selected) fetchReceipt(selected, message.id, 1);
                            }}
                          >
                            已读到 {dto.readCount}/{dto.totalMembers}
                          </button>
                          {namesOpen && dto.readers ? (
                            <span className="readers">
                              {dto.readers.length === 0
                                ? '还没有人读到'
                                : dto.readers.map((reader) => reader.displayName).join('、')}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    <span className="when">{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    {mine && standing ? (
                      <button type="button" className="link" onClick={() => void revoke(message)}>
                        撤回
                      </button>
                    ) : null}
                    <span className="seq">#{message.seq}</span>
                  </li>
                );
              })}
              {current.messages.length === 0 ? <li className="empty">还没有消息。</li> : null}
            </ol>
            <form
              className="compose"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  announceTyping();
                }}
                placeholder={current.summary?.isArchived ? '群已归档，只能看' : '说点什么…'}
                disabled={current.summary?.isArchived === true || !connected}
              />
              <button type="submit" disabled={!draft.trim() || !connected || current.summary?.isArchived === true}>
                发送
              </button>
            </form>
            <footer className="sub">
              {typingNames ? <span className="typing">{typingNames} 正在输入…</span> : null}
              共 {current.messages.length} 条 · {stateLabel(current.messages[current.messages.length - 1] ?? { deletedAt: null, editedAt: null })}
            </footer>
          </>
        )}
      </section>

      {peopleOpen && current ? (
        <aside className="people">
          <header>
            <h3>成员 · {members.length}</h3>
            <span className="sub">{myRole ? `你是${roleLabel(myRole)}` : '你不在成员列表里'}</span>
          </header>
          {panelNotice ? (
            <p className="warn" role="status">
              {panelNotice}
            </p>
          ) : null}

          <ul className="members">
            {members.map((member) => {
              const isSelf = member.userId === tokens?.user.id;
              const askedRemove = confirming?.kind === 'remove' && confirming.userId === member.userId;
              const askedTransfer = confirming?.kind === 'transfer' && confirming.userId === member.userId;
              return (
                <li key={member.userId} className="member">
                  <span className="name">
                    {member.displayName}
                    {isSelf ? <em className="tag">我</em> : null}
                    <em className="tag role">{roleLabel(member.role)}</em>
                  </span>
                  <span className="acts">
                    {canManage(member) ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() =>
                          void mutate((groupId) =>
                            api.updateMember(groupId, member.userId, {
                              role: member.role === 'admin' ? 'member' : 'admin',
                            }),
                          )
                        }
                      >
                        {member.role === 'admin' ? '取消管理员' : '设为管理员'}
                      </button>
                    ) : null}
                    {canRemove(member) ? (
                      askedRemove ? (
                        <>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => void mutate((groupId) => api.removeMember(groupId, member.userId))}
                          >
                            确认移出
                          </button>
                          <button type="button" className="link" onClick={() => setConfirming(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          onClick={() => setConfirming({ kind: 'remove', userId: member.userId })}
                        >
                          移出群
                        </button>
                      )
                    ) : null}
                    {canManage(member) ? (
                      askedTransfer ? (
                        <>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() =>
                              void mutate((groupId) => api.updateMember(groupId, member.userId, { transferOwnership: true }))
                            }
                          >
                            确认转让
                          </button>
                          <button type="button" className="link" onClick={() => setConfirming(null)}>
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          onClick={() => setConfirming({ kind: 'transfer', userId: member.userId })}
                        >
                          转让群主
                        </button>
                      )
                    ) : null}
                  </span>
                </li>
              );
            })}
            {members.length === 0 ? <li className="empty">没读到成员列表。</li> : null}
          </ul>

          {canInvite && !archived ? (
            <form
              className="addmember"
              onSubmit={(event) => {
                event.preventDefault();
                void mutate(async (groupId) => {
                  await api.addMember(groupId, { userId: addUserId.trim(), role: addRole });
                  setAddUserId('');
                });
              }}
            >
              <input
                value={addUserId}
                onChange={(event) => setAddUserId(event.target.value)}
                placeholder="用户 ID（暂无通讯录接口）"
                aria-label="要加入的用户 ID"
              />
              <select
                value={addRole}
                onChange={(event) => setAddRole(event.target.value as 'admin' | 'member')}
                aria-label="加入时的角色"
              >
                <option value="member">成员</option>
                <option value="admin">管理员</option>
              </select>
              <button type="submit" disabled={addUserId.trim().length === 0}>
                加人
              </button>
            </form>
          ) : null}

          {canInvite ? (
            <section className="invites">
              <h4>邀请码</h4>
              {mintedCode ? (
                <p className="minted">
                  <code>{mintedCode}</code>
                  <span className="sub">只显示这一次，列表里不再回显</span>
                </p>
              ) : null}
              {!archived ? (
                <form
                  className="mint"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mintInvite();
                  }}
                >
                  <select
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as 'admin' | 'member')}
                    aria-label="邀请码对应的角色"
                  >
                    <option value="member">成员</option>
                    <option value="admin">管理员</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={inviteMaxUses}
                    onChange={(event) => setInviteMaxUses(event.target.value)}
                    aria-label="可用次数，留空为不限"
                    placeholder="次数"
                  />
                  <button type="submit">生成</button>
                </form>
              ) : null}
              <ul>
                {invites.map((invite) => (
                  <li key={invite.id}>
                    <span className="tag role">{roleLabel(invite.role)}</span>
                    <span className="sub">
                      已用 {invite.usedCount}
                      {invite.maxUses === null ? '' : `/${invite.maxUses}`}
                    </span>
                    <span className="sub">
                      {invite.expiresAt ? `${new Date(invite.expiresAt).toLocaleDateString('zh-CN')} 到期` : '长期有效'}
                    </span>
                    {invite.revokedAt ? (
                      <span className="tag">已撤销</span>
                    ) : !archived ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => void mutate((groupId) => api.revokeInvite(groupId, invite.id))}
                      >
                        撤销
                      </button>
                    ) : null}
                  </li>
                ))}
                {invites.length === 0 ? <li className="empty">还没有邀请码。</li> : null}
              </ul>
            </section>
          ) : null}

          {canLeave ? (
            <button type="button" className="link danger leave" onClick={() => void leaveGroup()}>
              退出这个群
            </button>
          ) : null}
          {isOwner && !archived ? <p className="sub">群主不能直接退群，要先把群转让出去。</p> : null}
          {archived ? <p className="sub">群已归档，只能看，改不动。</p> : null}
        </aside>
      ) : null}
    </main>
  );
}

/**
 * Paged catch-up. The loop is driven by hasMore and the watermark by asOfSeq, so
 * a hole in the history can never stall it - see apps/web/tests/sync-store.test.ts.
 */
async function pull(
  socket: Socket,
  groupId: string,
  sinceSeq: number,
  commit: (groupId: string, mutate: (state: GroupState) => void) => void,
): Promise<void> {
  let cursor = sinceSeq;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await new Promise<Awaited<ReturnType<typeof readPage>>>((resolve, reject) => {
      socket.timeout(5000).emit('sync:pull', { groupId, sinceSeq: cursor, limit: 200 }, (error: Error | null, response: unknown) => {
        if (error) reject(error);
        else resolve(readPage(response));
      });
    }).catch(() => null);
    if (!page) return;
    commit(groupId, (state) => applyPage(state, page));
    cursor = page.asOfSeq;
    if (!page.hasMore) return;
  }
}

function readPage(value: unknown) {
  return value as { items: MessageDto[]; asOfSeq: number; hasMore: boolean };
}

type GroupSummary = GroupSummaryDto;
export type { GroupSummary };
