@echo off
rem ============================================================
rem  DSH Console launcher  (double-click to run)
rem  SPDX-License-Identifier: Apache-2.0  (see LICENSE / NOTICE)
rem  Keep this file PURE ASCII.  Non-ASCII bytes here break
rem  cmd.exe parsing after "chcp 65001" (the parser splits lines
rem  at wrong byte offsets and starts running comments as commands).
rem  DSHC_VER is filled in by the production packager
rem  (tools/make-dist.mjs); when running from source it stays empty.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
set "DSHC_VER="

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
node -v >nul 2>nul
if errorlevel 1 goto nonode

rem The address below must follow CONSOLE_PORT, otherwise this
rem hint is wrong whenever the port has been changed.
set "CONSOLE_PORT_LOCAL=%CONSOLE_PORT%"
if "%CONSOLE_PORT_LOCAL%"=="" set "CONSOLE_PORT_LOCAL=3081"

echo.
echo Starting DSH Console %DSHC_VER% ...  (press Ctrl+C to stop)
echo   Then open in browser:  http://127.0.0.1:%CONSOLE_PORT_LOCAL%
echo   (port from CONSOLE_PORT if you set it, otherwise 3081)
echo   Do NOT open public\index.html directly.
echo.

node server.cjs

echo.
echo DSH Console has exited.  Exit code: %ERRORLEVEL%
echo If it failed to connect, run check.cmd for a deployment self-check.
echo.
pause
exit /b 0

:nonode
echo.
echo [x] Node.js not found.
echo     Please install Node.js 18 or newer:  https://nodejs.org
echo.
pause
exit /b 1
