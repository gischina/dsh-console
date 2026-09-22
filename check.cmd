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

rem Use "node -v", NOT "where node": a Microsoft Store node stub
rem answers "where" just fine but cannot actually run anything.
node -v >nul 2>nul
if errorlevel 1 goto nonode

echo DSH Console version: %DSHC_VER%
node server.cjs --check
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
echo     Please install Node.js 18 or newer:  https://nodejs.org
echo.
pause
exit /b 1
