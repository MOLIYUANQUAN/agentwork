// 整体框架：登录 → 左边窄栏 + 群列表 + 群聊。
import { FormEvent, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Agent, api, ApiError, Bootstrap, ChatDetail, ChatSummary, Contact, Live, Msg, ServerEvent, User } from './api';
import { ChatPane } from './Chat';
import { AgentModal, ConnectModal, InviteModal, MembersDrawer, NewChatModal } from './Panels';
import { initial, reducer } from './store';
import { AgentAvatar, agentStateText, Avatar, ChatIcon, GroupAvatar, LogoutIcon, PeopleIcon, PlusIcon, shortTime, Spinner } from './ui';

const inviteCode = () => /^\/invite\/([^/]+)/.exec(location.pathname)?.[1] ?? null;

// ---------------------------------------------------------------- root: am I logged in?

export default function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [state, setState] = useState<'loading' | 'login' | 'ready' | 'down'>('loading');
  const [invite, setInvite] = useState<string | null>(inviteCode);
  const [openChat, setOpenChat] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setBoot(await api<Bootstrap>('GET', '/api/bootstrap'));
      setState('ready');
    } catch (e) {
      setState((e as ApiError).status === 401 ? 'login' : 'down');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (state === 'loading') return <div className="center-page"><Spinner size={26} /></div>;
  if (state === 'down') {
    return (
      <div className="center-page">
        <div className="card">
          <h1>连不上服务器</h1>
          <p className="muted">确认 agentwork 的服务窗口还开着（双击 start.cmd 启动的那个）。</p>
          <button className="btn primary" onClick={() => { setState('loading'); void load(); }}>再试一次</button>
        </div>
      </div>
    );
  }
  if (state === 'login' || !boot) return <Login invited={!!invite} onDone={() => { setState('loading'); void load(); }} />;
  if (invite) {
    return (
      <InvitePage
        code={invite}
        me={boot.me}
        onDone={(chatId) => {
          history.replaceState(null, '', '/');
          setInvite(null);
          setOpenChat(chatId);
          void load();
        }}
      />
    );
  }
  return <Main boot={boot} openChat={openChat} onLogout={() => { setBoot(null); setState('login'); }} />;
}

// ---------------------------------------------------------------- login / register

function Login({ onDone, invited }: { onDone: () => void; invited: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>(invited ? 'register' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      if (mode === 'login') await api('POST', '/api/login', { email, password });
      else await api('POST', '/api/register', { name, email, password });
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="center-page login-page">
      <form className="card login" onSubmit={submit}>
        <div className="brand">
          <img src="/favicon.svg" alt="" width={44} height={44} />
          <div>
            <h1>agentwork</h1>
            <p>人和每个人的 agent，在一个群里干活</p>
          </div>
        </div>
        {invited && <p className="notice">有人邀请你进群。先{mode === 'login' ? '登录' : '注册'}，马上就进。</p>}
        <div className="seg wide">
          <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(''); }}>登录</button>
          <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr(''); }}>注册</button>
        </div>
        {mode === 'register' && (
          <label className="field">
            <span>名字（群里别人看到的）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="nickname" required autoFocus />
          </label>
        )}
        <label className="field">
          <span>邮箱</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus={mode === 'login'} />
        </label>
        <label className="field">
          <span>密码{mode === 'register' ? '（至少 6 位）' : ''}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'register' ? 6 : undefined} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
        </label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn primary big" disabled={busy}>{busy ? '稍等…' : mode === 'login' ? '登录' : '注册并进入'}</button>
        <p className="muted small center">{mode === 'login' ? '还没有账号？点上面的「注册」。' : '只在这台服务器上用，不发验证邮件。'}</p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- /invite/<code>

function InvitePage({ code, me, onDone }: { code: string; me: User; onDone: (chatId: number | null) => void }) {
  const [info, setInfo] = useState<{ chat: ChatSummary; creator: string; member: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ chat: ChatSummary; creator: string; member: boolean }>('GET', `/api/invite/${encodeURIComponent(code)}`)
      .then(setInfo)
      .catch((e) => setErr(e.message));
  }, [code]);

  const join = async () => {
    setBusy(true);
    try {
      const r = await api<{ chat_id: number }>('POST', `/api/invite/${encodeURIComponent(code)}`);
      onDone(r.chat_id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <div className="card invite">
        {err ? (
          <>
            <h1>进不去</h1>
            <p className="muted">{err}。让对方重新发一个邀请链接。</p>
            <button className="btn" onClick={() => onDone(null)}>回到我的聊天</button>
          </>
        ) : !info ? (
          <Spinner size={22} />
        ) : (
          <>
            <GroupAvatar id={info.chat.id} name={info.chat.name} size={64} />
            <h1>{info.chat.name}</h1>
            <p className="muted">{info.creator} 建的群 · {info.chat.members} 人 · {info.chat.agents} 个 agent</p>
            {info.member ? (
              <button className="btn primary big" onClick={() => onDone(info.chat.id)}>你已经在群里了，进去</button>
            ) : (
              <button className="btn primary big" disabled={busy} onClick={() => void join()}>{busy ? '正在加入…' : `以「${me.name}」的身份加入`}</button>
            )}
            <button className="link" onClick={() => onDone(null)}>先不加入</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the app itself

type ModalState =
  | { kind: 'new-chat' }
  | { kind: 'invite' }
  | { kind: 'connect' }
  | { kind: 'agent'; id: number }
  | null;

function Main({ boot, openChat, onLogout }: { boot: Bootstrap; openChat: number | null; onLogout: () => void }) {
  const [s, dispatch] = useReducer(reducer, boot, initial);
  const [connected, setConnected] = useState(true);
  const [tab, setTab] = useState<'chats' | 'contacts'>('chats');
  const [modal, setModal] = useState<ModalState>(null);
  const [drawer, setDrawer] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
  const sRef = useRef(s);
  sRef.current = s;

  const refreshBoot = useCallback(async () => {
    try {
      dispatch({ type: 'boot', boot: await api<Bootstrap>('GET', '/api/bootstrap') });
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
    }
  }, [onLogout]);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const detail = await api<ChatDetail>('GET', `/api/chats/${id}`);
      dispatch({ type: 'detail', detail });
      setLoadError('');
    } catch (e) {
      if ((e as ApiError).status === 404) dispatch({ type: 'gone', chatId: id });
      else if (sRef.current.activeId === id && !sRef.current.details[id]) setLoadError((e as Error).message);
    }
  }, []);

  const open = useCallback((id: number | null) => {
    dispatch({ type: 'open', id });
    setDrawer(false);
    setLoadError('');
    if (id !== null) {
      localStorage.setItem('agentwork:last-chat', String(id));
      void loadDetail(id); // 每次点开都拿最新的；已有的先显示着
    }
  }, [loadDetail]);

  // 进来先打开上次的群（手机上不自动打开，先看列表）
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 721px)').matches;
    const last = Number(localStorage.getItem('agentwork:last-chat'));
    const pick = openChat ?? (wide ? (boot.chats.find((c) => c.id === last) ?? boot.chats[0])?.id ?? null : null);
    if (pick !== null && pick !== undefined) open(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 实时连接
  useEffect(() => {
    const onEvent = (e: ServerEvent) => {
      if (e.type === 'chat_changed') {
        void refreshBoot();
        if (sRef.current.details[e.chat_id] || sRef.current.activeId === e.chat_id) void loadDetail(e.chat_id);
        return;
      }
      if (e.type === 'my_agents_changed') {
        void refreshBoot();
        return;
      }
      if (e.type === 'message' && !sRef.current.chats.some((c) => c.id === e.message.chat_id)) void refreshBoot();
      dispatch({ type: 'event', event: e });
    };
    const live = new Live(onEvent, (ok, again) => {
      setConnected(ok);
      if (ok && again) {
        void refreshBoot();
        for (const id of Object.keys(sRef.current.details)) void loadDetail(Number(id));
      }
    });
    return () => live.close();
  }, [refreshBoot, loadDetail]);

  // 窗口在不在前台
  useEffect(() => {
    const upd = () => setVisible(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', upd);
    window.addEventListener('blur', upd);
    document.addEventListener('visibilitychange', upd);
    return () => {
      window.removeEventListener('focus', upd);
      window.removeEventListener('blur', upd);
      document.removeEventListener('visibilitychange', upd);
    };
  }, []);

  const active = s.activeId !== null ? s.details[s.activeId] : undefined;
  const activeSummary = s.chats.find((c) => c.id === s.activeId);
  const watching = visible && atBottom && !!active;
  useEffect(() => { dispatch({ type: 'watching', on: watching }); }, [watching]);

  // 看到了就标记已读
  const lastReadable = active ? [...active.messages].reverse().find((m) => m.status === 'done' || m.status === 'error')?.id : undefined;
  const sentRead = useRef<Record<number, number>>({});
  useEffect(() => {
    if (!watching || !active || lastReadable === undefined) return;
    const cid = active.chat.id;
    if ((sentRead.current[cid] ?? 0) >= lastReadable && !activeSummary?.unread) return;
    sentRead.current[cid] = lastReadable;
    dispatch({ type: 'read', chatId: cid });
    api('POST', `/api/chats/${cid}/read`, { last_id: lastReadable }).catch(() => undefined);
  }, [watching, active, lastReadable, activeSummary?.unread]);

  // 标签页标题上的未读数
  const totalUnread = s.chats.reduce((n, c) => n + c.unread, 0);
  useEffect(() => { document.title = totalUnread ? `(${totalUnread}) agentwork` : 'agentwork'; }, [totalUnread]);

  const send = useCallback(async (text: string, mentions: number[]) => {
    const id = sRef.current.activeId;
    if (id === null) return;
    const message = await api<Msg>('POST', `/api/chats/${id}/messages`, { text, mentions });
    dispatch({ type: 'sent', message });
  }, []);

  const loadOlder = useCallback(async () => {
    const id = sRef.current.activeId;
    const d = id !== null ? sRef.current.details[id] : undefined;
    if (!d || !d.messages.length) return;
    const older = await api<ChatDetail>('GET', `/api/chats/${d.chat.id}?before=${d.messages[0].id}`);
    dispatch({ type: 'older', chatId: d.chat.id, messages: older.messages, hasMore: older.has_more });
  }, []);

  const refreshAll = useCallback(async () => {
    await refreshBoot();
    const id = sRef.current.activeId;
    if (id !== null) await loadDetail(id);
  }, [refreshBoot, loadDetail]);

  const logout = async () => {
    await api('POST', '/api/logout').catch(() => undefined);
    onLogout();
  };

  const onConnected = useCallback(async (a: Agent, addTo: number | null) => {
    if (addTo !== null) await api('POST', `/api/chats/${addTo}/agents`, { agent_id: a.id }).catch(() => undefined);
    await refreshAll();
  }, [refreshAll]);

  const modalAgent = modal?.kind === 'agent' ? s.myAgents.find((a) => a.id === modal.id) : undefined;

  return (
    <div className={'app' + (s.activeId !== null ? ' has-chat' : '')}>
      <nav className="rail" aria-label="我和我的 agent">
        <div className="rail-me" title={s.me.name}><Avatar name={s.me.name} color={s.me.color} size={38} /></div>
        <div className="rail-agents">
          {s.myAgents.map((a) => (
            <button key={a.id} className="rail-agent" onClick={() => setModal({ kind: 'agent', id: a.id })} title={`${a.name} · ${agentStateText(a)}`} aria-label={`${a.name}，${agentStateText(a)}`}>
              <AgentAvatar agent={a} size={36} dot />
            </button>
          ))}
          <button className="rail-add" onClick={() => setModal({ kind: 'connect' })} title="接入 agent" aria-label="接入 agent">
            <PlusIcon size={18} />
            <span>接入<br />agent</span>
          </button>
        </div>
        <button className="rail-btn" onClick={() => void logout()} title="退出登录" aria-label="退出登录"><LogoutIcon size={19} /></button>
      </nav>

      <aside className="side">
        <div className="side-top">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'chats'} className={tab === 'chats' ? 'on' : ''} onClick={() => setTab('chats')}><ChatIcon size={16} />聊天{totalUnread > 0 && <i className="badge">{totalUnread > 99 ? '99+' : totalUnread}</i>}</button>
            <button role="tab" aria-selected={tab === 'contacts'} className={tab === 'contacts' ? 'on' : ''} onClick={() => setTab('contacts')}><PeopleIcon size={16} />通讯录</button>
          </div>
          <button className="btn primary small new-chat" onClick={() => setModal({ kind: 'new-chat' })}><PlusIcon size={14} />建群</button>
        </div>
        {tab === 'chats' ? (
          <div className="list">
            {s.chats.length === 0 && (
              <div className="empty">
                <p>还没有群。</p>
                <p className="muted">建一个群，或者打开别人发你的邀请链接。</p>
                <button className="btn primary" onClick={() => setModal({ kind: 'new-chat' })}>＋ 建群</button>
              </div>
            )}
            {s.chats.map((c) => (
              <button key={c.id} className={'chat-row' + (c.id === s.activeId ? ' on' : '')} onClick={() => open(c.id)}>
                <GroupAvatar id={c.id} name={c.name} size={42} />
                <span className="chat-row-main">
                  <span className="chat-row-top"><b>{c.name}</b><time>{shortTime(c.last?.at ?? c.created)}</time></span>
                  <span className="chat-row-bottom">
                    <span className="preview">{c.last ? `${c.last.who ? c.last.who + '：' : ''}${c.last.text}` : '还没有消息'}</span>
                    {c.unread > 0 && <i className="badge">{c.unread > 99 ? '99+' : c.unread}</i>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Contacts me={s.me} myAgents={s.myAgents} onOpen={(id) => { setTab('chats'); open(id); }} onAgent={(id) => setModal({ kind: 'agent', id })} onConnect={() => setModal({ kind: 'connect' })} stamp={s.chats.length} />
        )}
        <div className="side-me">
          <Avatar name={s.me.name} color={s.me.color} size={26} />
          <span>{s.me.name}</span>
          <button className="link" onClick={() => setModal({ kind: 'connect' })}>＋ 接入 agent</button>
          <button className="link" onClick={() => void logout()}>退出</button>
        </div>
      </aside>

      {s.activeId === null ? (
        <section className="chat placeholder">
          <div className="chat-empty">
            <img src="/favicon.svg" alt="" width={56} height={56} />
            <p>{s.chats.length ? '从左边选一个群' : '先建一个群，把队友和 agent 拉进来'}</p>
            {s.engine === 'fake' && <p className="muted small">现在是模拟模式：agent 的回答是假的，用来走通流程。</p>}
          </div>
        </section>
      ) : (
        <ChatPane
          detail={active}
          loadError={loadError}
          me={s.me}
          fake={s.engine === 'fake'}
          connected={connected}
          onSend={send}
          onLoadOlder={loadOlder}
          onInvite={() => setModal({ kind: 'invite' })}
          onMembers={() => setDrawer(true)}
          onBack={() => open(null)}
          onAtBottom={setAtBottom}
          onRetry={() => s.activeId !== null && void loadDetail(s.activeId)}
        />
      )}

      {drawer && active && (
        <MembersDrawer
          detail={active}
          me={s.me}
          myAgents={s.myAgents}
          onClose={() => setDrawer(false)}
          onChanged={refreshAll}
          onLeft={() => { setDrawer(false); dispatch({ type: 'gone', chatId: active.chat.id }); }}
          onConnect={() => { setDrawer(false); setModal({ kind: 'connect' }); }}
        />
      )}
      {modal?.kind === 'new-chat' && <NewChatModal onClose={() => setModal(null)} onCreated={(c) => { setModal(null); void refreshBoot().then(() => open(c.id)); }} />}
      {modal?.kind === 'invite' && active && <InviteModal detail={active} onClose={() => setModal(null)} />}
      {modal?.kind === 'connect' && <ConnectModal me={s.me} activeChat={active} onClose={() => { setModal(null); void refreshAll(); }} onConnected={onConnected} />}
      {modal?.kind === 'agent' && modalAgent && <AgentModal agent={modalAgent} activeChat={active} onClose={() => setModal(null)} onChanged={refreshAll} />}
    </div>
  );
}

// ---------------------------------------------------------------- contacts tab

function Contacts({ me, myAgents, onOpen, onAgent, onConnect, stamp }: { me: User; myAgents: Agent[]; onOpen: (chatId: number) => void; onAgent: (id: number) => void; onConnect: () => void; stamp: number }) {
  const [people, setPeople] = useState<Contact[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ people: Contact[] }>('GET', '/api/contacts').then((r) => setPeople(r.people)).catch((e) => setErr(e.message));
  }, [stamp]);
  return (
    <div className="list contacts">
      <h3>我</h3>
      <div className="contact">
        <Avatar name={me.name} color={me.color} size={38} />
        <div className="contact-main">
          <b>{me.name}</b>
          {myAgents.map((a) => (
            <button key={a.id} className="contact-agent" onClick={() => onAgent(a.id)}>
              <AgentAvatar agent={a} size={20} dot />{a.name}<span className="muted">{a.share === 'me' ? '只有我能 @' : '谁都能 @'}</span>
            </button>
          ))}
          {myAgents.length === 0 && <button className="link" onClick={onConnect}>＋ 接入我的 Claude Code</button>}
        </div>
      </div>
      <h3>同群的人</h3>
      {err && <p className="err pad">{err}</p>}
      {!people && !err && <div className="empty"><Spinner /></div>}
      {people && people.length === 0 && <div className="empty"><p className="muted">和你同群的人会出现在这里。建个群，发邀请链接给队友。</p></div>}
      {people?.map((p) => (
        <div className="contact" key={p.id}>
          <Avatar name={p.name} color={p.color} size={38} />
          <div className="contact-main">
            <b>{p.name}</b>
            {p.agents.map((a) => (
              <div key={a.id} className="contact-agent static">
                <AgentAvatar agent={a} size={20} dot />{a.name}<span className="muted">{a.share === 'me' ? '只听主人的' : '可借用'}</span>
              </div>
            ))}
            {p.agents.length === 0 && <span className="muted small">还没有自己的 agent</span>}
            <div className="contact-chats">
              {p.chats.map((c) => <button key={c.id} className="chip" onClick={() => onOpen(c.id)}>{c.name}</button>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
