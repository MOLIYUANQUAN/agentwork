"""One command to start agentwork:  python -m server.launch

start.cmd / start.sh call this after making the virtualenv. It builds the web
page if needed, makes the test accounts on first run, picks real or simulated
AI, opens the browser and runs the server.
"""
from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
PORT = int(os.getenv("AGENTWORK_PORT", "8787"))
HOST = os.getenv("AGENTWORK_HOST", "127.0.0.1")
NPM_MIRROR = "https://registry.npmmirror.com"


def say(msg: str) -> None:
    print(f"[agentwork] {msg}", flush=True)


def build_web() -> bool:
    if (WEB / "dist" / "index.html").exists():
        return True
    if not shutil.which("npm"):
        say("网页还没构建，而且这台电脑上没找到 npm。先装 Node.js（https://nodejs.org），再启动一次。")
        return False
    say("第一次启动：正在构建网页（要一两分钟，只做这一次）…")

    def npm(args: str) -> bool:  # through the shell: on Windows npm is npm.cmd
        return subprocess.run("npm " + args, shell=True, cwd=WEB).returncode == 0

    if not (WEB / "node_modules").exists():
        if not npm("install --no-audit --no-fund"):
            say("npm 安装失败，换国内镜像再试一次…")
            if not npm("install --no-audit --no-fund --registry " + NPM_MIRROR):
                say("npm install 还是失败了。检查网络后再启动一次。")
                return False
    if not npm("run build"):
        say("网页构建失败，看上面的报错。")
        return False
    return True


def claude_logged_in() -> bool:
    """Best guess, without calling the model: is Claude Code installed and logged in here?"""
    if not shutil.which("claude"):
        return False
    if os.getenv("CLAUDE_CODE_OAUTH_TOKEN") or os.getenv("ANTHROPIC_AUTH_TOKEN"):
        return True
    if platform.system() == "Darwin":
        return True  # the login lives in the keychain; assume yes
    home = Path(os.getenv("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    return (home / ".credentials.json").exists()


def pick_engine() -> None:
    forced = os.getenv("AGENTWORK_FAKE_AI")
    if forced == "1":
        say("模拟模式（AGENTWORK_FAKE_AI=1）：agent 的回答是假的，只用来走通流程。")
    elif forced is not None:
        os.environ.pop("AGENTWORK_FAKE_AI", None)
        say("真实模式（AGENTWORK_FAKE_AI=0）。")
    elif (os.getenv("ANTHROPIC_API_KEY") or "").strip():
        say("内置助手用 .env 里的 ANTHROPIC_API_KEY。")
    elif claude_logged_in():
        say("内置助手用这台电脑上的 Claude Code。")
    else:
        os.environ["AGENTWORK_FAKE_AI"] = "1"
        say("这台电脑上的 Claude Code 还没登录，也没有 ANTHROPIC_API_KEY，所以先用【模拟模式】：")
        say("  agent 的回答是假的，只用来走通流程。")
        say("  想用真的：在终端运行 claude，输入 /login 登录一次，然后关掉这个窗口重新启动。")


def port_busy() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def open_when_up(url: str) -> None:
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/api/bootstrap", timeout=1)
        except urllib.error.HTTPError:
            break  # 401 = the server is answering
        except Exception:
            time.sleep(0.2)
            continue
        break
    say(f"打开 {url}（浏览器没自动弹出来就手动打开）。关掉这个窗口就是关掉服务。")
    if os.getenv("AGENTWORK_NO_BROWSER") != "1":
        try:
            webbrowser.open(url)
        except Exception:
            pass


def main() -> int:
    try:
        sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]
    except Exception:
        pass
    os.chdir(ROOT)
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    url = f"http://localhost:{PORT}"
    if port_busy():
        say(f"{PORT} 端口上已经有服务在跑了（可能是之前启动的还没关）。直接打开 {url}。")
        if os.getenv("AGENTWORK_NO_BROWSER") != "1":
            webbrowser.open(url)
        return 0
    if not build_web():
        return 1

    from . import seed

    if seed.seed():
        say(f"建好了两个测试账号和「测试群」，账号密码在 {seed.ACCOUNTS_FILE}")
    pick_engine()

    import uvicorn

    threading.Thread(target=open_when_up, args=(url,), daemon=True).start()
    uvicorn.run("server.main:app", host=HOST, port=PORT, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
