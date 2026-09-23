@echo off
rem ============================================================
rem  SPDX-License-Identifier: Apache-2.0  (see LICENSE / NOTICE)
rem  DSH Console deployment self-check  (double-click to run)
rem  Checks only, does not start the service.
rem  Output is plain text: copy everything and send it to your
rem  administrator.  Keep this file PURE ASCII (see start.cmd).
rem  DSHC_VER is filled in by the production packager
rem  (tools/make-dist.mjs); when running from source it stays empty.
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
if exist "%~dp0runtime\dsh-home\profiles" (
  set "DSH_HOME=%~dp0runtime\dsh-home"
)

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
"%NODE_EXE%" -v >nul 2>nul
if errorlevel 1 goto nonode

echo DSH Console version: %DSHC_VER%
if defined DSH_CONSOLE_RUNTIME echo Runtime: OFFLINE bundle at %DSH_CONSOLE_RUNTIME%
if defined DSH_HOME echo DSH_HOME: %DSH_HOME%
"%NODE_EXE%" server.cjs --check
set "RC=%ERRORLEVEL%"

echo.
echo ------------------ end of report ------------------
echo Copy everything above and send it to your administrator.
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
