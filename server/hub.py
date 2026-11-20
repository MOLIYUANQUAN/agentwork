"""Who is connected right now: browsers (per user) and connectors (per agent)."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket

from . import db


class Hub:
    def __init__(self) -> None:
        self.browsers: dict[int, set[WebSocket]] = {}
        self.connectors: dict[int, WebSocket] = {}

    # ---- browsers ----
    def add_browser(self, user_id: int, ws: WebSocket) -> None:
        self.browsers.setdefault(user_id, set()).add(ws)

    def drop_browser(self, user_id: int, ws: WebSocket) -> None:
        conns = self.browsers.get(user_id)
        if conns:
            conns.discard(ws)
            if not conns:
                self.browsers.pop(user_id, None)

    async def to_user(self, user_id: int, payload: dict[str, Any]) -> None:
        conns = list(self.browsers.get(user_id, ()))
        if not conns:
            return
        text = json.dumps(payload, ensure_ascii=False)
        results = await asyncio.gather(*(ws.send_text(text) for ws in conns), return_exceptions=True)
        for ws, r in zip(conns, results):
            if isinstance(r, Exception):
                self.drop_browser(user_id, ws)

    async def to_users(self, user_ids: list[int] | set[int], payload: dict[str, Any]) -> None:
        await asyncio.gather(*(self.to_user(uid, payload) for uid in set(user_ids)))

    async def to_chat(self, chat_id: int, payload: dict[str, Any]) -> None:
        await self.to_users(db.chat_member_ids(chat_id), payload)

    async def to_everyone_who_sees_agent(self, agent_id: int, payload: dict[str, Any]) -> None:
        rows = db.q(
            "SELECT DISTINCT cm.user_id FROM chat_members cm JOIN chat_agents ca ON ca.chat_id=cm.chat_id WHERE ca.agent_id=?",
            (agent_id,),
        )
        ids = {r["user_id"] for r in rows}
        owner = db.one("SELECT owner_id FROM agents WHERE id=?", (agent_id,))
        if owner and owner["owner_id"]:
            ids.add(owner["owner_id"])
        await self.to_users(ids, payload)

    # ---- connectors ----
    def online(self, agent_id: int) -> bool:
        return agent_id in self.connectors

    async def to_connector(self, agent_id: int, payload: dict[str, Any]) -> bool:
        ws = self.connectors.get(agent_id)
        if not ws:
            return False
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except Exception:
            self.connectors.pop(agent_id, None)
            return False


hub = Hub()
