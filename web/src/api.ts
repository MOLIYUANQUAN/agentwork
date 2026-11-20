// 和 server 说话：类型、HTTP、WebSocket。

export interface User {
  id: number;
  name: string;
  color: string;
}

export interface Agent {
  id: number;
  name: string;
  kind: 'builtin' | 'claude_code';
  share: 'team' | 'me';
  owner: User | null;
  machine: string | null;
  /** 它在主人电脑上的哪个文件夹干活；只有主人自己看得到 */
  workdir?: string | null;
  online: boolean;
  last_seen: number | null;
}

/** 群头像、群头小头像用的：一个成员长什么样。 */
export interface Face {
  kind: 'user' | 'agent';
  name: string;
  color: string | null;
  agent_kind?: 'builtin' | 'claude_code';
}

export type MsgStatus = 'queued' | 'thinking' | 'streaming' | 'done' | 'error';

export interface Msg {
  id: number;
  chat_id: number;
  author_type: 'user' | 'agent' | 'system';
  author_id: number | null;
  text: string;
  status: MsgStatus;
  reply_to: number | null;
  requested_by: number | null;
  created: number;
  meta: {
    steps?: string[];
    seconds?: number;
    mode?: 'owner' | 'guest';
    owner?: string;
    declined?: boolean;
    error?: boolean;
    engine?: string;
    where?: string;
    /** agent 叫 agent：第几轮、是谁叫的 */
    hop?: number;
    via?: string;
    stopped?: boolean;
    stopped_by?: string;
  };
  author: {
    name: string;
    color?: string;
    kind?: 'builtin' | 'claude_code';
    owner?: string | null;
    owner_id?: number | null;
    requester?: string | null;
    gone?: boolean;
  } | null;
}

export interface ChatSummary {
  id: number;
  name: string;
  members: number;
  agents: number;
  unread: number;
  last: { who: string; text: string; at: number } | null;
  created: number;
  faces: Face[];
}

export interface ChatDetail {
  chat: { id: number; name: string; created_by: number; invite_code: string };
  members: User[];
  agents: Agent[];
  messages: Msg[];
  has_more: boolean;
}

export interface Bootstrap {
  me: User;
  chats: ChatSummary[];
  my_agents: Agent[];
  engine: 'fake' | 'api' | 'claude-cli';
}

export interface PublicConfig {
  signup_code: boolean;
  fake: boolean;
}

export interface Contact extends User {
  agents: Agent[];
  chats: { id: number; name: string }[];
}

export type ServerEvent =
  | { type: 'hello'; user_id: number }
  | { type: 'pong' }
  | { type: 'message'; message: Msg }
  | { type: 'message_update'; message: Msg }
  | { type: 'delta'; chat_id: number; id: number; text: string }
  | { type: 'step'; chat_id: number; id: number; step: string }
  | { type: 'status'; chat_id: number; id: number; status: MsgStatus }
  | { type: 'chat_changed'; chat_id: number }
  | { type: 'agent'; agent: Agent }
  | { type: 'my_agents_changed' };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, '连不上服务器，检查一下它是不是还开着');
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 不是 JSON */
  }
  if (!res.ok) {
    const msg =
      (data && typeof data.error === 'string' && data.error) ||
      (data && typeof data.detail === 'string' && data.detail) ||
      (res.status === 422 ? '填的内容不对，检查一下' : `出错了（${res.status}）`);
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

/** 浏览器到 server 的长连接：断了自动重连（越等越久，最多 15 秒），每 25 秒 ping 一次。 */
export class Live {
  private ws: WebSocket | null = null;
  private timer: number | undefined;
  private ping: number | undefined;
  private delay = 500;
  private closed = false;
  private everConnected = false;

  constructor(
    private onEvent: (e: ServerEvent) => void,
    private onState: (connected: boolean, isReconnect: boolean) => void,
  ) {
    this.open();
  }

  private open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = 500;
      this.onState(true, this.everConnected);
      this.everConnected = true;
      window.clearInterval(this.ping);
      this.ping = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      }, 25000);
    };
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(ev.data));
      } catch {
        /* 忽略看不懂的 */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      window.clearInterval(this.ping);
      if (this.closed) return;
      this.onState(false, false);
      this.timer = window.setTimeout(() => this.open(), this.delay);
      this.delay = Math.min(this.delay * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.ping);
    this.ws?.close();
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 换老办法 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
