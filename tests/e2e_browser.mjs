// 用真浏览器把整条链路点一遍（模拟模式），顺便截图。
//
//   node tests/e2e_browser.mjs [截图文件夹]
//
// 自己起一个临时服务（端口 8798、全新的数据库、临时测试账号），不碰你正在用的数据。
// 需要 Playwright（npm i -g playwright）和已经构建好的 web/dist。
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT || 8798);
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'agentwork-shots'));
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentwork-home-'));
fs.mkdirSync(SHOTS, { recursive: true });

// ---- 临时服务
const venvPy = [path.join(ROOT, '.venv', 'bin', 'python'), path.join(ROOT, '.venv', 'Scripts', 'python.exe')].find((p) => fs.existsSync(p)) || 'python';
const ACCOUNTS_FILE = path.join(FAKE_HOME, 'accounts.txt');
const serverEnv = { ...process.env, AGENTWORK_FAKE_AI: '1', AGENTWORK_DATA: path.join(FAKE_HOME, 'data'), AGENTWORK_ACCOUNTS_FILE: ACCOUNTS_FILE };
spawnSync(venvPy, ['-m', 'server.seed'], { cwd: ROOT, env: serverEnv, stdio: 'ignore' });
const server = spawn(venvPy, ['-m', 'uvicorn', 'server.main:app', '--port', String(PORT), '--log-level', 'warning'], { cwd: ROOT, env: serverEnv, stdio: 'inherit' });
for (let i = 0; i < 100; i++) {
  try { await fetch(BASE + '/api/bootstrap'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const accounts = {};
{
  const lines = fs.readFileSync(ACCOUNTS_FILE, 'utf8').split('\n');
  let who = null;
  for (const l of lines) {
    if (/^\S/.test(l) && !l.includes('：') && !l.includes('agentwork')) who = l.trim();
    const m = /^\s+(邮箱|密码)：(.+)$/.exec(l);
    if (m && who) (accounts[who] ||= {})[m[1] === '邮箱' ? 'email' : 'password'] = m[2].trim();
  }
}

let n = 0;
const step = (s) => console.log(`  ✓ ${s}`);
async function shot(page, name) {
  n += 1;
  await page.waitForTimeout(250); // 等弹窗的淡入动画走完
  await page.screenshot({ path: path.join(SHOTS, `${String(n).padStart(2, '0')}-${name}.png`) });
}

async function login(page, who) {
  await page.goto(BASE);
  await page.getByLabel('邮箱').fill(accounts[who].email);
  await page.getByLabel('密码').fill(accounts[who].password);
  await page.getByRole('button', { name: '登录', exact: true }).last().click();
  await page.locator('.side').waitFor();
}

async function ask(page, agentName, text, shotName) {
  const box = page.locator('.composer textarea');
  await box.click();
  await box.pressSequentially('@');
  await page.locator('.at-pop').waitFor();
  if (shotName) {
    await shot(page, shotName);
    await page.locator('.at-pop').waitFor();
  }
  await page.locator('.at-row', { hasText: agentName }).first().click();
  await box.pressSequentially(text);
  return box;
}

const lastAgentMsg = (page) => page.locator('.agent-msg').last();

/** 发出输入框里的话，等「这一次」的 agent 回复到某个状态（不会误认成上一条）。 */
async function sendAndWait(page, status, timeout = 30000) {
  const before = await page.locator('.agent-msg').count();
  await page.locator('.composer textarea').press('Enter');
  const mine = page.locator('.agent-msg').nth(before);
  await mine.waitFor({ timeout });
  await waitStatus(page, status, timeout);
  return mine;
}

async function waitStatus(page, status, timeout = 30000) {
  const last = lastAgentMsg(page);
  await page.waitForFunction((want) => {
    const all = document.querySelectorAll('.agent-msg');
    return all.length > 0 && all[all.length - 1].getAttribute('data-status') === want;
  }, status, { timeout });
  return last;
}

function runCommand(command) {
  // 就是网页上让用户复制的那条命令。HOME 指到临时文件夹，不弄脏真的 ~/.agentwork
  const env = { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME, AGENTWORK_HOME: path.join(FAKE_HOME, '.agentwork'), AGENTWORK_WORK: path.join(FAKE_HOME, 'agentwork') };
  const child = spawn(command, { shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`    [connector] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`    [connector!] ${d}`));
  return child;
}

function stop(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* 已经退出 */ }
}

const browser = await chromium.launch();
let connector = null;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  await ctxA.grantPermissions(['clipboard-read', 'clipboard-write']);
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) p.on('pageerror', (e) => { console.error('页面报错：', e.message); process.exitCode = 1; });

  console.log('登录');
  await a.goto(BASE);
  await a.locator('.login').waitFor();
  await shot(a, 'login');
  await a.getByLabel('邮箱').fill(accounts.Zeep.email);
  await a.getByLabel('密码').fill('wrong-password');
  await a.getByRole('button', { name: '登录', exact: true }).last().click();
  await a.getByRole('alert').waitFor();
  step('密码错有提示');
  await login(a, 'Zeep');
  await a.locator('.chat-title h1', { hasText: '测试群' }).waitFor();
  await a.locator('.user-msg').first().waitFor();
  await shot(a, 'main');
  step('Zeep 登录，自动打开测试群');

  console.log('@助手');
  await ask(a, '助手', '周五前要准备什么？');
  if ((await a.locator('.composer textarea').inputValue()) !== '@助手 周五前要准备什么？') throw new Error('选完 @ 接着打字，字的顺序乱了');
  await shot(a, 'at-popup-done');
  await sendAndWait(a, 'streaming');
  await a.waitForTimeout(500);
  await shot(a, 'helper-streaming');
  await waitStatus(a, 'done');
  await lastAgentMsg(a).locator('.msg-foot', { hasText: '用时' }).waitFor();
  await shot(a, 'helper-done');
  step('助手边想边出字，做完显示用时');

  await ask(a, '助手', '再说一遍');
  await sendAndWait(a, 'streaming');
  await a.reload();
  await a.locator('.agent-msg').last().waitFor();
  const st = await lastAgentMsg(a).getAttribute('data-status');
  if (st === 'streaming' && !(await lastAgentMsg(a).locator('.md').innerText()).trim()) throw new Error('刷新后正在出的字没了');
  await waitStatus(a, 'done');
  step('出字到一半刷新页面：字还在，接着出完');

  console.log('接入 agent');
  await a.locator('.my-agents .add').click();
  await shot(a, 'connect-name');
  await a.getByRole('button', { name: '下一步' }).click();
  await a.locator('.command').waitFor();
  const command = (await a.locator('.command').innerText()).trim();
  await shot(a, 'connect-command');
  await a.getByRole('button', { name: '复制命令' }).click();
  const clip = await a.evaluate(() => navigator.clipboard.readText());
  if (clip !== command) throw new Error('复制到的命令和显示的不一样');
  connector = runCommand(command);
  await a.locator('.connected').waitFor({ timeout: 20000 });
  await shot(a, 'connect-done');
  await a.getByRole('button', { name: '好的' }).click();
  await a.locator('.my-agent .dot.on').waitFor();
  await a.locator('.chat-title span', { hasText: '2 个 agent' }).waitFor();
  step('复制那条命令运行 → 网页显示「已连接 ✓」，并自动拉进当前群');

  await ask(a, 'Zeep 的 Claude', '看一下报告目录');
  await sendAndWait(a, 'done');
  const own = await lastAgentMsg(a).innerText();
  if (!own.includes('主人') || !own.includes('在 Zeep 的电脑上完成')) throw new Error('主人模式的回答不对：' + own);
  await lastAgentMsg(a).locator('.steps-head').click();
  await shot(a, 'owner-reply');
  step('主人 @ 自己的 agent：有步骤、能改文件、显示「在 Zeep 的电脑上完成」');

  console.log('借用');
  await login(b, '尹昊');
  await b.locator('.chat-row', { hasText: '测试群' }).click();
  await b.locator('.agent-msg').last().waitFor();
  await ask(b, 'Zeep 的 Claude', '也帮我看一下', 'guest-at-popup');
  await sendAndWait(b, 'done');
  const guest = lastAgentMsg(b);
  await guest.locator('.tag.guest').waitFor();
  if (!(await guest.innerText()).includes('只能看和回答')) throw new Error('借用模式的回答不对');
  await shot(b, 'guest-reply');
  step('尹昊借用 Zeep 的 agent：带「借用 · 只读」标记');

  await b.getByRole('button', { name: '成员' }).click();
  await b.locator('.drawer').waitFor();
  await b.waitForTimeout(350);
  await shot(b, 'members-guest');
  await b.locator('.drawer .icon-btn').click();

  await a.getByRole('button', { name: '成员' }).click();
  await a.locator('.drawer').waitFor();
  await a.waitForTimeout(350);
  await shot(a, 'members-owner');
  await a.locator('.drawer').getByRole('radio', { name: '只有我能 @' }).click();
  await a.locator('.drawer').getByRole('radio', { name: '只有我能 @', checked: true }).waitFor();
  await a.locator('.drawer .icon-btn').click();
  await ask(b, 'Zeep 的 Claude', '还能用吗');
  await b.locator('.at-row.muted').waitFor().catch(() => undefined);
  await b.locator('.composer textarea').press('Enter');
  await b.locator('.agent-msg', { hasText: '只听 Zeep 的' }).waitFor();
  await shot(b, 'declined');
  step('Zeep 切到「只有我能 @」→ 尹昊被婉拒');
  await a.locator('.my-agent').click();
  await a.locator('.modal').waitFor();
  await shot(a, 'agent-settings');
  await a.locator('.modal').getByRole('radio', { name: '群里谁都能 @' }).click();
  await a.locator('.modal').getByRole('radio', { name: '群里谁都能 @', checked: true }).waitFor();
  await a.locator('.modal .icon-btn').click();

  console.log('agent 叫 agent、停止、复制');
  {
    const before = await a.locator('.agent-msg').count();
    await a.locator('.composer textarea').fill('@助手 帮我看一下，叫上「Zeep 的 Claude」');
    await a.locator('.composer textarea').press('Enter');
    const second = a.locator('.agent-msg').nth(before + 1);
    await second.waitFor({ timeout: 30000 });
    await a.waitForFunction((i) => document.querySelectorAll('.agent-msg')[i]?.getAttribute('data-status') === 'done', before + 1, { timeout: 30000 });
    const head = await second.locator('.msg-head').innerText();
    if (!head.includes('Zeep 的 Claude') || !head.includes('回复 助手')) throw new Error('agent 叫 agent 的那条显示不对：' + head);
    await a.locator('.agent-msg').nth(before).locator('.mention', { hasText: '@Zeep 的 Claude' }).waitFor();
    await shot(a, 'agent-calls-agent');
    step('助手在回答里 @ 了我的 agent → 它接着干，标着「回复 助手」');

    await ask(a, '助手', '说长一点');
    const running = await sendAndWait(a, 'streaming');
    await shot(a, 'streaming-with-stop');
    await running.getByRole('button', { name: '停止' }).click();
    await running.locator('.msg-foot', { hasText: '已停止' }).waitFor();
    await running.hover();
    await running.getByRole('button', { name: '复制' }).click();
    const copied = await a.evaluate(() => navigator.clipboard.readText());
    if (!copied.startsWith('收到')) throw new Error('复制到的不是这条回答：' + copied.slice(0, 40));
    step('出字到一半点「停止」→ 停住；「复制」能把回答复制走');
  }

  console.log('离线排队');
  stop(connector);
  await a.locator('.my-agent .dot.off').waitFor();
  await a.locator('.my-agent').click();
  const reconnect = (await a.locator('.offline-help .command').innerText()).trim();
  await shot(a, 'agent-offline');
  await a.locator('.modal .icon-btn').click();
  await ask(b, 'Zeep 的 Claude', '你在吗');
  await sendAndWait(b, 'queued');
  await shot(b, 'queued');
  connector = runCommand(reconnect); // 网页上「重新上线」的那条命令
  await b.locator('.agent-msg[data-status="queued"]').waitFor({ state: 'detached', timeout: 20000 });
  await waitStatus(b, 'done');
  step('电脑不在线 → 排队；重新运行连接程序 → 自动做完');

  console.log('建群和邀请');
  await a.getByRole('button', { name: '建群' }).first().click();
  await a.getByPlaceholder('比如：毕设小组').fill('毕设小组');
  await shot(a, 'new-chat');
  await a.locator('.modal').getByRole('button', { name: '建群' }).click();
  await a.locator('.chat-title h1', { hasText: '毕设小组' }).waitFor();
  await shot(a, 'empty-chat');
  await a.getByRole('button', { name: '邀请' }).click();
  const link = await a.getByLabel('邀请链接').inputValue();
  await shot(a, 'invite-modal');
  await a.locator('.modal .icon-btn').click();
  await b.goto(link);
  await b.locator('.card.invite h1', { hasText: '毕设小组' }).waitFor();
  await shot(b, 'invite-page');
  await b.getByRole('button', { name: /身份加入/ }).click();
  await b.locator('.chat-title h1', { hasText: '毕设小组' }).waitFor();
  await a.locator('.sys-msg', { hasText: '尹昊 加入了群' }).waitFor();
  step('建群 → 复制邀请链接 → 对方打开加入');

  await b.locator('.composer textarea').fill('我进来了');
  await b.locator('.composer textarea').press('Enter');
  await a.locator('.user-msg', { hasText: '我进来了' }).waitFor();
  await a.locator('.chat-row', { hasText: '测试群' }).click();
  await b.locator('.composer textarea').fill('第二条');
  await b.locator('.composer textarea').press('Enter');
  await a.locator('.chat-row', { hasText: '毕设小组' }).locator('.badge').waitFor();
  await a.getByRole('tab', { name: /通讯录/ }).click();
  await a.locator('.contact', { hasText: '尹昊' }).waitFor();
  await shot(a, 'contacts-unread');
  await a.getByRole('tab', { name: /聊天/ }).click();
  step('实时收消息、未读红点、通讯录');

  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const c = await ctxC.newPage();
  await c.goto(link);
  await c.locator('.notice').waitFor();
  await c.getByLabel(/名字/).fill('陈宇涵');
  await c.getByLabel('邮箱').fill('yuhan@example.com');
  await c.getByLabel(/密码/).fill('test-pass-1');
  await shot(c, 'register-from-invite');
  await c.getByRole('button', { name: '注册并进入' }).click();
  await c.getByRole('button', { name: /身份加入/ }).click();
  await c.locator('.chat-title span', { hasText: '3 人' }).waitFor();
  step('没账号的人打开邀请链接 → 注册 → 直接进群');
  await ctxC.close();

  // 一百多条消息：先只显示最近的，点「看更早的消息」能翻回去
  await a.locator('.chat-row', { hasText: '毕设小组' }).click();
  await a.locator('.chat-title h1', { hasText: '毕设小组' }).waitFor();
  const chatId = await a.evaluate(() => Number(localStorage.getItem('agentwork:last-chat')));
  await a.evaluate(async (id) => {
    for (let i = 1; i <= 130; i++) {
      await fetch(`/api/chats/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `第 ${i} 条` }) });
    }
  }, chatId);
  await a.reload();
  await a.locator('.user-msg', { hasText: '第 130 条' }).waitFor();
  if (await a.locator('.user-msg', { hasText: /^第 5 条$/ }).count()) throw new Error('一次把所有消息都加载了');
  await a.getByRole('button', { name: '看更早的消息' }).click();
  await a.locator('.bubble', { hasText: /^第 5 条$/ }).waitFor();
  step('消息多的时候分页加载');

  console.log('深色模式和手机');
  const ctxW = await browser.newContext({ viewport: { width: 1600, height: 960 }, locale: 'zh-CN', storageState: await ctxA.storageState() });
  const w = await ctxW.newPage();
  await w.goto(BASE);
  await w.locator('.chat-row', { hasText: '测试群' }).click();
  await w.locator('.agent-msg').last().waitFor();
  await shot(w, 'wide');
  await ctxW.close();
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale: 'zh-CN', storageState: await ctxA.storageState() });
  const d = await ctxD.newPage();
  await d.goto(BASE);
  await d.locator('.chat-row', { hasText: '测试群' }).click();
  await d.locator('.agent-msg').last().waitFor();
  await shot(d, 'dark');
  await d.getByRole('button', { name: '成员' }).click();
  await d.waitForTimeout(350);
  await shot(d, 'dark-members');
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN', storageState: await ctxB.storageState() });
  const m = await ctxM.newPage();
  await m.goto(BASE);
  await m.locator('.chat-row').first().waitFor();
  await shot(m, 'mobile-list');
  await m.locator('.chat-row', { hasText: '测试群' }).click();
  await m.locator('.agent-msg').last().waitFor();
  await shot(m, 'mobile-chat');
  step('深色模式、手机宽度');

  console.log('退出');
  await a.locator('.me').click();
  await a.getByRole('menuitem', { name: '退出登录' }).click();
  await a.locator('.login').waitFor();
  step('退出登录');
  console.log(`\n全部通过。截图在 ${SHOTS}`);
} catch (e) {
  console.error('\n失败：', e.message);
  process.exitCode = 1;
} finally {
  stop(connector);
  await browser.close();
  server.kill();
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
