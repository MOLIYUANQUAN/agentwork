@echo off
setlocal
cd /d "%~dp0"
title agentwork

rem Double-click to start agentwork. Everything after the virtualenv is done by server\launch.py.

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [agentwork] Python not found. Install Python 3.10+ from https://www.python.org and run this again.
  goto :fail
)

if not exist ".venv\Scripts\python.exe" (
  echo [agentwork] First run: creating .venv ...
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)

".venv\Scripts\python.exe" -c "import fastapi, uvicorn, anthropic, dotenv, websockets" >nul 2>nul
if not errorlevel 1 goto :run
echo [agentwork] Installing Python packages, about a minute ...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r server\requirements.txt
if not errorlevel 1 goto :run
echo [agentwork] Retrying with the Tsinghua mirror ...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -i https://pypi.tuna.tsinghua.edu.cn/simple -r server\requirements.txt
if errorlevel 1 goto :fail

:run
".venv\Scripts\python.exe" -m server.launch %*
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo [agentwork] Did not start. Read the messages above.
pause
exit /b 1
