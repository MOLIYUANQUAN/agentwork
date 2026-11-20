// 右边的群聊：群头、消息、输入框。
import { KeyboardEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Agent, ChatDetail, copyText, Face, Msg, User } from './api';
import {
  AgentAvatar, agentStateText, AtIcon, Avatar, AvatarStack, BackIcon, CheckIcon, ClockIcon, clock, CopyIcon, dayKey, dayLabel,
  DownIcon, duration, LockIcon, Markdown, mentionRegex, SendIcon, Spinner, StopIcon, Tag, UserPlusIcon, WarnIcon,
} from './ui';

// ---------------------------------------------------------------- one message

/** 人说的话：原样显示，只把 @名字 和网址标出来。 */
function UserText({ text, names }: { text: string; names: string[] }) {
  const parts = useMemo(() => {
    const mention = mentionRegex(names);
    const url = 'https?://[^\\s<>"\']+';
    const re = new RegExp(mention ? `(${mention.source.slice(1, -1)}|${url})` : `(${url})`, 'g');
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
  const canOpen = steps.length > 1 || !running;
  return (
    <div className={'steps' + (running ? ' running' : '')}>
      <button className="steps-head" onClick={() => canOpen && setOpen(!open)} aria-expanded={open} disabled={!canOpen}>
        {running ? <Spinner size={11} /> : <CheckIcon size={13} />}
        <span className="steps-now">{running ? last : `做了 ${steps.length} 步`}</span>
        {canOpen && <span className={'chev' + (open ? ' open' : '')}><DownIcon size={13} /></span>}
      </button>
      {open && (
        <ol className="steps-list">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={'foot-btn copy' + (done ? ' done' : '')}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      {done ? <CheckIcon size={12} /> : <CopyIcon size={12} />}{done ? '已复制' : '复制'}
    </button>
  );
}

function AgentBody({ m, fake, names, onStop }: { m: Msg; fake: boolean; names: string[]; onStop: (id: number) => void }) {
  const owner = m.author?.owner || m.meta.owner || '主人';
  const steps = m.meta.steps || [];
  const builtin = m.author?.kind === 'builtin';
  const stop = (label: string) => (
    <button className="foot-btn stop" onClick={() => onStop(m.id)}><StopIcon size={12} />{label}</button>
  );

  if (m.status === 'queued') {
    return (
      <>
        <div className="bubble agent queued">
          <ClockIcon size={15} />
          <span>排队中：{owner} 的电脑不在线，上线后自动开始</span>
        </div>
        <div className="msg-foot">{stop('不用做了')}</div>
      </>
    );
  }
  if (m.status === 'error') {
    return (
      <div className="bubble agent error">
        <WarnIcon size={16} />
        <Markdown text={m.text || '出错了'} />
      </div>
    );
  }
  const running = m.status === 'thinking' || m.status === 'streaming';
  if (m.meta.stopped && !m.text) {
    return <div className="bubble agent muted-note">已取消，没有开始做{m.meta.stopped_by ? `（${m.meta.stopped_by} 点的）` : ''}</div>;
  }
  const foot: string[] = [];
  if (m.status === 'done' && !m.meta.declined) {
    if (m.meta.stopped) foot.push(`已停止${m.meta.stopped_by ? `（${m.meta.stopped_by} 点的）` : ''}`);
    else if (!builtin) foot.push(`在 ${owner} 的电脑上完成`);
    if (m.meta.seconds !== undefined && !m.meta.stopped) foot.push(`用时 ${duration(m.meta.seconds)}`);
    if (fake) foot.push('模拟回答');
  }
  return (
    <>
      <div className={'bubble agent' + (running ? ' running' : '')}>
        <Steps steps={steps} running={running} />
        {m.text ? (
          <div className={m.status === 'streaming' ? 'streaming' : undefined}><Markdown text={m.text} names={names} /></div>
        ) : running ? (
          <div className="typing" aria-label="正在想"><i /><i /><i /></div>
        ) : null}
      </div>
      {running && <div className="msg-foot">{stop('停止')}</div>}
      {m.status === 'done' && !m.meta.declined && (
        <div className="msg-foot">
          <span>{foot.join(' · ')}</span>
          {m.text && <CopyAction text={m.text} />}
        </div>
      )}
    </>
  );
}

interface ItemProps {
  m: Msg;
  meId: number;
  names: string[];
  fake: boolean;
  /** 同一个人连着发的第二条起：不再重复头像和名字 */
  compact: boolean;
  day: string | null;
  fresh: boolean;
  onStop: (id: number) => void;
}

const MessageItem = memo(function MessageItem({ m, meId, names, fake, compact, day, fresh, onStop }: ItemProps) {
  const sep = day ? <div className="day-sep"><span>{day}</span></div> : null;
  const enter = fresh ? ' enter' : '';
  if (m.author_type === 'system') {
    return (
      <>
        {sep}
        <div className={'sys-msg' + enter}>{m.text}</div>
      </>
    );
  }
  if (m.author_type === 'agent') {
    const a = m.author || { name: 'agent' };
    const mine = a.owner_id === meId;
    const replyTo = m.meta.via || a.requester;
    return (
      <>
        {sep}
        <div className={'msg agent-msg' + enter} data-status={m.status}>
          <AgentAvatar agent={{ kind: a.kind, color: a.color }} />
          <div className="msg-main">
            <div className="msg-head">
              <span className="msg-name">{a.name}</span>
              {a.kind === 'builtin' ? <Tag kind="builtin">内置</Tag> : mine ? <Tag kind="mine">你的 agent</Tag> : <Tag kind="plain">{a.owner ? `${a.owner} 的 agent` : 'agent'}</Tag>}
              {m.meta.mode === 'guest' && <Tag kind="guest" title="借用别人的 agent：只能看和回答，不能改文件、不能跑命令"><LockIcon size={10} />借用 · 只读</Tag>}
              {replyTo && <span className="msg-for">回复 {replyTo}</span>}
              <time>{clock(m.created)}</time>
            </div>
            <AgentBody m={m} fake={fake} names={names} onStop={onStop} />
          </div>
        </div>
      </>
    );
  }
  const a = m.author || { name: '?', color: undefined };
  const mine = m.author_id === meId;
  return (
    <>
      {sep}
      <div className={'msg user-msg' + (compact ? ' compact' : '') + enter}>
        {compact ? <span className="avatar-gap" /> : <Avatar name={a.name} color={a.color} />}
        <div className="msg-main">
          {!compact && (
            <div className="msg-head">
              <span className="msg-name">{a.name}</span>
              {mine ? <Tag kind="you">你</Tag> : <Tag kind="human">真人</Tag>}
              <time>{clock(m.created)}</time>
            </div>
          )}
          <div className="bubble human"><UserText text={m.text} names={names} /></div>
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
    if (window.matchMedia('(min-width: 761px)').matches) ta.current?.focus();
  }, [draftKey]);

  useEffect(() => {
    if (text) sessionStorage.setItem(draftKey, text);
    else sessionStorage.removeItem(draftKey);
  }, [text, draftKey]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [text]);

  const picks: Pick[] = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const out: Pick[] = [];
    for (const a of detail.agents) {
      const mine = a.owner?.id === me.id;
      const locked = a.share === 'me' && !mine;
      let note: string;
      if (a.kind === 'builtin') note = '内置 · 谁都能用';
      else if (mine) note = `你的 agent · ${agentStateText(a)}`;
      else note = `${a.owner?.name} 的 agent · ${agentStateText(a)} · ${locked ? '只听主人的' : '借用：只读'}`;
      out.push({ key: 'a' + a.id, name: a.name, agent: a, note, muted: locked });
    }
    for (const u of detail.members) {
      if (u.id === me.id) continue;
      out.push({ key: 'u' + u.id, name: u.name, user: u, note: '真人 · 只是提一下，不会自动回' });
    }
    return out.filter((p) => p.name.toLowerCase().includes(q));
  }, [query, detail.agents, detail.members, me.id]);

  useEffect(() => { setSel(0); }, [query]);

  const syncQuery = (value: string, at: number) => {
    const before = value.slice(0, at);
    const m = /(?:^|[\s　，。！？、：；,.!?:;(（])@([^\s@]{0,20})$/.exec(before);
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

  /** 点输入框下面的 @ 按钮：在光标处补一个 @，弹出列表 */
  const startMention = () => {
    const el = ta.current!;
    const at = el.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const needSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needSpace ? ' ' : '') + '@';
    caret.current = (before + insert).length;
    setText(before + insert + text.slice(at));
    setQuery('');
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    // 名字长的先认，免得「@助手2」把「助手」也叫上
    let rest = body;
    const mentions: number[] = [];
    for (const a of [...detail.agents].sort((x, y) => y.name.length - x.name.length)) {
      if (rest.includes('@' + a.name)) {
        mentions.push(a.id);
        rest = rest.split('@' + a.name).join(' ');
      }
    }
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

  const firstUser = picks.findIndex((p) => p.user);

  return (
    <div className="composer">
      <div className="composer-inner">
        {query !== null && picks.length > 0 && (
          <div className="at-pop" role="listbox" aria-label="@ 谁">
            {picks.map((p, i) => (
              <div key={p.key}>
                {i === 0 && p.agent && <div className="at-title">Agent · 被 @ 就开始干活</div>}
                {i === firstUser && <div className="at-title">人</div>}
                <button
                  role="option"
                  aria-selected={i === sel}
                  className={'at-row' + (i === sel ? ' sel' : '') + (p.muted ? ' muted' : '')}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                >
                  {p.agent ? <AgentAvatar agent={p.agent} size={30} dot={p.agent.kind !== 'builtin'} /> : <Avatar name={p.name} color={p.user!.color} size={30} />}
                  <span className="at-text">
                    <span className="at-name">{p.name}</span>
                    <span className="at-note">{p.note}</span>
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-as"><Avatar name={me.name} color={me.color} size={18} />以 <b>{me.name}</b> 的身份发言</div>
        {err && <div className="composer-err" role="alert">{err}</div>}
        <div className="composer-box">
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder="以你自己的身份说点什么，@ 叫 agent 干活"
            onChange={(e) => { setText(e.target.value); syncQuery(e.target.value, e.target.selectionStart); }}
            onKeyDown={onKey}
            onClick={(e) => syncQuery(text, e.currentTarget.selectionStart)}
            // 失焦后收起 @ 列表；但如果这 150 毫秒里又点回了输入框，就别收
            onBlur={() => window.setTimeout(() => { if (document.activeElement !== ta.current) setQuery(null); }, 150)}
          />
          <div className="composer-bar">
            <button className="tool-btn" onMouseDown={(e) => e.preventDefault()} onClick={startMention} title="@ 一个 agent 或人" aria-label="@ 一个 agent 或人">
              <AtIcon size={17} />
            </button>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
            <button className="send" onClick={() => void submit()} disabled={!text.trim() || sending} aria-label="发送" title="发送（Enter）">
              {sending ? <Spinner size={15} /> : <SendIcon size={17} />}
            </button>
          </div>
        </div>
      </div>
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
  onStop: (messageId: number) => void;
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
  const lastSteps = detail?.messages[detail.messages.length - 1]?.meta.steps?.length;
  const count = detail?.messages.length ?? 0;
  const prevLast = useRef<number | undefined>(undefined);
  /** 打开这个群时已经有的最后一条：之后来的才有「进场」动画 */
  const baseline = useRef<{ chat: number | undefined; id: number }>({ chat: undefined, id: 0 });
  if (baseline.current.chat !== chatId) baseline.current = { chat: chatId, id: lastId ?? 0 };

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
  }, [lastId, lastLen, lastSteps, count]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
    [detail?.agents, detail?.members], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const faces: Face[] = useMemo(
    () =>
      detail
        ? [
            ...detail.members.map((u) => ({ kind: 'user' as const, name: u.name, color: u.color })),
            ...detail.agents.map((a) => ({ kind: 'agent' as const, name: a.name, color: a.owner?.color ?? null, agent_kind: a.kind })),
          ]
        : [],
    [detail?.agents, detail?.members], // eslint-disable-line react-hooks/exhaustive-deps
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
  const msgs = detail.messages;

  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn back" onClick={p.onBack} aria-label="返回"><BackIcon /></button>
        <div className="chat-title">
          <h1>{detail.chat.name}</h1>
          <span>{detail.agents.length} 个 agent · {detail.members.length} 人 · 仅限链接加入</span>
        </div>
        <button className="members-btn" onClick={p.onMembers} aria-label="成员" title="成员">
          <AvatarStack faces={faces} max={5} />
        </button>
        <button className="btn" onClick={p.onInvite}><UserPlusIcon size={15} />邀请</button>
      </header>
      {!p.connected && <div className="strip warn"><Spinner size={12} />和服务器断开了，正在重连…</div>}
      {p.fake && <div className="strip">模拟模式：agent 的回答是假的，只用来走通流程。登录 Claude Code 后重启就是真的。</div>}
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner">
          {detail.has_more && (
            <div className="older">
              <button className="btn ghost small" onClick={() => void older()} disabled={loadingOlder}>
                {loadingOlder ? '加载中…' : '看更早的消息'}
              </button>
            </div>
          )}
          {msgs.map((m, i) => {
            const prev = msgs[i - 1];
            const newDay = !prev || dayKey(prev.created) !== dayKey(m.created);
            const compact =
              !newDay && !!prev && m.author_type === 'user' && prev.author_type === 'user' &&
              prev.author_id === m.author_id && m.created - prev.created < 180;
            return (
              <MessageItem
                key={m.id}
                m={m}
                meId={p.me.id}
                names={names}
                fake={p.fake}
                compact={compact}
                day={newDay ? dayLabel(m.created) : null}
                fresh={m.id > baseline.current.id}
                onStop={p.onStop}
              />
            );
          })}
          {onlyHello && (
            <div className="hint-card">
              <b>这个群可以这样用</b>
              <ol>
                <li>直接打字，就是你自己在说话。</li>
                <li>打 <kbd>@</kbd> 选一个 agent，它会带着群里最近的聊天去干活，边想边回。</li>
                <li>点右上角「邀请」把队友拉进来。各自在左下角接入自己的 Claude Code，队友也能 @ 它。</li>
              </ol>
            </div>
          )}
        </div>
      </div>
      {away && (
        <button className={'to-bottom' + (newBelow ? ' has-new' : '')} onClick={toBottom}>
          <DownIcon size={14} />{newBelow ? `${newBelow} 条新消息` : '回到最新'}
        </button>
      )}
      <Composer detail={detail} me={p.me} onSend={async (t, m) => { await p.onSend(t, m); toBottom(); p.onAtBottom(true); }} draftKey={`draft:${detail.chat.id}`} />
    </section>
  );
}
