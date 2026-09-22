@echo off
rem ============================================================
rem  DSH Console -- production package builder
rem  Double-click to build a deployable, minified dist\ folder.
rem  Keep this file PURE ASCII.  Non-ASCII bytes break cmd.exe
rem  parsing after "chcp 65001" (see the note in start.cmd).
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo Building production package ...
echo   Output : %~dp0dist\dsh-console\
echo            %~dp0dist\dsh-console.zip
echo   Notes  : source is minified; terser is fetched by npx once
echo            (needs network on the very first build only)
echo.

node tools\make-dist.mjs %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Build finished: dist\dsh-console\ is ready to ship.
) else (
  echo Build FAILED with exit code %RC%.  Read the messages above.
)
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
