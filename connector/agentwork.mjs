#!/usr/bin/env node
// agentwork 连接程序：把这台电脑上的 Claude Code 接进 agentwork 的群聊。
// 单文件、零依赖，需要 Node 22+（用自带的 fetch 和 WebSocket）。
//
//   第一次：node agentwork.mjs --server http://localhost:8787 --code ABCD-EFGH
//   以后：  node agentwork.mjs
//
// 可选：--dir <文件夹>  所有群都在这个文件夹里干活（默认每个群一个文件夹，在 ~/agentwork-files/ 下）
//       --allow-commands  主人 @ 时允许它运行命令（默认不允许；--no-commands 改回去）
//       --fake          不真的调用 Claude Code，用来测试整条链路
//
// 权限写死在这里，不靠提示词：
//   主人 @  → 可以读、改工作文件夹里的文件（--permission-mode acceptEdits），默认不能跑命令
//   别人借用 → 只有读文件、搜索、查网页这几样工具，而且只能读工作文件夹里的东西

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = process.env.AGENTWORK_HOME || path.join(os.homedir(), '.agentwork');
const CONFIG_FILE = path.join(HOME, 'config.json');
const SESSIONS_FILE = path.join(HOME, 'sessions.json');
// 不叫 ~/agentwork：很多人会把这个仓库就克隆在那里
const WORK_ROOT = process.env.AGENTWORK_WORK || path.join(os.homedir(), 'agentwork-files');
const MAX_JOBS = 2;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const GUEST_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';

// ---------------------------------------------------------------- small helpers

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fake') out.fake = true;
    else if (a === '--allow-commands') out.allowCommands = true;
    else if (a === '--no-commands') out.allowCommands = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--') && i + 1 < argv.length) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function log(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}] ${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function short(s, n = 60) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\s.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'chat';
}

// ---------------------------------------------------------------- setup

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`agentwork 连接程序
  第一次：node agentwork.mjs --server <网址> --code <接入码>   （接入码在网页上点「接入 agent」拿）
  以后：  node agentwork.mjs
  可选：  --dir <文件夹>      所有群都在这个文件夹里干活
          --allow-commands    主人 @ 时允许它运行命令（默认不允许）
          --fake              模拟回答，不真的调用 Claude Code`);
  process.exit(0);
}

let config = readJson(CONFIG_FILE, null);

async function claim() {
  const server = String(args.server || '').replace(/\/+$/, '');
  if (!server) {
    console.error('缺少 --server。回网页点「接入 agent」，把那一整条命令复制过来运行。');
    process.exit(1);
  }
  let res;
  try {
    res = await fetch(server + '/api/connector/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: args.code, machine: os.hostname(), workdir: args.dir ? path.resolve(args.dir) : WORK_ROOT }),
    });
  } catch (e) {
    console.error(`连不上 ${server}：${e.message}。确认 agentwork 服务开着。`);
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(data.error || `接入失败（${res.status}）`);
    process.exit(1);
  }
  config = { server, agent_id: data.agent_id, token: data.token, name: data.name, owner: data.owner };
  if (args.dir) config.dir = path.resolve(args.dir);
  if (args.allowCommands) config.allowCommands = true;
  writeJson(CONFIG_FILE, config);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows */ }
  log(`接入成功：「${data.name}」现在是 ${data.owner} 的 agent。`);
}

if (args.code) {
  await claim();
} else if (!config) {
  console.error('还没接入过。回网页点「接入 agent」，把那条命令复制过来运行。');
  process.exit(1);
} else if (args.dir || args.allowCommands !== undefined) {
  if (args.dir) config.dir = path.resolve(args.dir);
  if (args.allowCommands !== undefined) config.allowCommands = args.allowCommands;
  writeJson(CONFIG_FILE, config);
}

let fake = !!args.fake;
const sessions = readJson(SESSIONS_FILE, {});

function workdirFor(job) {
  const dir = config.dir || path.join(WORK_ROOT, `${job.chat_id}-${safeName(job.chat_name)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- talking to the server

let ws = null;
let backoff = 1000;
let pingTimer = null;
let stopped = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function connect() {
  const url = config.server.replace(/^http/, 'ws') + '/agent-ws';
  ws = new WebSocket(url);
  const mine = ws;
  ws.addEventListener('open', () => {
    send({ type: 'auth', token: config.token, machine: os.hostname(), workdir: config.dir || WORK_ROOT });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onServer(msg);
  });
  ws.addEventListener('close', () => {
    if (mine !== ws) return;
    clearInterval(pingTimer);
    if (stopped) return;
    log(`和服务器断开了，${Math.round(backoff / 1000)} 秒后重连…`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  });
  ws.addEventListener('error', () => { /* close 事件里统一处理 */ });
}

function onServer(msg) {
  switch (msg.type) {
    case 'ready':
      backoff = 1000;
      if (msg.fake && !fake) {
        fake = true;
        log('服务器在模拟模式，这边也用模拟回答（不会真的调用 Claude Code）。');
      } else if (!msg.fake && fake && !args.fake) {
        fake = false;
      }
      log(`已连接 ✓ 「${msg.name}」在线了（主人：${msg.owner}）${fake ? ' [模拟模式]' : ''}`);
      log(`工作文件夹：${config.dir || path.join(WORK_ROOT, '<每个群一个>')}。主人 @ 时${config.allowCommands ? '可以' : '不能'}运行命令。`);
      log('这个窗口开着，agent 就在线；Ctrl+C 下线。');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
      break;
    case 'job':
      enqueue(msg);
      break;
    case 'revoked':
    case 'auth_failed':
      stopped = true;
      log(msg.error || '这个 agent 已经在网页上被删掉了。要再用，回网页重新点「接入 agent」。');
      try { fs.unlinkSync(CONFIG_FILE); } catch { /* 已经没了 */ }
      process.exit(0);
      break;
    case 'replaced':
      stopped = true;
      log('同一个 agent 在别处又连了一次，这边下线。');
      process.exit(0);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- job queue: 2 at once, 1 per chat

const waiting = [];
const running = new Map(); // job_id -> chat_id

function enqueue(job) {
  waiting.push(job);
  pump();
}

function pump() {
  for (let i = 0; i < waiting.length && running.size < MAX_JOBS;) {
    const job = waiting[i];
    if ([...running.values()].includes(job.chat_id)) { i++; continue; }
    waiting.splice(i, 1);
    running.set(job.job_id, job.chat_id);
    runJob(job).catch((e) => {
      send({ type: 'error', job_id: job.job_id, error: `连接程序出错：${e.message}` });
    }).finally(() => {
      running.delete(job.job_id);
      pump();
    });
  }
}

async function runJob(job) {
  const who = job.mode === 'guest' ? `${job.requester}（借用，只读）` : `${job.requester}（主人）`;
  log(`「${job.chat_name}」里 ${who} 叫我干活…`);
  const t0 = Date.now();
  const r = fake ? await runFake(job) : await runClaude(job);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (r.error) {
    log(`没做成（${secs} 秒）：${short(r.error, 100)}`);
    send({ type: 'error', job_id: job.job_id, error: r.error });
  } else {
    log(`做完了（${secs} 秒）。`);
    send({ type: 'done', job_id: job.job_id, text: r.text, cost_usd: r.cost_usd, turns: r.turns });
  }
}

// ---------------------------------------------------------------- the real thing: headless Claude Code

function claudeArgs(mode, resumeId) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--strict-mcp-config'];
  if (mode === 'owner') {
    // 主人：能读、能改工作文件夹里的文件（acceptEdits 只自动同意工作文件夹里的改动）。
    // 默认不给跑命令的工具：群里别人说的话也会进提示词，不能让一句话变成你电脑上的一条命令。
    // 想放开，启动时加 --allow-commands。
    a.push('--permission-mode', 'acceptEdits');
    if (!config.allowCommands) a.push('--disallowedTools', 'Bash');
  } else {
    // 借用：只有这几样只读工具存在；dontAsk = 没明确允许的一律拒绝。
    // 读文件不放进 allowedTools，所以只能读工作文件夹里的，读不到主人电脑上别处的文件。
    a.push('--tools', GUEST_TOOLS, '--allowedTools', 'WebSearch,WebFetch', '--permission-mode', 'dontAsk');
  }
  if (resumeId && /^[0-9a-f-]{8,64}$/i.test(resumeId)) a.push('--resume', resumeId);
  return a;
}

function relPath(p, cwd) {
  if (!p) return '';
  const rel = path.relative(cwd, String(p));
  return short(rel && !rel.startsWith('..') ? rel : String(p), 70);
}

function describeTool(name, input, cwd) {
  input = input || {};
  switch (name) {
    case 'Read': return `在读 ${relPath(input.file_path, cwd)}`;
    case 'Glob': return `在找文件 ${short(input.pattern, 50)}`;
    case 'Grep': return `在搜索「${short(input.pattern, 40)}」`;
    case 'WebSearch': return `在搜网页：${short(input.query, 50)}`;
    case 'WebFetch': {
      let host = String(input.url || '');
      try { host = new URL(host).host; } catch { /* 原样显示 */ }
      return `在看网页 ${short(host, 50)}`;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `在改 ${relPath(input.file_path || input.notebook_path, cwd)}`;
    case 'Write': return `在写 ${relPath(input.file_path, cwd)}`;
    case 'Bash': return `在运行命令：${short(input.command, 50)}`;
    case 'Task':
    case 'Agent': return '在分头查';
    case 'TodoWrite': return null;
    default: return `在用 ${name}`;
  }
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* 已经退出 */ }
}

const NOT_LOGGED_IN = '这台电脑上的 Claude Code 还没登录。请主人在终端运行 `claude`，输入 `/login` 登录一次，然后再 @ 我。';
const NOT_INSTALLED = '这台电脑上没找到 `claude` 命令。请主人先安装 Claude Code（`npm install -g @anthropic-ai/claude-code`），再 @ 我。';

function looksNotLoggedIn(s) {
  return /not logged in|\/login|invalid api key|authentication_error|oauth token/i.test(s || '');
}

function looksNotInstalled(s) {
  return /is not recognized|command not found|不是内部或外部命令|ENOENT/i.test(s || '');
}

function claudeOnce(job, cwd, resumeId) {
  return new Promise((resolve) => {
    let child;
    try {
      const argv = claudeArgs(job.mode, resumeId);
      const opts = { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
      // Windows 上 claude 可能是 claude.cmd，要经过 shell。参数全是固定的开关（没有空格、没有用户输入），
      // 提示词只走 stdin，所以拼成一条命令是安全的。
      child = process.platform === 'win32'
        ? spawn('claude ' + argv.join(' '), { ...opts, shell: true })
        : spawn('claude', argv, opts);
    } catch (e) {
      resolve({ error: looksNotInstalled(e.message) ? NOT_INSTALLED : `启动 Claude Code 失败：${e.message}` });
      return;
    }

    let buf = '';
    let plain = ''; // stdout 里不是 JSON 的行（比如「Not logged in」）
    let sawEvent = false;
    let stderr = '';
    let result = null;
    let sessionId = null;
    let sentText = false;
    let needBreak = false;
    let finished = false;

    const finish = (out) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ...out, sessionId, sentText });
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ error: '干了 15 分钟还没完，我先停了。把活拆小一点再 @ 我。' });
    }, JOB_TIMEOUT_MS);

    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      let ev;
      try { ev = JSON.parse(line); } catch { plain = (plain + '\n' + line).slice(-2000); return; }
      if (ev && typeof ev === 'object') { sawEvent = true; onEvent(ev); }
    };

    const onEvent = (ev) => {
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
        const e = ev.event || {};
        if (e.type === 'message_start' && sentText) needBreak = true;
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          const text = (needBreak ? '\n\n' : '') + e.delta.text;
          needBreak = false;
          sentText = true;
          send({ type: 'delta', job_id: job.job_id, text });
        }
      } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        for (const block of ev.message?.content || []) {
          if (block.type !== 'tool_use') continue;
          const step = describeTool(block.name, block.input, cwd);
          if (step) send({ type: 'step', job_id: job.job_id, step });
        }
      } else if (ev.type === 'result' || (ev.result !== undefined && ev.total_cost_usd !== undefined)) {
        result = ev;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });

    child.on('error', (e) => {
      finish({ error: e.code === 'ENOENT' ? NOT_INSTALLED : `启动 Claude Code 失败：${e.message}` });
    });

    child.on('close', (code) => {
      onLine(buf);
      if (result) {
        const text = String(result.result ?? '').trim();
        if (result.is_error) {
          if (looksNotLoggedIn(text)) finish({ error: NOT_LOGGED_IN });
          else finish({ error: `Claude Code 报错：${short(text || result.subtype || '未知错误', 300)}`, resumeFailed: true });
        } else {
          finish({ text: text || null, cost_usd: result.total_cost_usd, turns: result.num_turns });
        }
        return;
      }
      const all = stderr + ' ' + plain;
      if (looksNotLoggedIn(all)) finish({ error: NOT_LOGGED_IN });
      else if (looksNotInstalled(all)) finish({ error: NOT_INSTALLED });
      // 中文 Windows 上「不是内部或外部命令」是 GBK 编码，认不出来；没有任何输出就退出，多半是没装
      else if (process.platform === 'win32' && !sawEvent && (code === 1 || code === 9009)) finish({ error: NOT_INSTALLED });
      else finish({ error: `Claude Code 提前退出了（代码 ${code}）。${short(stderr, 200)}`, resumeFailed: true });
    });

    child.stdin.on('error', () => { /* 进程没起来时写 stdin 会报错，close 里统一处理 */ });
    child.stdin.end(job.prompt, 'utf8');
  });
}

async function runClaude(job) {
  const cwd = workdirFor(job);
  // 主人和借用的人各用各的会话：借用的人说的话，不会进到「能改文件」的那个会话里。
  const key = `${config.agent_id}:${job.chat_id}:${job.mode}`;
  const resumeId = sessions[key];
  let r = await claudeOnce(job, cwd, resumeId);
  if (r.error && r.resumeFailed && resumeId && !r.sentText) {
    log('接不上上次的会话，重新开一个。');
    delete sessions[key];
    r = await claudeOnce(job, cwd, null);
  }
  if (!r.error && r.sessionId) {
    sessions[key] = r.sessionId;
    writeJson(SESSIONS_FILE, sessions);
  }
  return r;
}

// ---------------------------------------------------------------- fake mode, for testing the whole pipeline

async function runFake(job) {
  const cwd = workdirFor(job);
  const id = job.job_id;
  const asked = short((job.prompt.match(/@ 了你：\n([\s\S]*?)\n\n/) || [])[1] || '', 80);
  await sleep(600);
  send({ type: 'step', job_id: id, step: '在找文件 **/*.md' });
  await sleep(500);
  send({ type: 'step', job_id: id, step: '在读 README.md' });
  await sleep(500);
  let tail;
  if (job.mode === 'owner') {
    const note = path.join(cwd, '模拟笔记.md');
    fs.appendFileSync(note, `- ${new Date().toLocaleString('zh-CN')} ${job.requester}：${asked}\n`);
    send({ type: 'step', job_id: id, step: '在写 模拟笔记.md' });
    await sleep(400);
    tail = `这次是主人 **${job.requester}** 叫我，我可以改工作文件夹里的文件：刚往 \`${note}\` 里记了一行。`;
  } else {
    tail = `这次是 **${job.requester}** 借用我，所以我**只能看和回答**，不能改文件、不能跑命令。要改东西，请我的主人来 @ 我。`;
  }
  const reply = `收到：「${asked}」\n\n这是**模拟模式**的回答，没有真的调用 Claude Code。\n\n- 工作文件夹：\`${cwd}\`\n- ${tail}\n\n登录 Claude Code 之后，这里就是它真正的回答。`;
  for (let i = 0; i < reply.length; i += 5) {
    send({ type: 'delta', job_id: id, text: reply.slice(i, i + 5) });
    await sleep(35);
  }
  return { text: reply, cost_usd: 0, turns: 1 };
}

// ---------------------------------------------------------------- go

process.on('SIGINT', () => {
  stopped = true;
  log('下线了。再运行一次这个程序就能重新上线。');
  try { ws?.close(); } catch { /* 无所谓 */ }
  setTimeout(() => process.exit(0), 100);
});

log(`正在连接 ${config.server} …`);
connect();
