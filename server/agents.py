"""What happens when someone @s an agent.

Two kinds of agent:
- builtin 「助手」: runs here on the server. Uses the Claude API when ANTHROPIC_API_KEY is
  set, otherwise the Claude Code CLI on this machine (no tools), or a fake when
  AGENTWORK_FAKE_AI=1 (for testing the pipeline without spending anything).
- claude_code: runs on its owner's computer. We hand the job to that computer's
  connector over a WebSocket and relay what it streams back.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import threading
import time
from typing import Any, AsyncIterator

from . import db
from .hub import hub

MODEL = os.getenv("AGENTWORK_MODEL", "claude-opus-5-5")
CONTEXT_FIRST = 20   # messages of context the first time an agent is called in a chat
CONTEXT_MAX = 30     # cap on "what happened since you last spoke"

# live text of replies that are still streaming, so we don't hit sqlite per token
_live: dict[int, dict[str, Any]] = {}


# ---------------------------------------------------------------- helpers

def _names(chat_id: int) -> tuple[list[str], list[str]]:
    people = [r["name"] for r in db.q(
        "SELECT u.name FROM users u JOIN chat_members cm ON cm.user_id=u.id WHERE cm.chat_id=? ORDER BY cm.joined",
        (chat_id,),
    )]
    agents = [a["name"] for a in db.chat_agents(chat_id)]
    return people, agents


def _author(m: dict) -> str:
    if m["author_type"] == "user":
        u = db.one("SELECT name FROM users WHERE id=?", (m["author_id"],))
        return u["name"] if u else "某人"
    if m["author_type"] == "agent":
        a = db.one("SELECT name FROM agents WHERE id=?", (m["author_id"],))
        return f"{a['name'] if a else 'agent'}（agent）"
    return "系统"


def _fmt(m: dict, limit: int = 1500) -> str:
    t = time.strftime("%m-%d %H:%M", time.localtime(m["created"]))
    text = (m["text"] or "").strip()
    if len(text) > limit:
        text = text[:limit] + "…（后面省略）"
    return f"[{t}] {_author(m)}：{text}"


def context_lines(chat_id: int, before_id: int, agent_id: int | None) -> list[str]:
    """Recent chat for the agent. For an agent with its own memory (Claude Code
    resumes its session per chat) we send only what happened since it last spoke."""
    rows: list[dict] = []
    if agent_id is not None:
        last = db.one(
            "SELECT max(id) AS m FROM messages WHERE chat_id=? AND author_type='agent' AND author_id=? AND status='done' AND id<?",
            (chat_id, agent_id, before_id),
        )
        if last and last["m"]:
            rows = db.q(
                "SELECT * FROM messages WHERE chat_id=? AND id>? AND id<? AND status='done' ORDER BY id DESC LIMIT ?",
                (chat_id, last["m"], before_id, CONTEXT_MAX),
            )
            return [_fmt(m) for m in reversed(rows)]
    rows = db.q(
        "SELECT * FROM messages WHERE chat_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT ?",
        (chat_id, before_id, CONTEXT_FIRST if agent_id is not None else CONTEXT_MAX),
    )
    return [_fmt(m) for m in reversed(rows)]


async def _push(m: dict) -> None:
    await hub.to_chat(m["chat_id"], {"type": "message_update", "message": db.message_public(m)})


async def _new_reply(chat_id: int, agent: dict, question: dict, sender: dict, status: str, meta: dict) -> dict:
    mid = db.run(
        "INSERT INTO messages(chat_id, author_type, author_id, text, status, reply_to, requested_by, meta, created) "
        "VALUES(?, 'agent', ?, '', ?, ?, ?, ?, ?)",
        (chat_id, agent["id"], status, question["id"], sender["id"], json.dumps(meta, ensure_ascii=False), db.now()),
    )
    m = db.get_message(mid)
    await hub.to_chat(chat_id, {"type": "message", "message": db.message_public(m)})
    return m


async def _delta(m: dict, text: str) -> None:
    live = _live.setdefault(m["id"], {"text": "", "steps": [], "t0": time.time(), "flushed": 0.0})
    if not live["text"]:
        db.update_message(m["id"], status="streaming")
        await hub.to_chat(m["chat_id"], {"type": "status", "chat_id": m["chat_id"], "id": m["id"], "status": "streaming"})
    live["text"] += text
    await hub.to_chat(m["chat_id"], {"type": "delta", "chat_id": m["chat_id"], "id": m["id"], "text": text})
    if time.time() - live["flushed"] > 2:
        live["flushed"] = time.time()
        db.update_message(m["id"], text=live["text"])


async def _step(m: dict, step: str) -> None:
    live = _live.setdefault(m["id"], {"text": "", "steps": [], "t0": time.time(), "flushed": 0.0})
    live["steps"].append(step)
    await hub.to_chat(m["chat_id"], {"type": "step", "chat_id": m["chat_id"], "id": m["id"], "step": step})


async def _finish(m: dict, text: str | None, extra: dict | None = None, status: str = "done") -> None:
    live = _live.pop(m["id"], None) or {"text": "", "steps": [], "t0": m["created"]}
    cur = db.get_message(m["id"]) or m
    meta = json.loads(cur.get("meta") or "{}")
    meta.setdefault("steps", [])
    meta["steps"] = (meta["steps"] or []) + live["steps"]
    started = meta.get("started") or live["t0"]
    meta["seconds"] = round(time.time() - started, 1)
    if extra:
        meta.update(extra)
    final = text if text is not None else live["text"]
    m2 = db.update_message(m["id"], text=final, status=status, meta=meta)
    await _push(m2)


async def _fail(m: dict, why: str) -> None:
    await _finish(m, why, {"error": True}, status="error")


# ---------------------------------------------------------------- entry point

async def on_user_message(chat_id: int, question: dict, sender: dict, mention_ids: list[int]) -> None:
    agents = db.chat_agents(chat_id)
    text = question["text"] or ""
    wanted = set(mention_ids)
    for a in agents:
        if f"@{a['name']}" in text:
            wanted.add(a["id"])
    for a in agents:
        if a["id"] not in wanted:
            continue
        if a["kind"] == "builtin":
            m = await _new_reply(chat_id, a, question, sender, "thinking", {"started": time.time(), "where": "server"})
            asyncio.create_task(_run_builtin(m, a, question, sender))
            continue
        owner = db.one("SELECT * FROM users WHERE id=?", (a["owner_id"],))
        is_owner = owner and owner["id"] == sender["id"]
        if a["share"] == "me" and not is_owner:
            m = await _new_reply(chat_id, a, question, sender, "done", {"declined": True})
            await _finish(
                m,
                f"我现在只听 {owner['name']} 的。想借用我，请 {owner['name']} 在我的设置里打开「群里谁都能 @」。",
                {"declined": True},
            )
            continue
        meta = {"mode": "owner" if is_owner else "guest", "owner": owner["name"]}
        if hub.online(a["id"]):
            meta["started"] = time.time()
            m = await _new_reply(chat_id, a, question, sender, "thinking", meta)
            if not await _send_job(m, a):
                db.update_message(m["id"], status="queued")
                await _push(db.get_message(m["id"]))
        else:
            await _new_reply(chat_id, a, question, sender, "queued", meta)


# ---------------------------------------------------------------- builtin

BUILTIN_SYSTEM = (
    "你是团队聊天软件 agentwork 里的「助手」，每个群都有你，谁都可以 @ 你。"
    "你的回答会原样发到群里，所以像一个靠谱的同事在群里回话：先给结论，简洁，必要时用 Markdown 列表或代码块。"
    "默认用中文，对方用别的语言就跟着用。你看不到群外的东西，也不能替人执行操作；做不到的事直说。"
)


def _builtin_prompt(chat_id: int, question: dict, sender: dict) -> str:
    chat = db.one("SELECT name FROM chats WHERE id=?", (chat_id,))
    people, agents = _names(chat_id)
    lines = context_lines(chat_id, question["id"], None)
    ctx = "\n".join(lines) if lines else "（之前没有聊天）"
    return (
        f"群名：{chat['name']}\n群里的人：{'、'.join(people)}\n群里的 agent：{'、'.join(agents)}\n\n"
        f"群里最近的聊天（旧→新）：\n{ctx}\n\n"
        f"现在 {sender['name']} @ 了你：\n{question['text']}"
    )


async def _run_builtin(m: dict, agent: dict, question: dict, sender: dict) -> None:
    prompt = _builtin_prompt(m["chat_id"], question, sender)
    try:
        if os.getenv("AGENTWORK_FAKE_AI") == "1":
            engine = "fake"
            async for kind, val in _fake_stream(question["text"]):
                await (_delta(m, val) if kind == "text" else _step(m, val))
            await _finish(m, None, {"engine": engine})
        elif (os.getenv("ANTHROPIC_API_KEY") or "").strip():
            await _builtin_api(m, prompt)
        elif shutil.which("claude"):
            await _builtin_cli(m, prompt)
        else:
            await _fail(m, "内置助手还没接上大模型：在 agentwork 文件夹的 .env 里放 ANTHROPIC_API_KEY，或者在这台电脑上装好并登录 Claude Code。")
    except Exception as e:  # never leave a reply spinning forever
        await _fail(m, f"出错了：{type(e).__name__}: {str(e)[:300]}")


async def _builtin_api(m: dict, prompt: str) -> None:
    import anthropic

    client = anthropic.AsyncAnthropic()
    try:
        async with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low"},
            system=BUILTIN_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                await _delta(m, text)
            final = await stream.get_final_message()
    except anthropic.RateLimitError:
        await _fail(m, "Claude API 现在太忙（限流），过一会儿再 @ 我。")
        return
    except anthropic.APIConnectionError:
        await _fail(m, "连不上 Claude API，检查一下网络或代理。")
        return
    except anthropic.APIStatusError as e:
        await _fail(m, f"Claude API 报错 {e.status_code}。")
        return
    if final.stop_reason == "refusal":
        await _fail(m, "这个问题我不能回答。")
        return
    usage = final.usage
    await _finish(m, None, {"engine": "api", "model": final.model,
                            "tokens": (usage.input_tokens or 0) + (usage.output_tokens or 0)})


async def _builtin_cli(m: dict, prompt: str) -> None:
    workdir = db.DATA_DIR / "builtin"
    workdir.mkdir(exist_ok=True)
    args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--tools", "", "--strict-mcp-config", "--no-session-persistence",
            "--append-system-prompt", BUILTIN_SYSTEM]
    result: dict = {}
    async for ev in claude_cli_events(args, prompt, str(workdir)):
        kind = ev.get("type")
        if kind == "stream_event":
            e = ev.get("event") or {}
            d = e.get("delta") or {}
            if e.get("type") == "content_block_delta" and d.get("type") == "text_delta":
                await _delta(m, d.get("text", ""))
        elif kind == "result":
            result = ev
    if not result:
        await _fail(m, "这台电脑上的 Claude Code 没有回话（进程提前退出了）。")
        return
    text = (result.get("result") or "").strip()
    if result.get("is_error"):
        if "login" in text.lower():
            await _fail(m, "内置助手用的是这台电脑上的 Claude Code，它还没登录：在终端运行 `claude`，输入 `/login` 登录一次就好。")
        else:
            await _fail(m, f"Claude Code 报错：{text[:300]}")
        return
    await _finish(m, text or None, {"engine": "claude-cli", "cost_usd": result.get("total_cost_usd")})


async def claude_cli_events(args: list[str], prompt: str, cwd: str) -> AsyncIterator[dict]:
    """Run `claude <args>` with the prompt on stdin and yield its stream-json events.

    Runs in a thread (works whatever event loop uvicorn picked on Windows)."""
    exe = shutil.which("claude")
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def worker() -> None:
        try:
            p = subprocess.Popen([exe, *args], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL)
            p.stdin.write(prompt.encode("utf-8"))
            p.stdin.close()
            for raw in p.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, json.loads(line))
                except ValueError:
                    pass
            p.wait(timeout=30)
        except Exception as e:  # surface as a result event
            loop.call_soon_threadsafe(queue.put_nowait, {"type": "result", "is_error": True, "result": str(e)})
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=worker, daemon=True).start()
    while True:
        ev = await queue.get()
        if ev is None:
            return
        yield ev


async def _fake_stream(question: str) -> AsyncIterator[tuple[str, str]]:
    """Pretend to be a model: a couple of steps, then text in small chunks."""
    await asyncio.sleep(0.8)
    q = question.strip().replace("\n", " ")
    reply = (
        f"收到。你问的是：「{q[:80]}」。\n\n"
        "这是**测试模式**的回答（AGENTWORK_FAKE_AI=1），没有真的调用模型。真实情况下我会：\n\n"
        "1. 先看群里最近在聊什么\n2. 给出结论\n3. 需要的话列出下一步\n\n"
        "```python\nprint('hello from agentwork')\n```"
    )
    for i in range(0, len(reply), 6):
        yield "text", reply[i:i + 6]
        await asyncio.sleep(0.04)


# ---------------------------------------------------------------- connectors

def _job_prompt(m: dict, agent: dict) -> tuple[str, str]:
    chat = db.one("SELECT * FROM chats WHERE id=?", (m["chat_id"],))
    question = db.get_message(m["reply_to"])
    requester = db.one("SELECT * FROM users WHERE id=?", (m["requested_by"],))
    owner = db.one("SELECT * FROM users WHERE id=?", (agent["owner_id"],))
    mode = "owner" if requester["id"] == owner["id"] else "guest"
    people, agents = _names(m["chat_id"])
    lines = context_lines(m["chat_id"], question["id"], agent["id"])
    parts = [
        f"你是「{agent['name']}」，{owner['name']} 的 Claude Code，现在在团队聊天软件 agentwork 的群「{chat['name']}」里。",
        f"群里的人：{'、'.join(people)}。群里的 agent：{'、'.join(agents)}。",
    ]
    if lines:
        parts.append("你上次说话之后，群里聊了这些（旧→新）：\n" + "\n".join(lines))
    parts.append(f"现在 {requester['name']} 在群里 @ 了你：\n{question['text']}")
    parts.append("你的最后一条回答会原样发到群里。像同事在群里回话：先给结论，简洁，用 Markdown。默认用中文。")
    if mode == "guest":
        parts.append(
            f"注意：这次是 {requester['name']} 借用你（你的主人是 {owner['name']}）。这次你只能读文件、搜索、查资料，"
            f"不能改文件，也不能运行命令。需要改动的话，说清楚要改什么，请 {owner['name']} 来 @ 你。"
        )
    else:
        parts.append(f"这次是你的主人 {owner['name']} 在叫你，你可以读和改当前工作文件夹里的文件。")
    return "\n\n".join(parts), mode


async def _send_job(m: dict, agent: dict) -> bool:
    prompt, mode = _job_prompt(m, agent)
    chat = db.one("SELECT name FROM chats WHERE id=?", (m["chat_id"],))
    requester = db.one("SELECT name FROM users WHERE id=?", (m["requested_by"],))
    return await hub.to_connector(agent["id"], {
        "type": "job",
        "job_id": m["id"],
        "chat_id": m["chat_id"],
        "chat_name": chat["name"],
        "mode": mode,
        "requester": requester["name"],
        "prompt": prompt,
    })


async def flush_queue(agent_id: int) -> None:
    agent = db.one("SELECT * FROM agents WHERE id=?", (agent_id,))
    for m in db.q("SELECT * FROM messages WHERE author_type='agent' AND author_id=? AND status='queued' ORDER BY id", (agent_id,)):
        meta = json.loads(m["meta"] or "{}")
        meta["started"] = time.time()
        m2 = db.update_message(m["id"], status="thinking", meta=meta)
        await _push(m2)
        if not await _send_job(m2, agent):
            db.update_message(m["id"], status="queued")
            return


async def connector_gone(agent_id: int) -> None:
    owner = db.one("SELECT u.name FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.id=?", (agent_id,))
    who = owner["name"] if owner else "主人"
    for m in db.q("SELECT * FROM messages WHERE author_type='agent' AND author_id=? AND status IN ('thinking','streaming')", (agent_id,)):
        await _fail(m, f"{who} 的电脑断开了，这件活没做完。等它重新连上后再 @ 我一次。")


async def connector_event(agent_id: int, data: dict) -> None:
    kind = data.get("type")
    job = data.get("job_id")
    if not isinstance(job, int):
        return
    m = db.get_message(job)
    # a connector may only touch replies that belong to its own agent
    if not m or m["author_type"] != "agent" or m["author_id"] != agent_id or m["status"] in ("done", "error"):
        return
    if kind == "delta":
        await _delta(m, str(data.get("text", "")))
    elif kind == "step":
        await _step(m, str(data.get("step", ""))[:200])
    elif kind == "done":
        extra = {k: data[k] for k in ("cost_usd", "turns") if k in data}
        text = data.get("text")
        await _finish(m, str(text) if text is not None else None, extra)
    elif kind == "error":
        await _fail(m, str(data.get("error", "出错了"))[:1000])


def recover_after_restart() -> None:
    for m in db.q("SELECT id, author_id FROM messages WHERE status IN ('thinking','streaming')"):
        a = db.one("SELECT kind FROM agents WHERE id=?", (m["author_id"],))
        if a and a["kind"] == "builtin":
            db.update_message(m["id"], status="error", text="服务器重启了，这条没做完。再 @ 我一次。")
        else:
            db.update_message(m["id"], status="queued")  # resend when the connector comes back
