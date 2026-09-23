@echo off
rem ============================================================
rem  DSH Console -- OFFLINE all-in-one package builder
rem  Bundles Node.js (win-x64) + @deepseek-ai/dsh into the zip.
rem  Build machine needs network once; the result runs offline.
rem  Keep this file PURE ASCII (see start.cmd).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo Building OFFLINE production package ...
echo   Output : %~dp0dist\dsh-console-offline-*\
echo            %~dp0dist\dsh-console-offline-*.zip
echo   Needs  : network on the build machine (Node zip + npm dsh)
echo            Also copies your local DSH profile plugins from
echo            %%USERPROFILE%%\.dsh\profiles\web  (skip: --no-profile)
echo            Target PCs can run fully offline afterward.
echo.

node tools\make-dist.mjs --offline %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Build finished: offline package is ready under dist\
) else (
  echo Build FAILED with exit code %RC%.  Read the messages above.
)
echo.
pause
exit /b %RC%

:nonode
echo.
echo [x] Node.js not found on the BUILD machine.
echo     The packager itself needs Node to run make-dist.mjs.
echo     Please install Node.js 18+:  https://nodejs.org
echo.
pause
exit /b 1
