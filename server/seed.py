"""First-run data: two test accounts and a 「测试群」, so there is something to click on.

Run:  python -m server.seed        (does nothing if the database already has users)
Passwords are random and written to test-accounts.txt, which git ignores.
"""
from __future__ import annotations

import os
import secrets
import time
from pathlib import Path

from . import db

ACCOUNTS_FILE = Path(os.getenv("AGENTWORK_ACCOUNTS_FILE") or db.ROOT / "test-accounts.txt")
PEOPLE = [("Zeep", "zeep@example.com"), ("尹昊", "yinhao@example.com")]


def _password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))


def seed() -> bool:
    if db.one("SELECT 1 FROM users LIMIT 1"):
        return False
    ids, lines = [], ["agentwork 测试账号（本机用，随机生成；这个文件不会进 git）", ""]
    for name, email in PEOPLE:
        pw = _password()
        ids.append(db.create_user(name, email, pw))
        lines += [f"{name}", f"  邮箱：{email}", f"  密码：{pw}", ""]
    lines.append("登录地址：http://localhost:8787")
    ACCOUNTS_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

    zeep, yinhao = ids
    helper = db.builtin_agent()
    t = time.time() - 26 * 60
    cid = db.run("INSERT INTO chats(name, created_by, invite_code, created) VALUES(?,?,?,?)",
                 ("测试群", zeep, secrets.token_urlsafe(6), t))
    for uid in ids:
        db.run("INSERT INTO chat_members(chat_id, user_id, joined) VALUES(?,?,?)", (cid, uid, t))
    db.run("INSERT INTO chat_agents(chat_id, agent_id, added_by, added) VALUES(?,?,?,?)", (cid, helper["id"], zeep, t))

    def say(author_type: str, author_id: int | None, text: str, after: float) -> int:
        return db.run(
            "INSERT INTO messages(chat_id, author_type, author_id, text, status, created) VALUES(?,?,?,?, 'done', ?)",
            (cid, author_type, author_id, text, t + after),
        )

    say("system", None, "Zeep 建了群「测试群」。@助手 随时可以叫它帮忙。", 0)
    say("system", None, "尹昊 加入了群", 20)
    say("user", zeep, "这是我们试 agentwork 的群。人直接打字，打 @ 就能叫 agent 干活。", 60)
    say("user", yinhao, "收到。我的想法是第一版先把「互相借 agent」跑通，周五前给三个同学试用。", 150)
    say("user", zeep, "行。我一会儿把我的 Claude Code 接进来，你 @ 它试试，看是不是只能看、不能改。", 240)
    last = say("user", yinhao, "好，那我先问问助手周五前要准备什么。", 300)
    db.run("UPDATE chat_members SET last_read=? WHERE chat_id=?", (last, cid))
    return True


if __name__ == "__main__":
    if seed():
        print(f"建好了两个测试账号和「测试群」。账号密码在 {ACCOUNTS_FILE}")
    else:
        print("数据库里已经有账号了，没有动。")
