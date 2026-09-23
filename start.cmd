@echo off
rem ============================================================
rem  DSH Console launcher  (double-click to run)
rem  SPDX-License-Identifier: Apache-2.0  (see LICENSE / NOTICE)
rem  Keep this file PURE ASCII.  Non-ASCII bytes here break
rem  cmd.exe parsing after "chcp 65001" (the parser splits lines
rem  at wrong byte offsets and starts running comments as commands).
rem  DSHC_VER is filled in by the production packager
rem  (tools/make-dist.mjs); when running from source it stays empty.
rem
rem  Offline bundle: if runtime\node\node.exe exists (make-dist
rem  --offline), use that Node + bundled DSH and ignore system PATH.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
set "DSHC_VER="

set "NODE_EXE=node"
if exist "%~dp0runtime\node\node.exe" (
  set "NODE_EXE=%~dp0runtime\node\node.exe"
  set "PATH=%~dp0runtime\node;%~dp0runtime\dsh\node_modules\.bin;%PATH%"
  set "DSH_CONSOLE_RUNTIME=%~dp0runtime"
)
rem Offline profile with user-installed plugins (make-dist --offline copies it)
if exist "%~dp0runtime\dsh-home\profiles" (
  set "DSH_HOME=%~dp0runtime\dsh-home"
)

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
"%NODE_EXE%" -v >nul 2>nul
if errorlevel 1 goto nonode

if not exist "%~dp0server.cjs" goto noserver
if not exist "%~dp0public\index.html" goto nopublic

rem The address below must follow CONSOLE_PORT, otherwise this
rem hint is wrong whenever the port has been changed.
set "CONSOLE_PORT_LOCAL=%CONSOLE_PORT%"
if "%CONSOLE_PORT_LOCAL%"=="" set "CONSOLE_PORT_LOCAL=3081"

echo.
echo Starting DSH Console %DSHC_VER% ...  (press Ctrl+C to stop)
if defined DSH_CONSOLE_RUNTIME (
  echo   Mode: OFFLINE bundle  (runtime\node + runtime\dsh)
  if defined DSH_HOME echo   DSH_HOME: %DSH_HOME%  (bundled profile / plugins)
) else (
  echo   Mode: system Node  (will auto-detect / start DSH if needed)
)
echo   Node:  
"%NODE_EXE%" -v
echo   Console URL:  http://127.0.0.1:%CONSOLE_PORT_LOCAL%
echo   (port from CONSOLE_PORT if you set it, otherwise 3081)
echo   Do NOT open public\index.html directly.
echo   Use 127.0.0.1 not "localhost" if the page fails to load.
echo   Disable auto-start:  set DSH_AUTO_START=0
echo.

"%NODE_EXE%" "%~dp0server.cjs"
set "RC=%ERRORLEVEL%"

echo.
echo DSH Console has exited.  Exit code: %RC%
echo If it failed to connect, run check.cmd for a deployment self-check.
echo.
pause
exit /b %RC%

:nonode
echo.
echo [x] Node.js not found.
if exist "%~dp0runtime\node\node.exe" (
  echo     Bundled runtime\node\node.exe exists but failed to run.
) else (
  echo     Please install Node.js 18 or newer:  https://nodejs.org
  echo     Or use the offline package built with dist-offline.cmd.
)
echo.
pause
exit /b 1

:noserver
echo.
echo [x] server.cjs not found next to start.cmd
echo     Dir: %~dp0
echo     Unpack the whole folder; do not run from inside the zip.
echo.
pause
exit /b 1

:nopublic
echo.
echo [x] public\index.html not found.
echo     The package is incomplete. Re-copy / re-unzip the full folder.
echo.
pause
exit /b 1
