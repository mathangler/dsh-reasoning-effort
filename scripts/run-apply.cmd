@echo off
rem Run the reasoning-effort writer with a Node that actually works.
rem
rem Resolution order — the Node of the build you are in, then the safest fallback:
rem   1. %DSH_SKILL_NODE%                an explicit override
rem   2. in a desktop session: the desktop build's bundled Node (real Node, same runtime as the app)
rem   3. node on PATH                    verified by running it, not merely found
rem   4. the desktop build's bundled Node (a machine whose PATH has no usable node)
rem   5. %DSH_DESKTOP_NODE_EXECUTABLE%   the app's own executable, run as Node
rem Arguments are handed to the writer unchanged.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%apply-reasoning-efforts.mjs"
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
