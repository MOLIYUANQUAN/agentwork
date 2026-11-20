"""End-to-end test of the server + connector in fake mode. No model is called.

Run from the repo root:   python tests/e2e_api.py
It starts its own server on port 8799 with a throwaway database.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.getenv("E2E_PORT", "8799"))
BASE = f"http://127.0.0.1:{PORT}"
TMP = Path(tempfile.mkdtemp(prefix="agentwork-e2e-"))
CONNECTOR = ROOT / "connector" / "agentwork.mjs"
passed = 0


def ok(name: str) -> None:
    global passed
    passed += 1
    print(f"  ✓ {name}")


class Client:
    """One logged-in person: HTTP session + a WebSocket that records every event."""

    def __init__(self, name: str):
        self.name = name
        self.http = httpx.AsyncClient(base_url=BASE, timeout=20)
        self.events: list[dict] = []
        self.ws = None
        self._task = None
        self.me: dict = {}

    async def register(self, email: str, pw: str) -> None:
        r = await self.http.post("/api/register", json={"name": self.name, "email": email, "password": pw})
        assert r.status_code == 200, r.text
        self.me = r.json()["user"]

    async def open_ws(self) -> None:
        cookie = "; ".join(f"{k}={v}" for k, v in self.http.cookies.items())
        self.ws = await websockets.connect(f"ws://127.0.0.1:{PORT}/ws", additional_headers={"Cookie": cookie})
        self._task = asyncio.create_task(self._pump())
        await self.wait(lambda e: e["type"] == "hello")

    async def _pump(self) -> None:
        try:
            async for raw in self.ws:
                self.events.append(json.loads(raw))
        except Exception:
            pass

    async def wait(self, pred, timeout: float = 15, since: int = 0) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events[since:]:
                if pred(e):
                    return e
            await asyncio.sleep(0.05)
        kinds = [e["type"] for e in self.events[since:]]
        raise AssertionError(f"{self.name}: 等不到事件；这段时间收到的是 {kinds}")

    def mark(self) -> int:
        return len(self.events)

    async def api(self, method: str, path: str, expect: int = 200, **kw):
        r = await self.http.request(method, path, **kw)
        assert r.status_code == expect, f"{method} {path} -> {r.status_code} {r.text}"
        return r.json()

    async def close(self) -> None:
        if self.ws:
            await self.ws.close()
        await self.http.aclose()


def start_connector(home: Path, *args: str) -> subprocess.Popen:
    env = {**os.environ, "AGENTWORK_HOME": str(home / "cfg"), "AGENTWORK_WORK": str(home / "work")}
    return subprocess.Popen(["node", str(CONNECTOR), *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


async def reply_done(c: Client, since: int, agent_id: int, timeout: float = 30) -> dict:
    e = await c.wait(
        lambda e: e["type"] == "message_update" and e["message"]["author_id"] == agent_id
        and e["message"]["author_type"] == "agent" and e["message"]["status"] in ("done", "error"),
        timeout, since)
    return e["message"]


async def main() -> None:
    a, b = Client("Zeep"), Client("尹昊")

    print("账号")
    await a.register("zeep@example.com", "secret-a1")
    await b.register("yinhao@example.com", "secret-b1")
    r = await a.http.post("/api/register", json={"name": "x", "email": "zeep@example.com", "password": "123456"})
    assert r.status_code == 400 and "error" in r.json()
    r = await httpx.AsyncClient(base_url=BASE).post("/api/login", json={"email": "zeep@example.com", "password": "wrong"})
    assert r.status_code == 400
    r = await httpx.AsyncClient(base_url=BASE).get("/api/bootstrap")
    assert r.status_code == 401
    fresh = httpx.AsyncClient(base_url=BASE)
    r = await fresh.post("/api/login", json={"email": "ZEEP@example.com", "password": "secret-a1"})
    assert r.status_code == 200 and r.json()["user"]["name"] == "Zeep"
    await fresh.aclose()
    ok("注册、重复邮箱、密码错、未登录、登录")

    await a.open_ws()
    await b.open_ws()
    boot = await a.api("GET", "/api/bootstrap")
    assert boot["engine"] == "fake" and boot["chats"] == []
    ok("WebSocket hello、bootstrap")

    print("群")
    m = a.mark()
    chat = await a.api("POST", "/api/chats", json={"name": "测试群"})
    cid = chat["id"]
    await a.wait(lambda e: e["type"] == "message" and e["message"]["author_type"] == "system", since=m)
    await a.wait(lambda e: e["type"] == "chat_changed" and e["chat_id"] == cid, since=m)
    detail = await a.api("GET", f"/api/chats/{cid}")
    helper = next(x for x in detail["agents"] if x["kind"] == "builtin")
    assert helper["online"] and len(detail["members"]) == 1
    await b.api("GET", f"/api/chats/{cid}", expect=404)
    ok("建群，自带助手；不在群里的人看不到")

    code = detail["chat"]["invite_code"]
    info = await b.api("GET", f"/api/invite/{code}")
    assert info["chat"]["name"] == "测试群" and info["member"] is False and info["creator"] == "Zeep"
    await b.api("GET", "/api/invite/nope", expect=404)
    m = a.mark()
    joined = await b.api("POST", f"/api/invite/{code}")
    assert joined["chat_id"] == cid
    await a.wait(lambda e: e["type"] == "message" and "加入" in e["message"]["text"], since=m)
    await a.wait(lambda e: e["type"] == "chat_changed", since=m)
    assert (await b.api("POST", f"/api/invite/{code}"))["chat_id"] == cid  # joining twice is harmless
    assert len((await a.api("GET", f"/api/chats/{cid}"))["members"]) == 2
    ok("邀请链接：看信息、加入、重复加入")

    m = b.mark()
    sent = await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "大家好，周五前要把报告写完"})
    got = await b.wait(lambda e: e["type"] == "message" and e["message"]["id"] == sent["id"], since=m)
    assert got["message"]["text"].startswith("大家好")
    chats_b = (await b.api("GET", "/api/bootstrap"))["chats"]
    assert chats_b[0]["unread"] >= 1 and chats_b[0]["last"]["who"] == "Zeep"
    await b.api("POST", f"/api/chats/{cid}/read", json={"last_id": sent["id"]})
    assert (await b.api("GET", "/api/bootstrap"))["chats"][0]["unread"] == 0
    await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "   "}, expect=400)
    ok("发消息、对方实时收到、未读数、标记已读")

    print("内置助手")
    m = b.mark()
    await b.api("POST", f"/api/chats/{cid}/messages", json={"text": "@助手 报告什么时候交？", "mentions": [helper["id"]]})
    first = await b.wait(lambda e: e["type"] == "message" and e["message"]["author_type"] == "agent", since=m)
    assert first["message"]["status"] == "thinking"
    rid = first["message"]["id"]
    await b.wait(lambda e: e["type"] == "status" and e["id"] == rid and e["status"] == "streaming", since=m)
    await b.wait(lambda e: e["type"] == "delta" and e["id"] == rid, since=m)
    # reload mid-stream: the chat already has the partial text
    await asyncio.sleep(0.4)
    mid = next(x for x in (await b.api("GET", f"/api/chats/{cid}"))["messages"] if x["id"] == rid)
    assert mid["status"] == "streaming" and len(mid["text"]) > 0
    done = await reply_done(b, m, helper["id"])
    streamed = "".join(e["text"] for e in b.events[m:] if e["type"] == "delta" and e["id"] == rid)
    assert done["status"] == "done" and done["text"] == streamed and "报告什么时候交" in done["text"]
    assert done["meta"]["seconds"] > 0 and done["requested_by"] == b.me["id"]
    await reply_done(a, 0, helper["id"])  # the other person saw it too
    ok("@助手：thinking → streaming → delta → done；中途刷新能看到已出的字")

    m = a.mark()
    await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "@助手 只靠名字也能叫到你吗"})
    assert (await reply_done(a, m, helper["id"]))["status"] == "done"
    ok("不带 mentions，只写 @名字 也行")

    print("接入自己的 agent")
    pair = await a.api("POST", "/api/agents/pair", json={"name": "Zeep 的 Claude"})
    assert "/connect/" in pair["command"] and pair["command"].startswith("node -e")
    assert (await a.api("GET", f"/api/agents/pair/{pair['code']}"))["status"] == "waiting"
    await b.api("GET", f"/api/agents/pair/{pair['code']}", expect=404)
    script = (await a.http.get(f"/connect/{pair['code']}")).text
    assert "agentwork.mjs" in script and pair["code"] in script
    src = (await a.http.get("/agentwork.mjs")).text
    assert src == CONNECTOR.read_text(encoding="utf8")
    home = TMP / "zeep-pc"
    m = a.mark()
    conn = start_connector(home, "--server", BASE, "--code", pair["code"])
    ev = await a.wait(lambda e: e["type"] == "agent" and e["agent"]["online"], since=m)
    aid = ev["agent"]["id"]
    st = await a.api("GET", f"/api/agents/pair/{pair['code']}")
    assert st["status"] == "connected" and st["agent"]["owner"]["name"] == "Zeep"
    r = await a.http.post("/api/connector/claim", json={"code": pair["code"]})
    assert r.status_code == 400  # one-time code
    assert (await a.api("GET", "/api/bootstrap"))["my_agents"][0]["online"] is True
    ok("一次性接入码、连接程序认领、网页看到「已连接」")

    await b.api("POST", f"/api/chats/{cid}/agents", json={"agent_id": aid}, expect=403)
    m = b.mark()
    await a.api("POST", f"/api/chats/{cid}/agents", json={"agent_id": aid})
    await b.wait(lambda e: e["type"] == "chat_changed", since=m)
    assert len((await b.api("GET", f"/api/chats/{cid}"))["agents"]) == 2
    ok("只有主人能把自己的 agent 拉进群")

    m = a.mark()
    await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 Claude 看看报告目录", "mentions": [aid]})
    await a.wait(lambda e: e["type"] == "step", since=m)
    done = await reply_done(a, m, aid)
    assert done["status"] == "done" and done["meta"]["mode"] == "owner" and "主人" in done["text"]
    assert len(done["meta"]["steps"]) >= 2 and done["meta"]["owner"] == "Zeep"
    notes = list((home / "work").glob("*/模拟笔记.md"))
    assert len(notes) == 1 and "看看报告目录" in notes[0].read_text(encoding="utf8")
    ok("主人 @：owner 模式，有步骤，能写工作文件夹")

    m = b.mark()
    await b.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 Claude 帮我也看看", "mentions": [aid]})
    done = await reply_done(b, m, aid)
    assert done["status"] == "done" and done["meta"]["mode"] == "guest" and "借用" in done["text"]
    assert notes[0].read_text(encoding="utf8").count("\n") == 1  # nothing written for the guest
    ok("队友 @：guest 模式（借用，只读）")

    m = b.mark()
    out = await a.api("PATCH", f"/api/agents/{aid}", json={"share": "me"})
    assert out["share"] == "me"
    await b.wait(lambda e: e["type"] == "agent" and e["agent"]["share"] == "me", since=m)
    await b.api("PATCH", f"/api/agents/{aid}", json={"share": "team"}, expect=404)
    m = b.mark()
    await b.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 Claude 再帮我一下", "mentions": [aid]})
    done = await reply_done(b, m, aid)
    assert done["meta"].get("declined") and "只听 Zeep" in done["text"]
    m = a.mark()
    await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 Claude 我自己还能用吧", "mentions": [aid]})
    assert (await reply_done(a, m, aid))["meta"]["mode"] == "owner"
    await a.api("PATCH", f"/api/agents/{aid}", json={"share": "team", "name": "Zeep 的 CC"})
    ok("开关「只有我能 @」：队友被婉拒，主人照常；改名")

    print("离线排队")
    m = a.mark()
    conn.terminate()
    conn.wait(timeout=5)
    await a.wait(lambda e: e["type"] == "agent" and not e["agent"]["online"], since=m)
    m = b.mark()
    await b.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 CC 你在吗", "mentions": [aid]})
    q = await b.wait(lambda e: e["type"] == "message" and e["message"]["author_type"] == "agent", since=m)
    assert q["message"]["status"] == "queued" and q["message"]["meta"]["owner"] == "Zeep"
    conn = start_connector(home)  # no args: uses the saved config
    await b.wait(lambda e: e["type"] == "message_update" and e["message"]["id"] == q["message"]["id"]
                 and e["message"]["status"] == "thinking", since=m)
    done = await reply_done(b, m, aid)
    assert done["status"] == "done" and done["id"] == q["message"]["id"] and done["meta"]["mode"] == "guest"
    ok("电脑不在线 → 排队；连接程序不带参数重连 → 自动开始并做完")

    second = start_connector(home)  # the same agent connects again: the old one bows out, the agent stays online
    assert conn.wait(timeout=10) == 0
    conn = second
    await asyncio.sleep(0.3)
    assert (await a.api("GET", "/api/bootstrap"))["my_agents"][0]["online"] is True
    ok("同一个 agent 连了两次：旧的自己退出，新的接手")

    m = a.mark()
    await a.api("POST", f"/api/chats/{cid}/messages", json={"text": "@Zeep 的 CC 干到一半会怎样", "mentions": [aid]})
    await a.wait(lambda e: e["type"] == "delta", since=m)
    conn.kill()
    conn.wait(timeout=5)
    done = await reply_done(a, m, aid)
    assert done["status"] == "error" and "断开" in done["text"]
    ok("干到一半电脑断开 → 明确报错，不会一直转圈")

    print("通讯录、退群、删除")
    people = (await b.api("GET", "/api/contacts"))["people"]
    assert people[0]["name"] == "Zeep" and people[0]["agents"][0]["name"] == "Zeep 的 CC"
    await b.api("DELETE", f"/api/chats/{cid}/agents/{aid}", expect=403)
    await b.api("DELETE", f"/api/chats/{cid}/agents/{helper['id']}", expect=400)
    await a.api("PATCH", f"/api/chats/{cid}", json={"name": "毕设群"})
    m = b.mark()
    await b.api("POST", f"/api/chats/{cid}/leave")
    await b.wait(lambda e: e["type"] == "chat_changed", since=m)
    assert (await b.api("GET", "/api/bootstrap"))["chats"] == []
    await b.api("POST", f"/api/chats/{cid}/messages", json={"text": "还能发吗"}, expect=404)
    ok("通讯录、权限、改群名、退群")

    conn = start_connector(home)
    m = a.mark()
    await a.wait(lambda e: e["type"] == "agent" and e["agent"]["online"], since=m)
    await a.api("DELETE", f"/api/agents/{aid}")
    await a.wait(lambda e: e["type"] == "my_agents_changed", since=m)
    assert conn.wait(timeout=5) == 0  # the connector is told and exits by itself
    assert (await a.api("GET", "/api/bootstrap"))["my_agents"] == []
    assert not (home / "cfg" / "config.json").exists()
    ok("删除 agent：连接程序收到通知自己退出")

    await a.api("POST", "/api/logout")
    await a.api("GET", "/api/bootstrap", expect=401)
    ok("退出登录")

    await a.close()
    await b.close()


def run() -> int:
    env = {**os.environ, "AGENTWORK_FAKE_AI": "1", "AGENTWORK_DATA": str(TMP / "data")}
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.main:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=ROOT, env=env)
    try:
        for _ in range(100):
            try:
                httpx.get(BASE + "/api/bootstrap", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        asyncio.run(main())
        print(f"\n全部通过（{passed} 组）")
        return 0
    except AssertionError as e:
        import traceback
        traceback.print_exc()
        print(f"\n失败：{e}")
        return 1
    finally:
        server.terminate()
        server.wait(timeout=5)
        subprocess.run(["pkill", "-f", str(TMP)], check=False) if os.name != "nt" else None
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(run())
