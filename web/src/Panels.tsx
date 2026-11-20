// 弹窗和成员抽屉。
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Agent, api, ChatDetail, ChatSummary, copyText, User } from './api';
import { AgentAvatar, agentStateText, Avatar, CheckIcon, CloseIcon, LinkIcon, Modal, Spinner, Tag } from './ui';

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

function CopyButton({ text, label = '复制', autoFocus = false }: { text: string; label?: string; autoFocus?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      data-autofocus={autoFocus ? '' : undefined}
      className={'btn' + (done ? ' ok' : ' primary')}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1800);
        }
      }}
    >
      {done ? <><CheckIcon size={15} />已复制</> : label}
    </button>
  );
}

// ---------------------------------------------------------------- 建群

export function NewChatModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ChatSummary) => void }) {
  const [name, setName] = useState('');
  const { busy, err, run } = useAsync();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onCreated(await api<ChatSummary>('POST', '/api/chats', { name })));
  };
  return (
    <Modal title="建群" onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>群名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="比如：毕设小组" />
        </label>
        <p className="help">建好后群里自带一个「助手」。再用邀请链接把队友拉进来，各自把自己的 agent 拉进群。</p>
        {err && <p className="err">{err}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? '正在建…' : '建群'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- 邀请

export function InviteModal({ detail, me, onClose, onChanged }: { detail: ChatDetail; me: User; onClose: () => void; onChanged: () => Promise<void> }) {
  const link = `${location.origin}/invite/${detail.chat.invite_code}`;
  const { busy, err, run } = useAsync();
  const [confirmReset, setConfirmReset] = useState(false);
  return (
    <Modal title={`邀请加入「${detail.chat.name}」`} onClose={onClose} width={520}>
      <p className="help">把这个链接发给队友。对方打开，登录或注册后点一下就进群。只有拿到链接的人能进来。</p>
      <div className="copy-row">
        <LinkIcon size={16} />
        <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="邀请链接" />
        <CopyButton text={link} label="复制链接" autoFocus />
      </div>
      {/^(localhost|127\.)/.test(location.hostname) && (
        <p className="help muted">现在是在本机（localhost）跑的，这个链接只有这台电脑能打开。要给别人用，得把服务放到大家都能访问的地址上（见 docs/部署.md）。</p>
      )}
      {detail.chat.created_by === me.id && (
        <div className="reset-row">
          {confirmReset ? (
            <>
              <span className="muted small">重置后，旧链接马上失效；已经在群里的人不受影响。</span>
              <button className="btn small" onClick={() => setConfirmReset(false)}>算了</button>
              <button className="btn small danger" disabled={busy} onClick={() => void run(async () => { await api('POST', `/api/chats/${detail.chat.id}/invite/reset`); await onChanged(); setConfirmReset(false); })}>确定重置</button>
            </>
          ) : (
            <button className="link" onClick={() => setConfirmReset(true)}>链接发错人了？重置链接</button>
          )}
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- 接入 agent

interface PairOut { code: string; name: string; command: string; expires_in: number }
interface PairStatus { status: 'waiting' | 'claimed' | 'connected' | 'expired'; agent?: Agent }

export function ConnectModal({ me, activeChat, onClose, onConnected }: { me: User; activeChat: ChatDetail | undefined; onClose: () => void; onConnected: (a: Agent, addTo: number | null) => Promise<void> }) {
  const [name, setName] = useState(`${me.name} 的 Claude`);
  const [pair, setPair] = useState<PairOut | null>(null);
  const [status, setStatus] = useState<PairStatus>({ status: 'waiting' });
  const [addToChat, setAddToChat] = useState(true);
  const [added, setAdded] = useState(false);
  const { busy, err, run } = useAsync();
  const finished = useRef(false);

  useEffect(() => {
    if (!pair) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await api<PairStatus>('GET', `/api/agents/pair/${pair.code}`);
        if (stop) return;
        setStatus(s);
        if (s.status === 'connected' || s.status === 'expired') return;
      } catch {
        /* 下一轮再试 */
      }
      window.setTimeout(tick, 1500);
    };
    void tick();
    return () => { stop = true; };
  }, [pair]);

  useEffect(() => {
    if (status.status === 'connected' && status.agent && !finished.current) {
      finished.current = true;
      const target = addToChat && activeChat ? activeChat.chat.id : null;
      void onConnected(status.agent, target).then(() => setAdded(target !== null));
    }
  }, [status, addToChat, activeChat, onConnected]);

  if (!pair) {
    return (
      <Modal title="接入你的 Claude Code" onClose={onClose} width={480}>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => setPair(await api<PairOut>('POST', '/api/agents/pair', { name }))); }}>
          <p className="help">接入后，你电脑上的 Claude Code 就成了群成员：在群里 @ 它，它在你电脑上干活，把回答发回群里。</p>
          <label className="field">
            <span>给它起个名字（群里 @ 的就是这个名字）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
          </label>
          {err && <p className="err">{err}</p>}
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy || !name.trim()}>下一步</button>
          </div>
        </form>
      </Modal>
    );
  }

  const connected = status.status === 'connected';
  return (
    <Modal title={connected ? '已连接 ✓' : '在你的电脑上运行这条命令'} onClose={onClose} width={560}>
      {!connected && (
        <>
          <p className="help">打开终端（Windows 上是 PowerShell 或「终端」），粘贴运行。需要已经装好 Node 和 Claude Code。</p>
          <pre className="command">{pair.command}</pre>
          <div className="actions between">
            <span className="wait">
              {status.status === 'expired' ? (
                <span className="err">这条命令过期了，关掉重新点「接入 agent」。</span>
              ) : status.status === 'claimed' ? (
                <><Spinner size={14} />认出来了，正在连上…</>
              ) : (
                <><Spinner size={14} />等你运行命令…（15 分钟内有效，只能用一次）</>
              )}
            </span>
            <CopyButton text={pair.command} label="复制命令" />
          </div>
          {activeChat && (
            <label className="check">
              <input type="checkbox" checked={addToChat} onChange={(e) => setAddToChat(e.target.checked)} />
              连上后顺便把它拉进「{activeChat.chat.name}」
            </label>
          )}
          <ul className="help list">
            <li>那个终端窗口开着，agent 就在线；关掉就下线，群里 @ 它的活会排队等它回来。</li>
            <li>你自己 @ 它：能读、能改它工作文件夹里的文件，默认不跑命令。</li>
            <li>别人借用它：只能看和回答，不能改文件、不能跑命令。这条写死在连接程序里。</li>
          </ul>
        </>
      )}
      {connected && status.agent && (
        <div className="connected">
          <AgentAvatar agent={status.agent} size={48} dot />
          <div>
            <b>{status.agent.name}</b> 在线了{status.agent.machine ? `（${status.agent.machine}）` : ''}。
            <p className="help">
              {added && activeChat ? `已经拉进「${activeChat.chat.name}」，` : ''}在群里打 <kbd>@</kbd> 就能叫它。别的群要用，去那个群的「成员」里把它拉进去。
            </p>
          </div>
          <div className="actions"><button className="btn primary" onClick={onClose}>好的</button></div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- agent 设置

// 重新上线：运行第一次接入时存在 ~/.agentwork 里的连接程序。写成这样是为了 Windows、Mac 都能直接粘贴。
const RECONNECT = `node -e "require('child_process').spawn(process.execPath,[require('path').join(require('os').homedir(),'.agentwork','agentwork.mjs')],{stdio:'inherit'})"`;

function ShareChoice({ value, onChange, disabled }: { value: 'team' | 'me'; onChange: (v: 'team' | 'me') => void; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup" aria-label="谁能 @ 它">
      <button type="button" role="radio" aria-checked={value === 'team'} className={value === 'team' ? 'on' : ''} disabled={disabled} onClick={() => onChange('team')}>群里谁都能 @</button>
      <button type="button" role="radio" aria-checked={value === 'me'} className={value === 'me' ? 'on' : ''} disabled={disabled} onClick={() => onChange('me')}>只有我能 @</button>
    </div>
  );
}

export function AgentModal({ agent, activeChat, onClose, onChanged }: { agent: Agent; activeChat: ChatDetail | undefined; onClose: () => void; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(agent.name);
  const [confirmDel, setConfirmDel] = useState(false);
  const { busy, err, run } = useAsync();
  const inChat = activeChat?.agents.some((a) => a.id === agent.id);
  return (
    <Modal title="我的 agent" onClose={onClose} width={460}>
      <div className="agent-card">
        <AgentAvatar agent={agent} size={44} dot />
        <div>
          <b>{agent.name}</b>
          <div className="muted">{agentStateText(agent)}{agent.machine ? ` · ${agent.machine}` : ''}</div>
        </div>
      </div>
      {!agent.online && (
        <div className="offline-help">
          <p className="help">它不在线。在接入它的那台电脑上打开终端，运行这条命令就重新上线（不用再配对）：</p>
          <pre className="command small">{RECONNECT}</pre>
          <div className="actions"><CopyButton text={RECONNECT} label="复制命令" /></div>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('PATCH', `/api/agents/${agent.id}`, { name }); await onChanged(); }); }}>
        <label className="field">
          <span>名字</span>
          <div className="row">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
            <button className="btn" disabled={busy || !name.trim() || name.trim() === agent.name}>改名</button>
          </div>
        </label>
      </form>
      <div className="field">
        <span>谁能 @ 它</span>
        <ShareChoice value={agent.share} disabled={busy} onChange={(v) => void run(async () => { await api('PATCH', `/api/agents/${agent.id}`, { share: v }); await onChanged(); })} />
        <p className="help muted">
          {agent.share === 'team'
            ? '和你同群的人都能 @ 它。别人借用时它只能看和回答，不能改文件、不能跑命令。'
            : '别人 @ 它会被婉拒，只有你叫得动。'}
        </p>
      </div>
      {activeChat && (
        <div className="field">
          <span>当前群「{activeChat.chat.name}」</span>
          {inChat ? (
            <button className="btn" disabled={busy} onClick={() => void run(async () => { await api('DELETE', `/api/chats/${activeChat.chat.id}/agents/${agent.id}`); await onChanged(); })}>移出这个群</button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api('POST', `/api/chats/${activeChat.chat.id}/agents`, { agent_id: agent.id }); await onChanged(); })}>拉进这个群</button>
          )}
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <div className="danger-zone">
        {confirmDel ? (
          <>
            <span>删掉后它会退出所有群，那台电脑上的连接程序也会停。确定？</span>
            <button className="btn" onClick={() => setConfirmDel(false)}>不删了</button>
            <button className="btn danger" disabled={busy} onClick={() => void run(async () => { await api('DELETE', `/api/agents/${agent.id}`); await onChanged(); onClose(); })}>确定删除</button>
          </>
        ) : (
          <button className="btn danger ghost" onClick={() => setConfirmDel(true)}>删除这个 agent</button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- 成员抽屉

export function MembersDrawer({ detail, me, myAgents, onClose, onChanged, onLeft, onConnect }: {
  detail: ChatDetail; me: User; myAgents: Agent[]; onClose: () => void; onChanged: () => Promise<void>; onLeft: () => void; onConnect: () => void;
}) {
  const { busy, err, run } = useAsync();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(detail.chat.name);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const cid = detail.chat.id;
  const isCreator = detail.chat.created_by === me.id;
  const outside = myAgents.filter((a) => !detail.agents.some((x) => x.id === a.id));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" aria-label="成员">
        <div className="drawer-head">
          {renaming ? (
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('PATCH', `/api/chats/${cid}`, { name }); setRenaming(false); await onChanged(); }); }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={30} aria-label="群名" />
              <button className="btn primary small" disabled={busy || !name.trim()}>保存</button>
            </form>
          ) : (
            <div className="drawer-title">
              <h2>{detail.chat.name}</h2>
              <button className="link" onClick={() => { setName(detail.chat.name); setRenaming(true); }}>改名</button>
            </div>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </div>
        <div className="drawer-body">
          <h3>Agent · {detail.agents.length}</h3>
          {detail.agents.map((a) => {
            const mine = a.owner?.id === me.id;
            return (
              <div className="member" key={'a' + a.id}>
                <AgentAvatar agent={a} dot={a.kind !== 'builtin'} />
                <div className="member-main">
                  <div className="member-name">{a.name}{mine && <Tag kind="mine">你的 agent</Tag>}</div>
                  <div className="muted">
                    {a.kind === 'builtin' ? '内置 · 谁都能用' : mine ? agentStateText(a) : `${a.owner?.name} 的 agent · ${agentStateText(a)}`}
                    {a.kind !== 'builtin' && !mine && (a.share === 'me' ? ' · 只听主人的' : ' · 可借用（只读）')}
                  </div>
                  {mine && (
                    <div className="member-ctl">
                      <ShareChoice value={a.share} disabled={busy} onChange={(v) => void run(async () => { await api('PATCH', `/api/agents/${a.id}`, { share: v }); })} />
                    </div>
                  )}
                </div>
                {a.kind !== 'builtin' && (mine || isCreator) && (
                  <button className="btn ghost small" disabled={busy} onClick={() => void run(async () => { await api('DELETE', `/api/chats/${cid}/agents/${a.id}`); await onChanged(); })}>移出</button>
                )}
              </div>
            );
          })}
          <div className="add-agent">
            <div className="add-title">把我的 agent 拉进群</div>
            {outside.map((a) => (
              <div className="member" key={'o' + a.id}>
                <AgentAvatar agent={a} dot size={30} />
                <div className="member-main"><div className="member-name">{a.name}</div><div className="muted">{agentStateText(a)}</div></div>
                <button className="btn primary small" disabled={busy} onClick={() => void run(async () => { await api('POST', `/api/chats/${cid}/agents`, { agent_id: a.id }); await onChanged(); })}>拉进来</button>
              </div>
            ))}
            {outside.length === 0 && (
              <p className="muted small">
                {myAgents.length ? '你的 agent 都已经在这个群里了。' : '你还没有自己的 agent。'}
                <button className="link" onClick={onConnect}>＋ 接入一个</button>
              </p>
            )}
          </div>
          <h3>人 · {detail.members.length}</h3>
          {detail.members.map((u) => (
            <div className="member" key={'u' + u.id}>
              <Avatar name={u.name} color={u.color} />
              <div className="member-main">
                <div className="member-name">{u.name}{u.id === me.id && <Tag kind="you">你</Tag>}{u.id === detail.chat.created_by && <Tag kind="plain">群主</Tag>}</div>
              </div>
            </div>
          ))}
          {err && <p className="err">{err}</p>}
        </div>
        <div className="drawer-foot">
          {confirmLeave ? (
            <>
              <span className="muted small">退群后你的 agent 也会一起离开。</span>
              <button className="btn small" onClick={() => setConfirmLeave(false)}>不退了</button>
              <button className="btn danger small" disabled={busy} onClick={() => void run(async () => { await api('POST', `/api/chats/${cid}/leave`); onLeft(); })}>确定退群</button>
            </>
          ) : (
            <button className="btn danger ghost" onClick={() => setConfirmLeave(true)}>退出这个群</button>
          )}
        </div>
      </aside>
    </div>
  );
}
