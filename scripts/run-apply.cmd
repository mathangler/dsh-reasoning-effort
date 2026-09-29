@echo off
rem Run the reasoning-effort writer with a Node that actually works.
rem
rem The desktop build ships its own Node, and a machine can have no usable `node` on PATH (an nvm
rem shim with no active version, for instance). This wrapper tries, in order:
rem   1. %DSH_SKILL_NODE%         an explicit override
rem   2. node on PATH            verified by running it, not merely found
rem   3. %DSH_DESKTOP_NODE_EXECUTABLE%  the desktop build's own executable (Electron as Node)
rem   4. the desktop build's bundled Node distribution
rem All arguments are handed to the writer unchanged.
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%apply-reasoning-efforts.mjs"

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
