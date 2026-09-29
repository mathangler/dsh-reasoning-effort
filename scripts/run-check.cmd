@echo off
rem Run the read-only checker with a Node that actually works. Same resolution order as
rem run-apply.cmd: %DSH_SKILL_NODE%, the desktop build's bundled Node (in a desktop session), node on
rem PATH (run to verify), the bundled Node again, then the app's own executable as Node.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%check-reasoning-route.mjs"
set "BUNDLED=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%BUNDLED%" set "BUNDLED=%ProgramFiles%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%BUNDLED%" set "BUNDLED="

if not defined DSH_SKILL_NODE goto afterOverride
"%DSH_SKILL_NODE%" --version >nul 2>&1
if errorlevel 1 goto afterOverride
"%DSH_SKILL_NODE%" "%SCRIPT%" %*
exit /b

:afterOverride
if /i "%DSH_PROFILE%"=="desktop" if defined BUNDLED goto bundled
node --version >nul 2>&1
if errorlevel 1 goto bundled
node "%SCRIPT%" %*
exit /b

:bundled
if not defined BUNDLED goto desktop
"%BUNDLED%" "%SCRIPT%" %*
exit /b

:desktop
if not defined DSH_DESKTOP_NODE_EXECUTABLE goto noNode
set "ELECTRON_RUN_AS_NODE=1"
"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%SCRIPT%" %*
exit /b

:noNode
echo No usable Node found. Tried, in order: 1>&2
echo   1. %%DSH_SKILL_NODE%% ^(not set, or not runnable^) 1>&2
echo   2. the desktop build's bundled Node: %BUNDLED% 1>&2
echo   3. node on PATH 1>&2
echo   4. %%DSH_DESKTOP_NODE_EXECUTABLE%% ^(not set^) 1>&2
echo Set DSH_SKILL_NODE to a working node executable, then run this again. 1>&2
exit /b 2
