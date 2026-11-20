# Handoff: finish the agentwork MVP overnight

For the session that picks this up (cloud or local). Zeep is asleep and will not answer questions: decide sensibly and write down what you decided. He accepts the result tomorrow morning on his Windows 11 PC.

## Background

agentwork is Zeep's new startup idea (Manchester CS student; team: 尹昊, maybe 陈宇涵). It's a Pachat-like group chat where people and everyone's agents are members. The selling point he chose is sharing: "my Claude Code must be usable by others, and theirs by me". Teammates @ your agent in a group and it works on your computer, read-only for borrowers. No manager agent, no task/review cards (he found those too complex). Look and feel: imitate Pachat (pachat.ai) and WeChat desktop overall. Octo (Mininglamp-OSS) is too heavy to fork; we only borrow its patterns: long-lived agent connections, `--permission-mode`, `--resume`.

His machine: Windows 11, Node 22.14, Python 3.13, Claude Code 2.1.84 CLI installed but **not logged in**, **no `ANTHROPIC_API_KEY`** locally.

## Read first

`docs/mvp.md` (the plan, in Chinese; follow it), `README.md`, then everything in `server/`.

Already on `mvp` (commit 98f98bc; imports fine; never run yet):

- `server/db.py`: SQLite schema with users, sessions, agents, chats, chat_members, chat_agents, messages and pair_codes.
- `server/hub.py`: WebSocket registry.
- `server/agents.py`: what happens on @.
  - The built-in 「助手」 runs through the Claude API, or the local `claude` CLI, or a fake mode (`AGENTWORK_FAKE_AI=1`).
  - Jobs go to connectors and queue while the connector is offline.
  - When a teammate borrows someone's agent, it runs read-only ("guest" mode).
- `server/main.py`, a FastAPI app:
  - register/login with cookie auth; `/api/bootstrap`
  - chats CRUD; messages take `mentions:[agent_id]`
  - invites at `/api/invite/{code}`; contacts
  - pairing: `/api/agents/pair` returns a one-line command, `node -e "fetch('<base>/connect/<code>').then(r=>r.text()).then(eval)"`; that hits the `/connect/{code}` bootstrap, which saves `/agentwork.mjs` to `~/.agentwork/` and runs it; the connector then calls `/api/connector/claim`
  - browser WS at `/ws`, connector WS at `/agent-ws`
  - SPA served from `web/dist`

Fix bugs you find.

## To do, in order

1. **Run the server and test the API.**
   - Run from the repo root: `python -m uvicorn server.main:app --port 8787`. Deps are in `server/requirements.txt`.
   - Script a test:
     - two accounts
     - create a chat, invite/join
     - send messages; @助手 in fake mode
     - check that these WS events arrive: `message`, `message_update`, `delta`, `step`, `status`, `chat_changed`, `agent`
2. **`web/`**: React + TypeScript + Vite, built to `web/dist`.
   - Chinese UI. No CDNs or Google Fonts (users are in China); system fonts only (PingFang SC / Microsoft YaHei / system-ui). Clean and calm, like Pachat / WeChat desktop.
   - **Left narrow rail**: my avatar; my agents, each with a green online dot; 「＋ 接入 agent」; logout at the bottom.
   - **Second column**:
     - tabs 「聊天 / 通讯录」
     - chat list rows: avatar, name, last-message preview, time, unread badge
     - 「＋ 建群」
   - **Chat pane header**: 「群名 · N 个 agent · M 人」, with 「邀请」 and 「成员」 buttons.
   - **Messages**: avatars; agent messages tagged 「Zeep 的 agent」 or 「内置」.
   - **Agent reply states**:
     - queued: 「排队中：Zeep 的电脑不在线，上线后自动开始」
     - thinking: 「正在想…」
     - streaming: text plus tool steps (e.g. 「在读 src/app.py」)
     - done footer: 「在 Zeep 的电脑上完成 · 用时 40 秒」
     - guest-mode note: 「借用」
     - Render agent replies as sanitized markdown.
   - **Composer**:
     - placeholder 「以你自己的身份说点什么，@ 叫 agent 干活」
     - typing `@` pops up the chat's agents and people; each agent shows its online state, plus 「只听主人的」 when share=me
     - Enter sends; Shift+Enter is a newline
   - **Members drawer**:
     - agents with owner and online state; a share toggle for my own
     - people
     - 「把我的 agent 拉进群」
     - leave group
   - **Modals**:
     - 建群
     - 邀请: copy link `/invite/<code>`, which opens a page to join
     - 接入 agent: name → command with a copy button → poll `/api/agents/pair/{code}` → 「已连接 ✓」
     - agent settings: rename, 「群里谁都能 @ / 只有我能 @」, delete
   - Login/register page.
   - WS reconnects with backoff and pings every 25s.
   - Make it feel finished: empty states, loading, errors, scroll-to-bottom, unread handling, light and dark mode.
3. **`connector/agentwork.mjs`**: Node 22, one file, zero dependencies (global `fetch` and `WebSocket`).
   - Args: `--server`, `--code`, optional `--dir` (work folder), `--fake` (simulate Claude Code for tests).
   - Claim with the code, then save `{server, agent_id, token, name}` to `~/.agentwork/config.json`. Later runs need no args.
   - Protocol on WS `/agent-ws`:
     - First message: `{type:'auth', token, machine, workdir}`.
     - Server sends:
       - `ready`
       - `job` `{job_id, chat_id, chat_name, mode:'owner'|'guest', requester, prompt}`
       - `revoked`
       - `replaced`
     - Connector sends:
       - `delta {job_id,text}`
       - `step {job_id,step}`
       - `done {job_id,text,cost_usd,turns}`
       - `error {job_id,error}`
       - `ping` every 20s
     - Reconnect with backoff.
   - Run Claude Code as `claude -p --output-format stream-json --verbose --include-partial-messages --strict-mcp-config`.
     - The prompt goes on STDIN only, never in argv.
     - On Windows, `spawn` needs `shell:true` because the command is `claude.cmd`. argv stays fixed flags, so this is safe.
   - Owner mode: `--permission-mode acceptEdits`.
   - Guest mode: `--tools Read,Glob,Grep,WebSearch,WebFetch --allowedTools Read,Glob,Grep,WebSearch,WebFetch --permission-mode dontAsk`.
   - One session per chat:
     - Remember `session_id` per chat (from the `system/init` or `result` event) in `~/.agentwork/sessions.json`.
     - Pass `--resume <id>` next time. If resume fails, retry once without it.
   - Work folder per chat is `~/agentwork/<chat_id>-<safe name>`, unless `--dir` is given.
   - Stream output:
     - `stream_event` text deltas → `delta`
     - `tool_use` blocks in `assistant` events → short Chinese `step`s
     - the `result` event's `result` → the final `done` text
   - Errors and limits:
     - If the result says not logged in (the CLI prints "Not logged in · Please run /login"), send an error telling the owner to run `claude` and then `/login`.
     - At most 2 jobs at once, one at a time per chat, 15-minute timeout.
     - Print friendly Chinese status lines.
4. **Start scripts and seed data.**
   - `start.cmd` (Windows, double-click):
     - creates `.venv` and pip-installs if missing
     - builds `web` if `web/dist` is missing (`npm install` + `npm run build`)
     - runs the seed script if the DB is empty
     - starts uvicorn on 8787 and opens `http://localhost:8787`
   - `start.sh` does the same on Mac/Linux.
   - `server/seed.py`:
     - two test accounts, Zeep and 尹昊, with made-up example.com emails and random passwords written to the gitignored `test-accounts.txt`
     - a 「测试群」 with both of them and a few messages
5. **End-to-end test in fake mode**, with two accounts and a fake connector:
   - @助手
   - @ the connector agent as its owner, then from the other account (guest mode)
   - offline queue, then connect
   - share=me refusal
   - invite flow
   - reload mid-stream
   - If you can drive a headless browser (e.g. Playwright), screenshot the main screens and fix the layout until it looks good. Iterate several rounds.
6. **Write `docs/验收.md`** in plain Chinese:
   - what was built, how to start it, the test accounts
   - the one-time step for real use: run `claude` then `/login` once, or put `ANTHROPIC_API_KEY` in `.env`. Without either, the built-in helper says so in the chat.
   - how to try borrowing with two browser windows
   - what is not done, and known issues
   - Update `docs/mvp.md` if the design changed.

## Commits

- Author `MOLIYUANQUAN <157371981+MOLIYUANQUAN@users.noreply.github.com>`. No Co-Authored-By lines, and nothing in messages that mentions AI tools; match the existing history.
- Commit in small steps and push `mvp` regularly.
- Never push to or merge into `main`. No PR needed.
