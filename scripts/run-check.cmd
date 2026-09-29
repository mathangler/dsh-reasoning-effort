@echo off
rem Run the read-only checker with a Node that actually works. Same resolution order as
rem run-apply.cmd: %DSH_SKILL_NODE%, node on PATH, the desktop build's own executable, the desktop
rem build's bundled Node.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%check-reasoning-route.mjs"

if not defined DSH_SKILL_NODE goto path
"%DSH_SKILL_NODE%" --version >nul 2>&1
if errorlevel 1 goto path
"%DSH_SKILL_NODE%" "%SCRIPT%" %*
exit /b

:path
node --version >nul 2>&1
if errorlevel 1 goto desktop
node "%SCRIPT%" %*
exit /b

:desktop
if not defined DSH_DESKTOP_NODE_EXECUTABLE goto bundled
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%SCRIPT%" %*
exit /b

:bundled
set "BUNDLED=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%BUNDLED%" goto noNode
"%BUNDLED%" "%SCRIPT%" %*
exit /b

:noNode
echo No usable Node found. Tried, in order: 1>&2
echo   1. %%DSH_SKILL_NODE%% ^(not set, or not runnable^) 1>&2
echo   2. node on PATH 1>&2
echo   3. %%DSH_DESKTOP_NODE_EXECUTABLE%% ^(not set^) 1>&2
echo   4. %BUNDLED% 1>&2
echo Set DSH_SKILL_NODE to a working node executable, then run this again. 1>&2
exit /b 2
