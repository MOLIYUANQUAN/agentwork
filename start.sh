#!/usr/bin/env bash
# Mac / Linux：./start.sh   （Windows 上双击 start.cmd）
set -e
cd "$(dirname "$0")"
PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python
if [ ! -x .venv/bin/python ]; then
  echo "[agentwork] 第一次启动：创建 .venv …"
  "$PY" -m venv .venv
fi
if ! .venv/bin/python -c "import fastapi, uvicorn, anthropic, dotenv, websockets" >/dev/null 2>&1; then
  echo "[agentwork] 安装 Python 依赖，大约一分钟…"
  .venv/bin/python -m pip install -q --disable-pip-version-check -r server/requirements.txt \
    || .venv/bin/python -m pip install -q --disable-pip-version-check -i https://pypi.tuna.tsinghua.edu.cn/simple -r server/requirements.txt
fi
exec .venv/bin/python -m server.launch "$@"
