"""agentwork server: accounts, group chats, realtime, and the bridge to agents.

Run:  python -m uvicorn server.main:app --port 8787   (from the repo root)
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import agents, db  # noqa: E402
from .hub import hub  # noqa: E402

app = FastAPI(title="agentwork")
COOKIE = "aw_session"
WEB_DIST = ROOT / "web" / "dist"
CONNECTOR = ROOT / "connector" / "agentwork.mjs"
PAIR_TTL = 15 * 60
CONNECTOR_SILENCE = 70
SESSION_DAYS = 60
# When the server sits behind a proxy or tunnel, say what address people actually type:
PUBLIC_URL = (os.getenv("AGENTWORK_PUBLIC_URL") or "").strip().rstrip("/")
# If set, registering needs this code (a simple gate for a private trial on a public server):
SIGNUP_CODE = (os.getenv("AGENTWORK_SIGNUP_CODE") or "").strip()


@app.on_event("startup")
async def _startup() -> None:
    db.builtin_agent()
    agents.recover_after_restart()


_tasks: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    """Run in the background; keep a reference so it isn't garbage-collected, and log if it blows up."""
    t = asyncio.create_task(coro)
    _tasks.add(t)

    def done(t: asyncio.Task) -> None:
        _tasks.discard(t)
        if not t.cancelled() and t.exception():
            print(f"[agentwork] 后台任务出错：{t.exception()!r}", flush=True)

    t.add_done_callback(done)


# ---------------------------------------------------------------- auth

def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _user_from_token(token: str | None) -> dict | None:
    if not token:
        return None
    s = db.one("SELECT user_id, created FROM sessions WHERE token=?", (_sha(token),))
    if not s:
        return None
    if time.time() - s["created"] > SESSION_DAYS * 86400:
        db.run("DELETE FROM sessions WHERE token=?", (_sha(token),))
        return None
    return db.one("SELECT * FROM users WHERE id=?", (s["user_id"],))


_attempts: dict[str, list[float]] = {}


def _throttle(key: str, limit: int, window: float, why: str) -> None:
    """At most `limit` tries per `window` seconds for this key. In memory: enough for one process."""
    now = time.time()
    hits = [t for t in _attempts.get(key, []) if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(429, why)
    hits.append(now)
    _attempts[key] = hits
    if len(_attempts) > 5000:  # don't grow without bound
        for k in [k for k, v in _attempts.items() if not v or now - v[-1] > 3600]:
            _attempts.pop(k, None)


def _ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _is_https(request: Request) -> bool:
    return PUBLIC_URL.startswith("https://") or request.url.scheme == "https"


def need_user(request: Request) -> dict:
    u = _user_from_token(request.cookies.get(COOKIE))
    if not u:
        raise HTTPException(401, "请先登录")
    return u


def _login(request: Request, resp: Response, user_id: int) -> None:
    token = secrets.token_urlsafe(32)
    db.run("INSERT INTO sessions(token, user_id, created) VALUES(?,?,?)", (_sha(token), user_id, db.now()))
    resp.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=_is_https(request),
                    max_age=60 * 60 * 24 * SESSION_DAYS)


class RegisterIn(BaseModel):
    name: str
    email: str
    password: str
    code: str = ""


class LoginIn(BaseModel):
    email: str
    password: str


@app.get("/api/config")
def config():
    """What the login page needs to know before anyone is logged in."""
    return {"signup_code": bool(SIGNUP_CODE), "fake": _engine() == "fake"}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/register")
def register(body: RegisterIn, request: Request, resp: Response):
    _throttle(f"reg:{_ip(request)}", 20, 3600, "注册得太频繁了，过一会儿再试")
    if SIGNUP_CODE and not hmac.compare_digest(body.code.strip(), SIGNUP_CODE):
        raise HTTPException(403, "邀请码不对。这台服务器在内测，问建站的人要邀请码")
    name, email = body.name.strip(), body.email.strip().lower()
    if not name or len(name) > 20:
        raise HTTPException(400, "名字 1–20 个字")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise HTTPException(400, "邮箱格式不对")
    if len(body.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    if db.one("SELECT 1 FROM users WHERE email=?", (email,)):
        raise HTTPException(400, "这个邮箱已经注册过了，直接登录")
    uid = db.create_user(name, email, body.password)
    _login(request, resp, uid)
    return {"user": db.user_public(db.one("SELECT * FROM users WHERE id=?", (uid,)))}


@app.post("/api/login")
def login(body: LoginIn, request: Request, resp: Response):
    email = body.email.strip().lower()
    _throttle(f"login:{_ip(request)}:{email}", 8, 600, "试的次数太多了，10 分钟后再来")
    _throttle(f"login:{_ip(request)}", 60, 600, "试的次数太多了，10 分钟后再来")
    u = db.one("SELECT * FROM users WHERE email=?", (email,))
    if not u or not db.check_pw(body.password, u["pw_hash"]):
        raise HTTPException(400, "邮箱或密码不对")
    _attempts.pop(f"login:{_ip(request)}:{email}", None)
    _login(request, resp, u["id"])
    return {"user": db.user_public(u)}


@app.post("/api/logout")
def logout(request: Request, resp: Response):
    tok = request.cookies.get(COOKIE)
    if tok:
        db.run("DELETE FROM sessions WHERE token=?", (_sha(tok),))
    resp.delete_cookie(COOKIE)
    return {"ok": True}


# ---------------------------------------------------------------- shapes

def _chat_summary(chat: dict, me: dict) -> dict:
    last = db.one("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1", (chat["id"],))
    mine = db.one("SELECT last_read FROM chat_members WHERE chat_id=? AND user_id=?", (chat["id"], me["id"]))
    unread = db.one(
        "SELECT count(*) AS n FROM messages WHERE chat_id=? AND id>? AND NOT (author_type='user' AND author_id=?) AND status IN ('done','error')",
        (chat["id"], mine["last_read"] if mine else 0, me["id"]),
    )["n"]
    members = db.one("SELECT count(*) AS n FROM chat_members WHERE chat_id=?", (chat["id"],))["n"]
    agent_count = db.one("SELECT count(*) AS n FROM chat_agents WHERE chat_id=?", (chat["id"],))["n"]
    preview = None
    if last:
        who = agents._author(last).replace("（agent）", "")
        txt = (last["text"] or "").strip().replace("\n", " ")
        if last["status"] in ("thinking", "streaming"):
            txt = "正在想…"
        elif last["status"] == "queued":
            txt = "排队中"
        preview = {"who": who if last["author_type"] != "system" else "", "text": txt[:60], "at": last["created"]}
    return {
        "id": chat["id"], "name": chat["name"], "members": members, "agents": agent_count,
        "unread": unread, "last": preview, "created": chat["created"], "faces": _faces(chat["id"]),
    }


def _faces(chat_id: int) -> list[dict]:
    """Up to four members for the group's avatar: people first, then their agents, the helper last."""
    out: list[dict] = [
        {"kind": "user", "name": u["name"], "color": u["color"]}
        for u in db.q(
            "SELECT u.name, u.color FROM users u JOIN chat_members cm ON cm.user_id=u.id WHERE cm.chat_id=? ORDER BY cm.joined LIMIT 4",
            (chat_id,),
        )
    ]
    agents = db.chat_agents(chat_id)
    for a in [x for x in agents if x["kind"] != "builtin"] + [x for x in agents if x["kind"] == "builtin"]:
        owner = db.one("SELECT color FROM users WHERE id=?", (a["owner_id"],)) if a["owner_id"] else None
        out.append({"kind": "agent", "name": a["name"], "color": owner["color"] if owner else None, "agent_kind": a["kind"]})
    return out[:4]


def _agent_out(a: dict) -> dict:
    return db.agent_public(a, online=a["kind"] == "builtin" or hub.online(a["id"]))


def _my_chats(me: dict) -> list[dict]:
    chats = db.q(
        "SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id=c.id WHERE cm.user_id=?", (me["id"],)
    )
    out = [_chat_summary(c, me) for c in chats]
    out.sort(key=lambda s: (s["last"]["at"] if s["last"] else s["created"]), reverse=True)
    return out


def _engine() -> str:
    if os.getenv("AGENTWORK_FAKE_AI") == "1":
        return "fake"
    if (os.getenv("ANTHROPIC_API_KEY") or "").strip():
        return "api"
    return "claude-cli"


@app.get("/api/bootstrap")
def bootstrap(request: Request):
    me = need_user(request)
    mine = db.q("SELECT * FROM agents WHERE owner_id=? ORDER BY id", (me["id"],))
    return {
        "me": db.user_public(me),
        "chats": _my_chats(me),
        "my_agents": [_agent_out(a) for a in mine],
        "engine": _engine(),
    }


# ---------------------------------------------------------------- chats

class ChatIn(BaseModel):
    name: str


class MessageIn(BaseModel):
    text: str
    mentions: list[int] = []


class ReadIn(BaseModel):
    last_id: int


class AgentRef(BaseModel):
    agent_id: int


def _need_member(chat_id: int, me: dict) -> dict:
    chat = db.one("SELECT * FROM chats WHERE id=?", (chat_id,))
    if not chat or not db.is_member(chat_id, me["id"]):
        raise HTTPException(404, "没有这个群，或者你不在群里")
    return chat


async def _system_msg(chat_id: int, text: str) -> None:
    mid = db.run(
        "INSERT INTO messages(chat_id, author_type, author_id, text, status, created) VALUES(?, 'system', NULL, ?, 'done', ?)",
        (chat_id, text, db.now()),
    )
    await hub.to_chat(chat_id, {"type": "message", "message": db.message_public(db.get_message(mid))})


async def _chat_changed(chat_id: int, extra_users: list[int] | None = None) -> None:
    ids = set(db.chat_member_ids(chat_id)) | set(extra_users or [])
    await hub.to_users(ids, {"type": "chat_changed", "chat_id": chat_id})


@app.post("/api/chats")
async def create_chat(body: ChatIn, request: Request):
    me = need_user(request)
    name = body.name.strip()[:30] or "新群"
    code = secrets.token_urlsafe(6)
    cid = db.run("INSERT INTO chats(name, created_by, invite_code, created) VALUES(?,?,?,?)", (name, me["id"], code, db.now()))
    db.run("INSERT INTO chat_members(chat_id, user_id, joined) VALUES(?,?,?)", (cid, me["id"], db.now()))
    b = db.builtin_agent()
    db.run("INSERT INTO chat_agents(chat_id, agent_id, added_by, added) VALUES(?,?,?,?)", (cid, b["id"], me["id"], db.now()))
    await _system_msg(cid, f"{me['name']} 建了群「{name}」。@助手 随时可以叫它帮忙。")
    await _chat_changed(cid)
    return _chat_summary(db.one("SELECT * FROM chats WHERE id=?", (cid,)), me)


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: int, request: Request, before: int | None = None):
    me = need_user(request)
    chat = _need_member(chat_id, me)
    if before:
        msgs = db.q("SELECT * FROM messages WHERE chat_id=? AND id<? ORDER BY id DESC LIMIT 100", (chat_id, before))
    else:
        msgs = db.q("SELECT * FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 100", (chat_id,))
    msgs.reverse()
    # replies still streaming: send the live text so a reload doesn't show an empty bubble
    out_msgs = []
    for m in msgs:
        pm = db.message_public(m)
        live = agents._live.get(m["id"])
        if live:
            pm["text"] = live["text"]
            pm["meta"]["steps"] = (pm["meta"].get("steps") or []) + live["steps"]
        out_msgs.append(pm)
    members = db.q(
        "SELECT u.id, u.name, u.color FROM users u JOIN chat_members cm ON cm.user_id=u.id WHERE cm.chat_id=? ORDER BY cm.joined",
        (chat_id,),
    )
    return {
        "chat": {"id": chat["id"], "name": chat["name"], "created_by": chat["created_by"],
                 "invite_code": chat["invite_code"]},
        "members": members,
        "agents": [_agent_out(a) for a in db.chat_agents(chat_id)],
        "messages": out_msgs,
        "has_more": len(msgs) == 100,
    }


@app.patch("/api/chats/{chat_id}")
async def rename_chat(chat_id: int, body: ChatIn, request: Request):
    me = need_user(request)
    _need_member(chat_id, me)
    name = body.name.strip()[:30]
    if not name:
        raise HTTPException(400, "群名不能为空")
    db.run("UPDATE chats SET name=? WHERE id=?", (name, chat_id))
    await _system_msg(chat_id, f"{me['name']} 把群名改成了「{name}」")
    await _chat_changed(chat_id)
    return {"ok": True}


@app.post("/api/chats/{chat_id}/messages")
async def send_message(chat_id: int, body: MessageIn, request: Request):
    me = need_user(request)
    _need_member(chat_id, me)
    text = body.text.strip()
    if not text:
        raise HTTPException(400, "说点什么")
    if len(text) > 20000:
        raise HTTPException(400, "太长了，分几条发")
    mid = db.run(
        "INSERT INTO messages(chat_id, author_type, author_id, text, status, created) VALUES(?, 'user', ?, ?, 'done', ?)",
        (chat_id, me["id"], text, db.now()),
    )
    db.run("UPDATE chat_members SET last_read=? WHERE chat_id=? AND user_id=?", (mid, chat_id, me["id"]))
    m = db.get_message(mid)
    await hub.to_chat(chat_id, {"type": "message", "message": db.message_public(m)})
    _spawn(agents.on_user_message(chat_id, m, me, body.mentions))
    return db.message_public(m)


@app.post("/api/chats/{chat_id}/read")
def mark_read(chat_id: int, body: ReadIn, request: Request):
    me = need_user(request)
    _need_member(chat_id, me)
    db.run("UPDATE chat_members SET last_read=max(last_read, ?) WHERE chat_id=? AND user_id=?", (body.last_id, chat_id, me["id"]))
    return {"ok": True}


@app.post("/api/chats/{chat_id}/messages/{message_id}/stop")
async def stop_message(chat_id: int, message_id: int, request: Request):
    """Anyone in the group can stop an agent reply that is queued or still being written."""
    me = need_user(request)
    _need_member(chat_id, me)
    m = db.get_message(message_id)
    if not m or m["chat_id"] != chat_id:
        raise HTTPException(404, "没有这条消息")
    return {"stopped": await agents.stop_reply(m, me)}


@app.post("/api/chats/{chat_id}/invite/reset")
async def reset_invite(chat_id: int, request: Request):
    me = need_user(request)
    chat = _need_member(chat_id, me)
    if chat["created_by"] != me["id"]:
        raise HTTPException(403, "只有群主能重置邀请链接")
    code = secrets.token_urlsafe(6)
    db.run("UPDATE chats SET invite_code=? WHERE id=?", (code, chat_id))
    await _chat_changed(chat_id)
    return {"invite_code": code}


@app.post("/api/chats/{chat_id}/agents")
async def add_agent(chat_id: int, body: AgentRef, request: Request):
    me = need_user(request)
    _need_member(chat_id, me)
    a = db.one("SELECT * FROM agents WHERE id=?", (body.agent_id,))
    if not a or a["owner_id"] != me["id"]:
        raise HTTPException(403, "只能把自己的 agent 拉进群")
    if db.one("SELECT 1 FROM chat_agents WHERE chat_id=? AND agent_id=?", (chat_id, a["id"])):
        return {"ok": True}
    db.run("INSERT INTO chat_agents(chat_id, agent_id, added_by, added) VALUES(?,?,?,?)", (chat_id, a["id"], me["id"], db.now()))
    who = "群里谁都能 @ 它" if a["share"] == "team" else f"只有 {me['name']} 能 @ 它"
    await _system_msg(chat_id, f"{me['name']} 把「{a['name']}」拉进了群（{who}）")
    await _chat_changed(chat_id)
    return {"ok": True}


@app.delete("/api/chats/{chat_id}/agents/{agent_id}")
async def remove_agent(chat_id: int, agent_id: int, request: Request):
    me = need_user(request)
    chat = _need_member(chat_id, me)
    a = db.one("SELECT * FROM agents WHERE id=?", (agent_id,))
    if not a or a["kind"] == "builtin":
        raise HTTPException(400, "内置助手不能移出")
    if a["owner_id"] != me["id"] and chat["created_by"] != me["id"]:
        raise HTTPException(403, "只有 agent 的主人或群主能把它移出")
    db.run("DELETE FROM chat_agents WHERE chat_id=? AND agent_id=?", (chat_id, agent_id))
    await _system_msg(chat_id, f"{me['name']} 把「{a['name']}」移出了群")
    await _chat_changed(chat_id)
    return {"ok": True}


@app.post("/api/chats/{chat_id}/leave")
async def leave_chat(chat_id: int, request: Request):
    me = need_user(request)
    _need_member(chat_id, me)
    db.run("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, me["id"]))
    # my agents leave with me
    for a in db.q("SELECT a.id, a.name FROM agents a JOIN chat_agents ca ON ca.agent_id=a.id WHERE ca.chat_id=? AND a.owner_id=?", (chat_id, me["id"])):
        db.run("DELETE FROM chat_agents WHERE chat_id=? AND agent_id=?", (chat_id, a["id"]))
    await _system_msg(chat_id, f"{me['name']} 退出了群")
    await _chat_changed(chat_id, [me["id"]])
    return {"ok": True}


# ---------------------------------------------------------------- invites

@app.get("/api/invite/{code}")
def invite_info(code: str, request: Request):
    me = need_user(request)
    chat = db.one("SELECT * FROM chats WHERE invite_code=?", (code,))
    if not chat:
        raise HTTPException(404, "邀请链接无效")
    s = _chat_summary(chat, me)
    creator = db.one("SELECT name FROM users WHERE id=?", (chat["created_by"],))
    return {"chat": s, "creator": creator["name"] if creator else "", "member": db.is_member(chat["id"], me["id"])}


@app.post("/api/invite/{code}")
async def invite_join(code: str, request: Request):
    me = need_user(request)
    chat = db.one("SELECT * FROM chats WHERE invite_code=?", (code,))
    if not chat:
        raise HTTPException(404, "邀请链接无效")
    if not db.is_member(chat["id"], me["id"]):
        last = db.one("SELECT max(id) AS m FROM messages WHERE chat_id=?", (chat["id"],))["m"] or 0
        db.run("INSERT INTO chat_members(chat_id, user_id, joined, last_read) VALUES(?,?,?,?)", (chat["id"], me["id"], db.now(), last))
        await _system_msg(chat["id"], f"{me['name']} 加入了群")
        await _chat_changed(chat["id"])
    return {"chat_id": chat["id"]}


# ---------------------------------------------------------------- contacts

@app.get("/api/contacts")
def contacts(request: Request):
    me = need_user(request)
    people = db.q(
        "SELECT DISTINCT u.id, u.name, u.color FROM users u JOIN chat_members cm ON cm.user_id=u.id "
        "WHERE cm.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id=?) AND u.id<>? ORDER BY u.name",
        (me["id"], me["id"]),
    )
    out = []
    for p in people:
        their = db.q("SELECT * FROM agents WHERE owner_id=? ORDER BY id", (p["id"],))
        shared = db.q(
            "SELECT c.id, c.name FROM chats c WHERE c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?) "
            "AND c.id IN (SELECT chat_id FROM chat_members WHERE user_id=?)",
            (me["id"], p["id"]),
        )
        out.append({**p, "agents": [_agent_out(a) for a in their], "chats": shared})
    return {"people": out}


# ---------------------------------------------------------------- my agents & pairing

class PairIn(BaseModel):
    name: str = ""


class AgentPatch(BaseModel):
    name: str | None = None
    share: str | None = None


class ClaimIn(BaseModel):
    code: str
    machine: str = ""
    workdir: str = ""


def _base_url(request: Request) -> str:
    return PUBLIC_URL or str(request.base_url).rstrip("/")


@app.post("/api/agents/pair")
def pair(body: PairIn, request: Request):
    me = need_user(request)
    name = (body.name.strip() or f"{me['name']} 的 Claude")[:24]
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(8))
    code = f"{raw[:4]}-{raw[4:]}"
    db.run("INSERT INTO pair_codes(code, user_id, name, created) VALUES(?,?,?,?)", (code, me["id"], name, db.now()))
    base = _base_url(request)
    command = f"node -e \"fetch('{base}/connect/{code}').then(r=>r.text()).then(eval)\""
    return {"code": code, "name": name, "command": command, "expires_in": PAIR_TTL}


@app.get("/api/agents/pair/{code}")
def pair_status(code: str, request: Request):
    me = need_user(request)
    p = db.one("SELECT * FROM pair_codes WHERE code=? AND user_id=?", (code, me["id"]))
    if not p:
        raise HTTPException(404, "接入码不存在")
    if p["agent_id"]:
        a = db.one("SELECT * FROM agents WHERE id=?", (p["agent_id"],))
        return {"status": "connected" if hub.online(a["id"]) else "claimed", "agent": _agent_out(a)}
    if time.time() - p["created"] > PAIR_TTL:
        return {"status": "expired"}
    return {"status": "waiting"}


@app.get("/connect/{code}", response_class=PlainTextResponse)
def connect_script(code: str, request: Request):
    """Tiny bootstrap the one-line command evals: save the connector to ~/.agentwork and run it."""
    if not re.fullmatch(r"[A-Z0-9]{4}-[A-Z0-9]{4}", code):
        raise HTTPException(404, "bad code")
    base = _base_url(request)
    return f"""
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const dir = path.join(os.homedir(), '.agentwork');
fs.mkdirSync(dir, {{ recursive: true }});
const file = path.join(dir, 'agentwork.mjs');
fetch({json.dumps(base + '/agentwork.mjs')}).then(r => {{
  if (!r.ok) throw new Error('下载连接程序失败：' + r.status);
  return r.text();
}}).then(src => {{
  fs.writeFileSync(file, src);
  console.log('连接程序已保存到 ' + file);
  console.log('以后直接运行：node "' + file + '"');
  const p = cp.spawn(process.execPath, [file, '--server', {json.dumps(base)}, '--code', {json.dumps(code)}], {{ stdio: 'inherit' }});
  p.on('exit', c => process.exit(c ?? 0));
}}).catch(e => {{ console.error(e.message); process.exit(1); }});
"""


@app.get("/agentwork.mjs")
def connector_file():
    return FileResponse(CONNECTOR, media_type="text/javascript; charset=utf-8")


@app.post("/api/connector/claim")
async def claim(body: ClaimIn):
    p = db.one("SELECT * FROM pair_codes WHERE code=?", (body.code.strip().upper(),))
    if not p or p["agent_id"] or time.time() - p["created"] > PAIR_TTL:
        raise HTTPException(400, "接入码无效或已过期，回网页上重新点「接入 agent」拿一个新的")
    token = secrets.token_urlsafe(32)
    aid = db.run(
        "INSERT INTO agents(owner_id, name, kind, share, token_hash, machine, workdir, created) VALUES(?,?,?,?,?,?,?,?)",
        (p["user_id"], p["name"], "claude_code", "team", _sha(token), body.machine[:60], body.workdir[:300], db.now()),
    )
    db.run("UPDATE pair_codes SET agent_id=? WHERE code=?", (aid, p["code"]))
    owner = db.one("SELECT name FROM users WHERE id=?", (p["user_id"],))
    return {"agent_id": aid, "token": token, "name": p["name"], "owner": owner["name"]}


@app.patch("/api/agents/{agent_id}")
async def patch_agent(agent_id: int, body: AgentPatch, request: Request):
    me = need_user(request)
    a = db.one("SELECT * FROM agents WHERE id=? AND owner_id=?", (agent_id, me["id"]))
    if not a:
        raise HTTPException(404, "不是你的 agent")
    if body.name is not None:
        name = body.name.strip()[:24]
        if not name:
            raise HTTPException(400, "名字不能为空")
        db.run("UPDATE agents SET name=? WHERE id=?", (name, agent_id))
    if body.share is not None:
        if body.share not in ("team", "me"):
            raise HTTPException(400, "share 只能是 team 或 me")
        db.run("UPDATE agents SET share=? WHERE id=?", (body.share, agent_id))
    a = db.one("SELECT * FROM agents WHERE id=?", (agent_id,))
    await hub.to_everyone_who_sees_agent(agent_id, {"type": "agent", "agent": _agent_out(a)})
    return _agent_out(a)


@app.delete("/api/agents/{agent_id}")
async def delete_agent(agent_id: int, request: Request):
    me = need_user(request)
    a = db.one("SELECT * FROM agents WHERE id=? AND owner_id=?", (agent_id, me["id"]))
    if not a:
        raise HTTPException(404, "不是你的 agent")
    chats = [r["chat_id"] for r in db.q("SELECT chat_id FROM chat_agents WHERE agent_id=?", (agent_id,))]
    ws = hub.connectors.pop(agent_id, None)
    if ws:
        try:
            await ws.send_text(json.dumps({"type": "revoked"}))
            await ws.close()
        except Exception:
            pass
    db.run("UPDATE messages SET status='error', text='这个 agent 被主人删掉了' WHERE author_type='agent' AND author_id=? AND status IN ('queued','thinking','streaming')", (agent_id,))
    db.run("DELETE FROM agents WHERE id=?", (agent_id,))
    for cid in chats:
        await _system_msg(cid, f"{me['name']} 删掉了「{a['name']}」")
        await _chat_changed(cid)
    await hub.to_user(me["id"], {"type": "my_agents_changed"})
    return {"ok": True}


# ---------------------------------------------------------------- websockets

def _same_origin(ws: WebSocket) -> bool:
    """Browsers send Origin on WebSocket handshakes; refuse pages from other sites using our cookie."""
    origin = ws.headers.get("origin")
    if not origin:
        return True  # not a browser
    host = origin.split("://", 1)[-1]
    return host == ws.headers.get("host") or (PUBLIC_URL and origin == PUBLIC_URL)


@app.websocket("/ws")
async def ws_browser(ws: WebSocket):
    me = _user_from_token(ws.cookies.get(COOKIE))
    if not me or not _same_origin(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    hub.add_browser(me["id"], ws)
    try:
        await ws.send_text(json.dumps({"type": "hello", "user_id": me["id"]}))
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if data.get("type") == "ping":
                await ws.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.drop_browser(me["id"], ws)


@app.websocket("/agent-ws")
async def ws_agent(ws: WebSocket):
    await ws.accept()
    agent = None
    try:
        first = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=15))
        token = first.get("token") if first.get("type") == "auth" else None
        agent = db.one("SELECT * FROM agents WHERE token_hash=?", (_sha(token),)) if token else None
        if not agent:
            await ws.send_text(json.dumps({"type": "auth_failed", "error": "token 无效（agent 可能被删掉了），请在网页上重新接入"}))
            await ws.close(code=4401)
            return
        old = hub.connectors.get(agent["id"])
        if old:
            try:
                await old.send_text(json.dumps({"type": "replaced"}))
                await old.close()
            except Exception:
                pass
            await agents.connector_gone(agent["id"])  # whatever the old one was doing is lost
        hub.connectors[agent["id"]] = ws
        db.run("UPDATE agents SET machine=?, workdir=?, last_seen=? WHERE id=?",
               (str(first.get("machine", ""))[:60], str(first.get("workdir", ""))[:300], db.now(), agent["id"]))
        owner = db.one("SELECT name FROM users WHERE id=?", (agent["owner_id"],))
        await ws.send_text(json.dumps({"type": "ready", "agent_id": agent["id"], "name": agent["name"], "owner": owner["name"],
                                       "fake": _engine() == "fake"}, ensure_ascii=False))
        a = db.one("SELECT * FROM agents WHERE id=?", (agent["id"],))
        await hub.to_everyone_who_sees_agent(agent["id"], {"type": "agent", "agent": _agent_out(a)})
        await agents.flush_queue(agent["id"])
        while True:
            # the connector pings every 20s; silence this long means the computer slept or lost network
            data = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=CONNECTOR_SILENCE))
            if data.get("type") == "ping":
                db.run("UPDATE agents SET last_seen=? WHERE id=?", (db.now(), agent["id"]))
                await ws.send_text('{"type":"pong"}')
            else:
                await agents.connector_event(agent["id"], data)
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass
    except Exception:
        pass
    finally:
        if agent and hub.connectors.get(agent["id"]) is ws:
            hub.connectors.pop(agent["id"], None)
            db.run("UPDATE agents SET last_seen=? WHERE id=?", (db.now(), agent["id"]))
            a = db.one("SELECT * FROM agents WHERE id=?", (agent["id"],))
            if a:
                await hub.to_everyone_who_sees_agent(agent["id"], {"type": "agent", "agent": _agent_out(a)})
                await agents.connector_gone(agent["id"])
            try:
                await ws.close()
            except Exception:
                pass


# ---------------------------------------------------------------- web app

if (WEB_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")


@app.exception_handler(HTTPException)
async def _http_err(request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.get("/{path:path}")
def spa(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "没有这个接口")
    index = WEB_DIST / "index.html"
    if index.exists():
        f = WEB_DIST / path
        if path and f.is_file() and WEB_DIST in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(index)
    return HTMLResponse("<p>网页还没构建：在 web 文件夹运行 <code>npm install</code> 和 <code>npm run build</code>。</p>")
