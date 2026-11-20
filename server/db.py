"""SQLite storage. One file under data/, one connection guarded by a lock.

Small team, one process: plain sqlite3 is plenty and keeps the MVP easy to run.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("AGENTWORK_DATA") or ROOT / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "agentwork.db"

_lock = threading.RLock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA foreign_keys=ON")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  color TEXT NOT NULL,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created REAL NOT NULL
);
-- kind: 'builtin' (one per server, no owner) or 'claude_code' (runs on its owner's computer)
-- share: 'team' = anyone in a shared group can @ it; 'me' = only the owner
CREATE TABLE IF NOT EXISTS agents(
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  share TEXT NOT NULL DEFAULT 'team',
  token_hash TEXT,
  machine TEXT,
  workdir TEXT,
  created REAL NOT NULL,
  last_seen REAL
);
CREATE TABLE IF NOT EXISTS chats(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members(
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined REAL NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_agents(
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  added_by INTEGER,
  added REAL NOT NULL,
  PRIMARY KEY(chat_id, agent_id)
);
-- author_type: 'user' | 'agent' | 'system'
-- status (agent replies): 'queued' | 'thinking' | 'streaming' | 'done' | 'error'
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id INTEGER,
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'done',
  reply_to INTEGER,
  requested_by INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL,
  updated REAL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS pair_codes(
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created REAL NOT NULL,
  agent_id INTEGER
);
"""

with _lock:
    _conn.executescript(SCHEMA)


def q(sql: str, args: tuple | list = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql: str, args: tuple | list = ()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def run(sql: str, args: tuple | list = ()) -> int:
    with _lock:
        cur = _conn.execute(sql, args)
        return cur.lastrowid


def now() -> float:
    return time.time()


# ---------- passwords ----------

def hash_pw(pw: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_pw(pw: str, stored: str) -> bool:
    try:
        _, salt, _h = stored.split("$")
        return hmac.compare_digest(hash_pw(pw, bytes.fromhex(salt)), stored)
    except ValueError:
        return False


USER_COLORS = ["#E8590C", "#2F9E44", "#1971C2", "#9C36B5", "#C2255C", "#0C8599", "#5F3DC4", "#E67700"]


def create_user(name: str, email: str, password: str) -> int:
    count = one("SELECT count(*) AS n FROM users")["n"]
    return run(
        "INSERT INTO users(name, email, pw_hash, color, created) VALUES(?,?,?,?,?)",
        (name, email, hash_pw(password), USER_COLORS[count % len(USER_COLORS)], now()),
    )


# ---------- shapes sent to the browser ----------

def user_public(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"], "color": u["color"]}


def agent_public(a: dict, online: bool) -> dict:
    owner = one("SELECT id, name, color FROM users WHERE id=?", (a["owner_id"],)) if a["owner_id"] else None
    return {
        "id": a["id"],
        "name": a["name"],
        "kind": a["kind"],
        "share": a["share"],
        "owner": owner,
        "machine": a["machine"],
        "online": online,
        "last_seen": a["last_seen"],
    }


def message_public(m: dict) -> dict:
    """A message plus who wrote it, so the browser can still show a name after
    the person left the group or the agent was deleted."""
    out = dict(m)
    try:
        meta = json.loads(m.get("meta") or "{}")
    except ValueError:
        meta = {}
    out["meta"] = meta
    author = None
    if m["author_type"] == "user":
        u = one("SELECT id, name, color FROM users WHERE id=?", (m["author_id"],))
        author = {"name": u["name"], "color": u["color"]} if u else {"name": "已注销", "color": "#868e96"}
    elif m["author_type"] == "agent":
        a = one("SELECT name, kind, owner_id FROM agents WHERE id=?", (m["author_id"],))
        if a:
            owner = one("SELECT name, color FROM users WHERE id=?", (a["owner_id"],)) if a["owner_id"] else None
            author = {"name": a["name"], "kind": a["kind"], "owner": owner["name"] if owner else None,
                      "color": owner["color"] if owner else None}
        else:
            author = {"name": meta.get("agent_name") or "已删除的 agent", "kind": meta.get("agent_kind") or "claude_code",
                      "owner": meta.get("owner"), "gone": True}
        if m.get("requested_by"):
            r = one("SELECT name FROM users WHERE id=?", (m["requested_by"],))
            author["requester"] = r["name"] if r else None
    out["author"] = author
    return out


def builtin_agent() -> dict:
    a = one("SELECT * FROM agents WHERE kind='builtin' ORDER BY id LIMIT 1")
    if a:
        return a
    aid = run(
        "INSERT INTO agents(owner_id, name, kind, share, created) VALUES(NULL, '助手', 'builtin', 'team', ?)",
        (now(),),
    )
    return one("SELECT * FROM agents WHERE id=?", (aid,))


def chat_member_ids(chat_id: int) -> list[int]:
    return [r["user_id"] for r in q("SELECT user_id FROM chat_members WHERE chat_id=?", (chat_id,))]


def is_member(chat_id: int, user_id: int) -> bool:
    return one("SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?", (chat_id, user_id)) is not None


def chat_agents(chat_id: int) -> list[dict]:
    return q(
        "SELECT a.* FROM agents a JOIN chat_agents ca ON ca.agent_id=a.id WHERE ca.chat_id=? ORDER BY a.kind='builtin' DESC, ca.added",
        (chat_id,),
    )


def get_message(mid: int) -> dict | None:
    return one("SELECT * FROM messages WHERE id=?", (mid,))


def update_message(mid: int, **fields) -> dict:
    if "meta" in fields and not isinstance(fields["meta"], str):
        fields["meta"] = json.dumps(fields["meta"], ensure_ascii=False)
    fields["updated"] = now()
    cols = ", ".join(f"{k}=?" for k in fields)
    run(f"UPDATE messages SET {cols} WHERE id=?", (*fields.values(), mid))
    return get_message(mid)
