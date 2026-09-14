import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupSummaryDto, MessageDto } from '@gongyouquan/contracts';
import { io, type Socket } from 'socket.io-client';
import { api, ApiError, clearSession, hasSession, setSession, type Tokens } from './api.js';
import { copyFor, retryAfterSeconds, stateLabel } from './copy.js';
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
  const [busy, setBusy] = useState(false);

  const groups = useState<GroupSummaryDto[]>([]);
  const [groupList, setGroupList] = groups;
  const [selected, setSelected] = useState<string | null>(null);
  const [streams, setStreams] = useState<Record<string, GroupState>>({});
  /**
   * userId -> displayName, per group, from GET /groups/:gid/members. MessageDto
   * deliberately has no sender name, so this is the only honest way to label a
   * bubble; without it the UI falls back to printing the id, which is what it
   * did before and looked like a made-up name.
   */
  const [roster, setRoster] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
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
    setSelected(groupId);
    // Set the mirror synchronously: the useEffect only runs after render, and a
    // message:new landing mid-await would otherwise be judged against the room we
    // just left.
    selectedRef.current = groupId;
    setNotice('');
    const socket = socketRef.current;
    if (!socket) return;
    const local = statesRef.current[groupId] ?? emptyGroup(0);
    // Names come from the roster, not from the message: MessageDto has senderId
    // only. Fetched before the history so the first paint is already labelled.
    try {
      const people = await api.members(groupId);
      setRoster(Object.fromEntries(people.map((person) => [person.userId, person.displayName])));
    } catch (error) {
      if (error instanceof ApiError) setNotice(error.message);
    }
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

  async function send(): Promise<void> {
    const body = draft.trim();
    const socket = socketRef.current;
    if (!body || !selected || !socket || !tokens) return;
    setDraft('');
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
      setSelected(created.id);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '建群失败');
    }
  }

  /**
   * Codes are minted here and shown once, because the list endpoint stops
   * returning them after creation - so a leaked roster read is not a leaked
   * join link, and there is no way to recover one from the UI.
   */
  async function mintInvite(): Promise<void> {
    if (!selected) return;
    try {
      const invite = await api.createInvite(selected, { role: 'member', maxUses: 10 });
      setNotice(`邀请码 ${invite.code}（可用 10 次，只显示这一次）`);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : '生成邀请码失败');
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
      clearSession();
    };
  }, []);

  const current = useMemo(() => {
    if (!selected) return null;
    const state = statesRef.current[selected] ?? emptyGroup(0);
    const summary = groupList.find((group) => group.id === selected);
    return { state, summary, messages: orderedMessages(state) };
  }, [selected, groupList, streams]);

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
    <main className="two">
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
              {/* Only owners and admins can mint one; the server answers 403 otherwise,
                  and the client does not pretend to know the role better than it does. */}
              <button type="button" className="link" onClick={() => void mintInvite()}>
                生成邀请码
              </button>
            </header>
            <ol className="stream">
              {current.messages.map((message) => (
                <li key={message.id} className={message.deletedAt ? 'msg gone' : 'msg'}>
                  <span className="who">
                    {message.senderId === tokens?.user.id
                      ? '我'
                      : message.senderId === null
                        ? '系统'
                        : (roster[message.senderId] ?? `工友 ${message.senderId}`)}
                  </span>
                  <span className="body">
                    {message.deletedAt ? '该消息已撤回' : message.body}
                    {message.editedAt && !message.deletedAt ? <em className="tag">已编辑</em> : null}
                  </span>
                  <span className="when">{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                  {message.senderId === tokens?.user.id && !message.deletedAt ? (
                    <button type="button" className="link" onClick={() => void revoke(message)}>
                      撤回
                    </button>
                  ) : null}
                  <span className="seq">#{message.seq}</span>
                </li>
              ))}
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
                onChange={(event) => setDraft(event.target.value)}
                placeholder={current.summary?.isArchived ? '群已归档，只能看' : '说点什么…'}
                disabled={current.summary?.isArchived === true || !connected}
              />
              <button type="submit" disabled={!draft.trim() || !connected || current.summary?.isArchived === true}>
                发送
              </button>
            </form>
            <footer className="sub">
              共 {current.messages.length} 条 · {stateLabel(current.messages[current.messages.length - 1] ?? { deletedAt: null, editedAt: null })}
            </footer>
          </>
        )}
      </section>
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
