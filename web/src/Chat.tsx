// 右边的群聊：群头、消息、输入框。
import { KeyboardEvent, memo, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, ChatDetail, Msg, User } from './api';
import {
  AgentAvatar, agentStateText, agentTag, Avatar, BackIcon, ClockIcon, DownIcon, duration, LockIcon, longTime,
  Markdown, PeopleIcon, SendIcon, Spinner, WarnIcon,
} from './ui';

// ---------------------------------------------------------------- one message

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 人说的话：原样显示，只把 @名字 和网址标出来。 */
function UserText({ text, names }: { text: string; names: string[] }) {
  const parts = useMemo(() => {
    const alts = names.filter(Boolean).sort((a, b) => b.length - a.length).map((n) => '@' + escapeRe(n));
    alts.push('https?://[^\\s<>"\']+');
    const re = new RegExp(`(${alts.join('|')})`, 'g');
    return text.split(re);
  }, [text, names]);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <span key={i}>{p}</span>;
        if (p.startsWith('@')) return <span key={i} className="mention">{p}</span>;
        return <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a>;
      })}
    </>
  );
}

function Steps({ steps, running }: { steps: string[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const last = steps[steps.length - 1];
  return (
    <div className={'steps' + (running ? ' running' : '')}>
      <button className="steps-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <Spinner size={12} /> : <span className="steps-tick">✓</span>}
        <span className="steps-now">{running ? last : `做了 ${steps.length} 步`}</span>
        {(steps.length > 1 || !running) && <span className={'chev' + (open ? ' open' : '')}><DownIcon size={14} /></span>}
      </button>
      {open && (
        <ol className="steps-list">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

function AgentBody({ m, fake }: { m: Msg; fake: boolean }) {
  const owner = m.author?.owner || m.meta.owner || '主人';
  const steps = m.meta.steps || [];
  const builtin = m.author?.kind === 'builtin';
  if (m.status === 'queued') {
    return (
      <div className="bubble agent queued">
        <ClockIcon size={16} />
        <span>排队中：{owner} 的电脑不在线，上线后自动开始</span>
      </div>
    );
  }
  if (m.status === 'error') {
    return (
      <div className="bubble agent error">
        <WarnIcon size={16} />
        <div><Markdown text={m.text || '出错了'} /></div>
      </div>
    );
  }
  const running = m.status === 'thinking' || m.status === 'streaming';
  let foot: ReactNode = null;
  if (m.status === 'done' && !m.meta.declined) {
    const took = m.meta.seconds !== undefined ? `用时 ${duration(m.meta.seconds)}` : '';
    const where = builtin ? '' : `在 ${owner} 的电脑上完成`;
    foot = (
      <div className="msg-foot">
        {[where, took, fake ? '模拟回答' : ''].filter(Boolean).join(' · ')}
      </div>
    );
  }
  return (
    <>
      <div className={'bubble agent' + (running ? ' running' : '')}>
        <Steps steps={steps} running={running} />
        {m.text ? (
          <div className={m.status === 'streaming' ? 'streaming' : undefined}><Markdown text={m.text} /></div>
        ) : running ? (
          <div className="thinking">正在想<i>.</i><i>.</i><i>.</i></div>
        ) : null}
      </div>
      {foot}
    </>
  );
}

const MessageItem = memo(function MessageItem({ m, mine, names, fake, showTime }: { m: Msg; mine: boolean; names: string[]; fake: boolean; showTime: boolean }) {
  const time = showTime ? <div className="time-sep">{longTime(m.created)}</div> : null;
  if (m.author_type === 'system') {
    return (
      <>
        {time}
        <div className="sys-msg">{m.text}</div>
      </>
    );
  }
  if (m.author_type === 'agent') {
    const a = m.author || { name: 'agent' };
    return (
      <>
        {time}
        <div className="msg agent-msg" data-status={m.status}>
          <AgentAvatar agent={{ name: a.name, kind: a.kind, owner: a.color ? { color: a.color } : undefined }} />
          <div className="msg-main">
            <div className="msg-head">
              <span className="msg-name">{a.name}</span>
              <span className={'tag' + (a.kind === 'builtin' ? ' builtin' : '')}>{agentTag(a)}</span>
              {m.meta.mode === 'guest' && <span className="tag guest" title="借用别人的 agent：只能看和回答，不能改文件、不能跑命令"><LockIcon size={11} />借用 · 只读</span>}
              {a.requester && <span className="msg-for">回复 {a.requester}</span>}
            </div>
            <AgentBody m={m} fake={fake} />
          </div>
        </div>
      </>
    );
  }
  const a = m.author || { name: '?', color: '#868e96' };
  return (
    <>
      {time}
      <div className={'msg user-msg' + (mine ? ' mine' : '')}>
        <Avatar name={a.name} color={a.color || '#868e96'} />
        <div className="msg-main">
          {!mine && <div className="msg-head"><span className="msg-name">{a.name}</span></div>}
          <div className="bubble user"><UserText text={m.text} names={names} /></div>
        </div>
      </div>
    </>
  );
});

// ---------------------------------------------------------------- composer with @ popup

interface Pick {
  key: string;
  name: string;
  agent?: Agent;
  user?: User;
  note: string;
  muted?: boolean;
}

function Composer({ detail, me, onSend, draftKey }: { detail: ChatDetail; me: User; onSend: (text: string, mentions: number[]) => Promise<void>; draftKey: string }) {
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) || '');
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);

  // 选完 @ 之后把光标放到名字后面（同步做，手快接着打字也不会乱序）
  useLayoutEffect(() => {
    if (caret.current !== null && ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  useEffect(() => {
    setText(sessionStorage.getItem(draftKey) || '');
    setQuery(null);
    setErr('');
    ta.current?.focus();
  }, [draftKey]);

  useEffect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
  }, [text, draftKey]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [text]);

  const picks: Pick[] = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const out: Pick[] = [];
    for (const a of detail.agents) {
      const locked = a.share === 'me' && a.owner?.id !== me.id;
      const bits = [a.kind === 'builtin' ? '内置，谁都能用' : `${a.owner?.name} 的 agent`];
      if (a.kind !== 'builtin') bits.push(agentStateText(a));
      if (a.kind !== 'builtin' && a.share === 'me') bits.push('只听主人的');
      else if (a.kind !== 'builtin' && a.owner?.id !== me.id) bits.push('借用：只读');
      out.push({ key: 'a' + a.id, name: a.name, agent: a, note: bits.join(' · '), muted: locked });
    }
    for (const u of detail.members) {
      if (u.id === me.id) continue;
      out.push({ key: 'u' + u.id, name: u.name, user: u, note: '群成员' });
    }
    return out.filter((p) => p.name.toLowerCase().includes(q));
  }, [query, detail.agents, detail.members, me.id]);

  useEffect(() => { setSel(0); }, [query]);

  const syncQuery = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(?:^|[\s　，。！？、：；,.!?:;(（])@([^\s@]{0,20})$/.exec(before) || /^@([^\s@]{0,20})$/.exec(before);
    setQuery(m ? m[1] : null);
  };

  const choose = (p: Pick) => {
    const el = ta.current!;
    const at = el.selectionStart;
    const before = text.slice(0, at).replace(/@[^\s@]*$/, '');
    const insert = '@' + p.name + ' ';
    caret.current = (before + insert).length;
    setText(before + insert + text.slice(at));
    setQuery(null);
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    const mentions = detail.agents.filter((a) => body.includes('@' + a.name)).map((a) => a.id);
    setSending(true);
    setErr('');
    try {
      await onSend(body, mentions);
      setText('');
      setQuery(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法选字时的回车不算发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (query !== null && picks.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % picks.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + picks.length) % picks.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(picks[Math.min(sel, picks.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setQuery(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      {query !== null && picks.length > 0 && (
        <div className="at-pop" role="listbox">
          <div className="at-title">@ 谁？agent 被 @ 就会开始干活</div>
          {picks.map((p, i) => (
            <button
              key={p.key}
              role="option"
              aria-selected={i === sel}
              className={'at-row' + (i === sel ? ' sel' : '') + (p.muted ? ' muted' : '')}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(p); }}
            >
              {p.agent ? <AgentAvatar agent={p.agent} size={28} dot={p.agent.kind !== 'builtin'} /> : <Avatar name={p.name} color={p.user!.color} size={28} />}
              <span className="at-name">{p.name}</span>
              <span className="at-note">{p.note}</span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="composer-err">{err}</div>}
      <div className="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder="以你自己的身份说点什么，@ 叫 agent 干活"
          onChange={(e) => { setText(e.target.value); syncQuery(e.target.value, e.target.selectionStart); }}
          onKeyDown={onKey}
          onClick={(e) => syncQuery(text, e.currentTarget.selectionStart)}
          onBlur={() => window.setTimeout(() => setQuery(null), 150)}
        />
        <button className="send" onClick={() => void submit()} disabled={!text.trim() || sending} aria-label="发送" title="发送（Enter）">
          {sending ? <Spinner size={16} /> : <SendIcon size={18} />}
        </button>
      </div>
      <div className="composer-hint">Enter 发送 · Shift+Enter 换行 · 打 @ 选 agent</div>
    </div>
  );
}

// ---------------------------------------------------------------- the pane

export interface ChatPaneProps {
  detail: ChatDetail | undefined;
  loadError: string;
  me: User;
  fake: boolean;
  connected: boolean;
  onSend: (text: string, mentions: number[]) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onInvite: () => void;
  onMembers: () => void;
  onBack: () => void;
  onAtBottom: (at: boolean) => void;
  onRetry: () => void;
}

export function ChatPane(p: ChatPaneProps) {
  const { detail } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const keep = useRef<{ height: number; top: number } | null>(null);
  const chatId = detail?.chat.id;
  const lastId = detail?.messages[detail.messages.length - 1]?.id;
  const lastLen = detail?.messages[detail.messages.length - 1]?.text.length;
  const count = detail?.messages.length ?? 0;
  const prevLast = useRef<number | undefined>(undefined);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAway(false);
    setNewBelow(0);
  }, []);

  // 换群：直接到底
  useLayoutEffect(() => {
    stick.current = true;
    prevLast.current = undefined;
    setNewBelow(0);
    setAway(false);
    toBottom();
    p.onAtBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  // 新内容：在底部就跟着走；不在底部就提示「有新消息」
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current) {
      el.scrollTop = el.scrollHeight - keep.current.height + keep.current.top;
      keep.current = null;
      return;
    }
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (lastId !== undefined && prevLast.current !== undefined && lastId > prevLast.current) {
      setNewBelow((n) => n + 1);
    }
    prevLast.current = lastId;
  }, [lastId, lastLen, count]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (at !== stick.current) {
      stick.current = at;
      setAway(!at);
      p.onAtBottom(at);
      if (at) setNewBelow(0);
    }
  };

  const older = async () => {
    const el = scroller.current;
    if (!el || loadingOlder) return;
    setLoadingOlder(true);
    keep.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      await p.onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  const names = useMemo(
    () => (detail ? [...detail.agents.map((a) => a.name), ...detail.members.map((u) => u.name)] : []),
    [detail],
  );

  if (!detail) {
    return (
      <section className="chat">
        <header className="chat-head">
          <button className="icon-btn back" onClick={p.onBack} aria-label="返回"><BackIcon /></button>
        </header>
        <div className="chat-empty">
          {p.loadError ? (
            <>
              <p>{p.loadError}</p>
              <button className="btn" onClick={p.onRetry}>再试一次</button>
            </>
          ) : (
            <Spinner size={22} />
          )}
        </div>
      </section>
    );
  }

  const onlyHello = detail.messages.every((m) => m.author_type === 'system');

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn back" onClick={p.onBack} aria-label="返回"><BackIcon /></button>
        <div className="chat-title">
          <h1>{detail.chat.name}</h1>
          <span>{detail.agents.length} 个 agent · {detail.members.length} 人</span>
        </div>
        <button className="btn ghost" onClick={p.onInvite}>邀请</button>
        <button className="btn ghost" onClick={p.onMembers}><PeopleIcon size={16} />成员</button>
      </header>
      {!p.connected && <div className="strip warn"><Spinner size={12} />和服务器断开了，正在重连…</div>}
      {p.fake && <div className="strip">模拟模式：agent 的回答是假的，用来走通流程。登录 Claude Code 后重启就是真的。</div>}
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {detail.has_more && (
          <div className="older">
            <button className="btn ghost small" onClick={() => void older()} disabled={loadingOlder}>
              {loadingOlder ? '加载中…' : '看更早的消息'}
            </button>
          </div>
        )}
        {detail.messages.map((m, i) => {
          const prev = detail.messages[i - 1];
          return (
            <MessageItem
              key={m.id}
              m={m}
              mine={m.author_type === 'user' && m.author_id === p.me.id}
              names={names}
              fake={p.fake}
              showTime={!prev || m.created - prev.created > 300}
            />
          );
        })}
        {onlyHello && (
          <div className="hint-card">
            <b>这个群里可以这样用</b>
            <ul>
              <li>直接打字，就是你自己在说话。</li>
              <li>打 <kbd>@</kbd> 选一个 agent，它会带着群里最近的聊天去干活，边想边回。</li>
              <li>点右上角「邀请」把队友拉进来；点左边「＋」接入你自己的 Claude Code，再在「成员」里把它拉进群。</li>
            </ul>
          </div>
        )}
      </div>
      {away && (
        <button className={'to-bottom' + (newBelow ? ' has-new' : '')} onClick={toBottom}>
          <DownIcon size={15} />{newBelow ? `${newBelow} 条新消息` : '回到最新'}
        </button>
      )}
      <Composer detail={detail} me={p.me} onSend={async (t, m) => { await p.onSend(t, m); toBottom(); p.onAtBottom(true); }} draftKey={`draft:${detail.chat.id}`} />
    </section>
  );
}
