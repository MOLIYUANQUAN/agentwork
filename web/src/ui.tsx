// 到处都用的小零件：头像、弹窗、图标、时间、Markdown。
import { ReactNode, useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Agent } from './api';

// ---------------------------------------------------------------- avatars

const GROUP_COLORS = ['#5b8def', '#12a37f', '#e8845c', '#9b6dd6', '#d9608a', '#3ca6b8', '#c79a2e', '#6c7a89'];

function firstChar(name: string): string {
  const s = (name || '?').trim();
  return Array.from(s)[0]?.toUpperCase() || '?';
}

export function Avatar({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.44 }} aria-hidden>
      {firstChar(name)}
    </span>
  );
}

export function GroupAvatar({ id, name, size = 40 }: { id: number; name: string; size?: number }) {
  return <Avatar name={name} color={GROUP_COLORS[id % GROUP_COLORS.length]} size={size} />;
}

export function AgentAvatar({
  agent,
  size = 36,
  dot = false,
}: {
  agent: { name: string; kind?: string; owner?: { color: string } | null; online?: boolean };
  size?: number;
  dot?: boolean;
}) {
  const builtin = agent.kind === 'builtin';
  const color = builtin ? 'var(--accent)' : agent.owner?.color || '#6c7a89';
  return (
    <span className="avatar agent-avatar" style={{ background: color, width: size, height: size }} aria-hidden>
      <BotIcon size={size * 0.62} />
      {dot && <i className={'dot ' + (agent.online ? 'on' : 'off')} />}
    </span>
  );
}

export function agentTag(a: { kind?: string; owner?: string | { name: string } | null }): string {
  if (a.kind === 'builtin') return '内置';
  const owner = typeof a.owner === 'string' ? a.owner : a.owner?.name;
  return owner ? `${owner} 的 agent` : 'agent';
}

export function agentStateText(a: Agent): string {
  if (a.kind === 'builtin') return '随时在线';
  return a.online ? '在线' : '电脑不在线';
}

// ---------------------------------------------------------------- icons (inline, no icon font)

function Svg({ size = 18, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const BotIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="4" y="8" width="16" height="11" rx="3.5" fill="#fff" />
    <path d="M12 8V4.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="3.8" r="1.5" fill="#fff" />
    <circle cx="9" cy="13.3" r="1.5" fill="currentColor" opacity=".55" />
    <circle cx="15" cy="13.3" r="1.5" fill="currentColor" opacity=".55" />
  </svg>
);
export const PlusIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 5v14M5 12h14" /></Svg>;
export const CloseIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const ChatIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /></Svg>;
export const PeopleIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.7 3 2.4 3 4.7" /></Svg>;
export const LogoutIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M15 8l4 4-4 4M19 12H9" /></Svg>;
export const SendIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M4 12l16-7-6 16-3-6.5z" /></Svg>;
export const BackIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M15 5l-7 7 7 7" /></Svg>;
export const DownIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M6 9l6 6 6-6" /></Svg>;
export const ClockIcon = ({ size }: { size?: number }) => <Svg size={size}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>;
export const CheckIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const LinkIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
export const WarnIcon = ({ size }: { size?: number }) => <Svg size={size}><path d="M12 4l9 16H3z" /><path d="M12 10v4.5M12 17.5v.1" /></Svg>;
export const LockIcon = ({ size }: { size?: number }) => <Svg size={size}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>;

// ---------------------------------------------------------------- modal

export function Modal({ title, onClose, children, width = 420 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const first = box.current?.querySelector<HTMLElement>('input, textarea, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
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

/** 列表里用：今天显示时间，昨天显示「昨天」，更早显示日期。 */
export function shortTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff === 1) return '昨天';
  if (diff < 7) return '周' + '日一二三四五六'[d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 聊天里的时间分隔条。 */
export function longTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const s = shortTime(ts);
  return s.includes(':') ? hm : `${s} ${hm}`;
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined || seconds === null) return '';
  if (seconds < 1) return '不到 1 秒';
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

// ---------------------------------------------------------------- markdown (sanitized)

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'img', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'class', 'id'],
  });
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
