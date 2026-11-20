// 到处都用的小零件：头像、标签、弹窗、图标、时间、Markdown。
import { MouseEvent, ReactNode, useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { copyText } from './api';
import type { Agent, Face } from './api';

// ---------------------------------------------------------------- avatars
// 人是圆的、实心的；agent 是方圆角、浅底色，一眼分得出谁是人谁是 agent。

const FALLBACK = '#6C7A96';

function firstChar(name: string): string {
  const s = (name || '?').trim();
  return Array.from(s)[0]?.toUpperCase() || '?';
}

export function Avatar({ name, color, size = 36 }: { name: string; color?: string | null; size?: number }) {
  return (
    <span className="avatar person" style={{ background: color || FALLBACK, width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {firstChar(name)}
    </span>
  );
}

export function AgentAvatar({
  agent,
  size = 36,
  dot = false,
}: {
  agent: { kind?: string; color?: string | null; owner?: { color: string } | null; online?: boolean };
  size?: number;
  dot?: boolean;
}) {
  const builtin = agent.kind === 'builtin';
  const color = agent.color || agent.owner?.color || FALLBACK;
  const style = builtin
    ? { width: size, height: size }
    : { width: size, height: size, color, background: color + '24' };
  return (
    <span className={'avatar agent' + (builtin ? ' builtin' : '')} style={style} aria-hidden>
      {builtin ? <SparkGlyph size={size * 0.56} /> : <BotGlyph size={size * 0.62} />}
      {dot && <i className={'dot ' + (agent.online ? 'on' : 'off')} />}
    </span>
  );
}

/** 群头像：用群里前四个成员的头像拼出来。 */
export function GroupAvatar({ faces, size = 44 }: { faces: Face[]; size?: number }) {
  const list = faces.slice(0, 4);
  const n = list.length || 1;
  const cell = n === 1 ? size * 0.62 : n === 2 ? size * 0.42 : size * 0.38;
  const gap = size * 0.05;
  const pos: [number, number][] = [];
  const mid = (size - cell) / 2;
  if (n === 1) pos.push([mid, mid]);
  else if (n === 2) pos.push([size / 2 - cell - gap / 2, mid], [size / 2 + gap / 2, mid]);
  else {
    const top = size / 2 - cell - gap / 2;
    const bottom = size / 2 + gap / 2;
    const left = size / 2 - cell - gap / 2;
    const right = size / 2 + gap / 2;
    if (n === 3) pos.push([mid, top], [left, bottom], [right, bottom]);
    else pos.push([left, top], [right, top], [left, bottom], [right, bottom]);
  }
  return (
    <span className="group-avatar" style={{ width: size, height: size }} aria-hidden>
      {(list.length ? list : [{ kind: 'user', name: '?', color: FALLBACK } as Face]).map((f, i) => (
        <span key={i} style={{ position: 'absolute', left: pos[i][0], top: pos[i][1], display: 'flex' }}>
          {f.kind === 'agent' ? (
            <AgentAvatar agent={{ kind: f.agent_kind, color: f.color }} size={cell} />
          ) : (
            <Avatar name={f.name} color={f.color} size={cell} />
          )}
        </span>
      ))}
    </span>
  );
}

/** 群头右上角那一排小头像。 */
export function AvatarStack({ faces, max = 6, size = 26 }: { faces: Face[]; max?: number; size?: number }) {
  const shown = faces.slice(0, max);
  const more = faces.length - shown.length;
  return (
    <span className="stack" aria-hidden>
      {shown.map((f, i) => (
        <span key={i} className="stack-item">
          {f.kind === 'agent' ? <AgentAvatar agent={{ kind: f.agent_kind, color: f.color }} size={size} /> : <Avatar name={f.name} color={f.color} size={size} />}
        </span>
      ))}
      {more > 0 && <span className="stack-more" style={{ height: size, minWidth: size }}>+{more}</span>}
    </span>
  );
}

export function agentStateText(a: Agent): string {
  if (a.kind === 'builtin') return '随时在线';
  return a.online ? '在线' : '电脑不在线';
}

export function Tag({ kind, children, title }: { kind: 'mine' | 'human' | 'you' | 'plain' | 'builtin' | 'guest'; children: ReactNode; title?: string }) {
  return <span className={'tag ' + kind} title={title}>{children}</span>;
}

// ---------------------------------------------------------------- icons (inline, no icon font)

function Svg({ size = 18, children, fill }: { size?: number; children: ReactNode; fill?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const BotGlyph = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 3.2v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    <circle cx="12" cy="3.2" r="1.5" fill="currentColor" />
    <rect x="3.6" y="6.6" width="16.8" height="13" rx="4.6" fill="currentColor" />
    <circle cx="8.9" cy="12.6" r="1.75" fill="#fff" />
    <circle cx="15.1" cy="12.6" r="1.75" fill="#fff" />
    <path d="M9.4 16.2c1.6 1 3.6 1 5.2 0" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const SparkGlyph = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M11 2.5c.5 4.6 2.4 6.5 7 7-4.6.5-6.5 2.4-7 7-.5-4.6-2.4-6.5-7-7 4.6-.5 6.5-2.4 7-7z" />
    <path d="M18.5 14.5c.25 2.3 1.2 3.25 3.5 3.5-2.3.25-3.25 1.2-3.5 3.5-.25-2.3-1.2-3.25-3.5-3.5 2.3-.25 3.25-1.2 3.5-3.5z" opacity=".7" />
  </svg>
);

export const PlusIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>;
export const CloseIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const LogoutIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M15 8l4 4-4 4M19 12H9" /></Svg>;
export const SendIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const BackIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M15 5l-7 7 7 7" /></Svg>;
export const DownIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 9l6 6 6-6" /></Svg>;
export const ClockIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const CheckIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const LinkIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
export const WarnIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5M12 15.8v.1" /></Svg>;
export const LockIcon = ({ size }: { size?: number }) => <Svg size={size}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;
export const AtIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="3.6" /><path d="M15.6 8.4v4.7a2.3 2.3 0 0 0 4.4.9 8.5 8.5 0 1 0-3.2 5.3" /></Svg>;
export const StopIcon = ({ size }: { size?: number }) => <Svg size={size} fill><rect x="6.5" y="6.5" width="11" height="11" rx="2.5" /></Svg>;
export const CopyIcon = ({ size }: { size?: number }) => <Svg size={size}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" /><path d="M15.5 5.5h-8a2.5 2.5 0 0 0-2.5 2.5v8" /></Svg>;
export const UserPlusIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="10" cy="8" r="3.4" /><path d="M3.5 20c0-3.4 2.9-5.6 6.5-5.6 1.2 0 2.3.2 3.3.7" /><path d="M18 14v6M15 17h6" /></Svg>;

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="16" fill="#1B1C1F" />
      <path d="M13 21.5a8 8 0 0 1 8-8h22a8 8 0 0 1 8 8v13a8 8 0 0 1-8 8H31l-9.5 8.5V42.3a8 8 0 0 1-8.5-7.8z" fill="#fff" />
      <circle cx="24.5" cy="28" r="4.6" fill="#2FA36B" />
      <circle cx="39.5" cy="28" r="4.6" fill="#5B5BD6" />
    </svg>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({ title, onClose, children, width = 420 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('input, textarea, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // 只在打开时聚焦一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} ref={box} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />;
}

// ---------------------------------------------------------------- time

const pad = (n: number) => String(n).padStart(2, '0');
const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();

export function clock(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayKey(ts: number): number {
  return startOfDay(new Date(ts * 1000));
}

/** 聊天里的日期分隔：今天 / 昨天 / 11月20日 周五 */
export function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  const week = '周' + '日一二三四五六'[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 群列表里用：今天显示时间，昨天显示「昨天」，更早显示日期。 */
export function shortTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) return clock(ts);
  if (diff === 1) return '昨天';
  if (diff < 7) return '周' + '日一二三四五六'[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds === null) return '';
  if (seconds < 1) return '不到 1 秒';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

// ---------------------------------------------------------------- markdown (sanitized) with @mentions marked

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mentionRegex(names: string[]): RegExp | null {
  const alts = names.filter(Boolean).sort((a, b) => b.length - a.length).map((n) => '@' + escapeRe(n));
  return alts.length ? new RegExp(`(${alts.join('|')})`, 'g') : null;
}

/** Markdown → 安全的 HTML。@名字 包成 <span class="mention">，代码和链接里的不动。 */
export function renderMarkdown(text: string, names: string[] = []): string {
  const raw = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'img', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'class', 'id'],
  });
  const re = mentionRegex(names);
  const hasCode = clean.includes('<pre');
  if (!hasCode && (!re || !clean.includes('@'))) return clean;
  const box = document.createElement('template');
  box.innerHTML = clean;
  // 代码块右上角加一个「复制」（点击在 Markdown 组件里统一处理）
  for (const pre of Array.from(box.content.querySelectorAll('pre'))) {
    const wrap = document.createElement('div');
    wrap.className = 'code';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.setAttribute('data-copy', '');
    btn.textContent = '复制';
    pre.replaceWith(wrap);
    wrap.append(btn, pre);
  }
  if (!re || !clean.includes('@')) return box.innerHTML;
  const walker = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.includes('@') || t.parentElement?.closest('code, pre, a')) continue;
    targets.push(t);
  }
  for (const t of targets) {
    const parts = t.data.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (!p) return;
      if (i % 2) {
        const span = document.createElement('span');
        span.className = 'mention';
        span.textContent = p;
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(p));
      }
    });
    t.replaceWith(frag);
  }
  return box.innerHTML;
}

export function Markdown({ text, names }: { text: string; names?: string[] }) {
  const html = useMemo(() => renderMarkdown(text, names), [text, names]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    const code = btn?.parentElement?.querySelector('pre');
    if (!btn || !code) return;
    void copyText(code.textContent || '').then((ok) => {
      if (!ok) return;
      btn.textContent = '已复制';
      window.setTimeout(() => { btn.textContent = '复制'; }, 1500);
    });
  };
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
