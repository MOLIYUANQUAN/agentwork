// 整个页面的状态，和「server 推来一个事件之后状态怎么变」。
import type { Agent, Bootstrap, ChatDetail, ChatSummary, Msg, ServerEvent, User } from './api';

export interface State {
  me: User;
  chats: ChatSummary[];
  myAgents: Agent[];
  engine: Bootstrap['engine'];
  details: Record<number, ChatDetail>;
  activeId: number | null;
  /** 当前群是不是「正在被看」（窗口在前台、滚在底部附近）。是的话新消息不算未读。 */
  watching: boolean;
}

export type Action =
  | { type: 'boot'; boot: Bootstrap }
  | { type: 'open'; id: number | null }
  | { type: 'watching'; on: boolean }
  | { type: 'detail'; detail: ChatDetail }
  | { type: 'older'; chatId: number; messages: Msg[]; hasMore: boolean }
  | { type: 'gone'; chatId: number }
  | { type: 'read'; chatId: number }
  | { type: 'sent'; message: Msg }
  | { type: 'event'; event: ServerEvent };

export function initial(boot: Bootstrap): State {
  return { me: boot.me, chats: boot.chats, myAgents: boot.my_agents, engine: boot.engine, details: {}, activeId: null, watching: false };
}

function preview(m: Msg): ChatSummary['last'] {
  let text = (m.text || '').trim().replace(/\n/g, ' ').slice(0, 60);
  if (m.status === 'thinking' || m.status === 'streaming') text = '正在想…';
  else if (m.status === 'queued') text = '排队中';
  else if (m.meta.stopped && !text) text = '已停止';
  return { who: m.author_type === 'system' ? '' : m.author?.name || '', text, at: m.created };
}

function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => (b.last?.at ?? b.created) - (a.last?.at ?? a.created));
}

function patchMsg(s: State, chatId: number, id: number, fn: (m: Msg) => Msg): State {
  const d = s.details[chatId];
  if (!d) return s;
  let hit = false;
  const messages = d.messages.map((m) => {
    if (m.id !== id) return m;
    hit = true;
    return fn(m);
  });
  return hit ? { ...s, details: { ...s.details, [chatId]: { ...d, messages } } } : s;
}

function upsertMsg(s: State, m: Msg): State {
  const d = s.details[m.chat_id];
  if (!d) return s;
  const i = d.messages.findIndex((x) => x.id === m.id);
  let messages: Msg[];
  if (i >= 0) {
    messages = d.messages.slice();
    messages[i] = m;
  } else {
    messages = [...d.messages, m].sort((a, b) => a.id - b.id);
  }
  return { ...s, details: { ...s.details, [m.chat_id]: { ...d, messages } } };
}

/** 一条消息到了「别人能读」的状态：算进未读、更新列表里的预览。 */
function touchSummary(s: State, m: Msg, countUnread: boolean): State {
  const mine = m.author_type === 'user' && m.author_id === s.me.id;
  const seen = s.activeId === m.chat_id && s.watching;
  const chats = s.chats.map((c) => {
    if (c.id !== m.chat_id) return c;
    const isLatest = !c.last || m.created >= c.last.at - 0.001;
    return {
      ...c,
      last: isLatest ? preview(m) : c.last,
      unread: countUnread && !mine && !seen ? c.unread + 1 : c.unread,
    };
  });
  return { ...s, chats: sortChats(chats) };
}

function patchAgent(list: Agent[], a: Agent): Agent[] {
  return list.map((x) => (x.id === a.id ? a : x));
}

export function reducer(s: State, act: Action): State {
  switch (act.type) {
    case 'boot':
      return { ...s, me: act.boot.me, chats: act.boot.chats, myAgents: act.boot.my_agents, engine: act.boot.engine };
    case 'open':
      return { ...s, activeId: act.id };
    case 'watching':
      return s.watching === act.on ? s : { ...s, watching: act.on };
    case 'detail':
      return { ...s, details: { ...s.details, [act.detail.chat.id]: act.detail } };
    case 'older': {
      const d = s.details[act.chatId];
      if (!d) return s;
      const have = new Set(d.messages.map((m) => m.id));
      const messages = [...act.messages.filter((m) => !have.has(m.id)), ...d.messages];
      return { ...s, details: { ...s.details, [act.chatId]: { ...d, messages, has_more: act.hasMore } } };
    }
    case 'gone': {
      const details = { ...s.details };
      delete details[act.chatId];
      return {
        ...s,
        details,
        chats: s.chats.filter((c) => c.id !== act.chatId),
        activeId: s.activeId === act.chatId ? null : s.activeId,
      };
    }
    case 'read':
      return { ...s, chats: s.chats.map((c) => (c.id === act.chatId && c.unread ? { ...c, unread: 0 } : c)) };
    case 'sent':
      return touchSummary(upsertMsg(s, act.message), act.message, false);
    case 'event':
      return onEvent(s, act.event);
  }
}

function onEvent(s: State, e: ServerEvent): State {
  switch (e.type) {
    case 'message': {
      const m = e.message;
      const known = s.details[m.chat_id]?.messages.some((x) => x.id === m.id);
      const readable = m.status === 'done' || m.status === 'error';
      return touchSummary(upsertMsg(s, m), m, readable && !known);
    }
    case 'message_update': {
      const m = e.message;
      const before = s.details[m.chat_id]?.messages.find((x) => x.id === m.id);
      const wasReadable = before ? before.status === 'done' || before.status === 'error' : false;
      const readable = m.status === 'done' || m.status === 'error';
      return touchSummary(upsertMsg(s, m), m, readable && !wasReadable);
    }
    case 'delta':
      return patchMsg(s, e.chat_id, e.id, (m) => ({ ...m, text: m.text + e.text, status: m.status === 'thinking' ? 'streaming' : m.status }));
    case 'status':
      return patchMsg(s, e.chat_id, e.id, (m) => ({ ...m, status: e.status }));
    case 'step':
      return patchMsg(s, e.chat_id, e.id, (m) => ({ ...m, meta: { ...m.meta, steps: [...(m.meta.steps || []), e.step] } }));
    case 'agent': {
      const details: State['details'] = {};
      for (const [k, d] of Object.entries(s.details)) details[+k] = { ...d, agents: patchAgent(d.agents, e.agent) };
      return { ...s, myAgents: patchAgent(s.myAgents, e.agent), details };
    }
    default:
      return s;
  }
}
