@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Detox

rem ---------------------------------------------------------------------------
rem  Detox launcher.
rem  Builds the dashboard, starts the daemon (initial pipeline run when there is
rem  no snapshot yet, plus the 09:00 America/Toronto scheduler) and opens the
rem  browser at http://127.0.0.1:4321/. Ctrl+C stops it. Double-click again to
rem  pick up code changes; if it is already running it just opens the browser.
rem ---------------------------------------------------------------------------

set "URL=http://127.0.0.1:4321/"
cd /d "%~dp0"

echo.
echo   Detox
echo   %CD%
echo.

rem Already serving? Then there is nothing to do but show it.
netstat -ano | findstr /R /C:"LISTENING" | findstr ":4321" >nul 2>&1
if not errorlevel 1 (
  echo   Already running. Opening %URL%
  start "" "%URL%"
  exit /b 0
)

where node >nul 2>&1
if errorlevel 1 (
  echo   [x] Node.js is not on PATH. Install it from https://nodejs.org
  goto :fail
)

set "PNPM=pnpm"
where pnpm >nul 2>&1
if errorlevel 1 (
  echo   pnpm is not on PATH - falling back to corepack.
  set "PNPM=corepack pnpm"
)

if not exist "node_modules" (
  echo   Installing dependencies...
  call %PNPM% install || goto :fail
  echo.
)

rem `pnpm start` only serves dist/, it never builds it, so build on every launch.
echo   Building the dashboard...
call %PNPM% build || goto :fail
echo.

echo   Starting the dashboard at %URL%
echo   Press Ctrl+C to stop.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"
call %PNPM% start
set "CODE=%errorlevel%"
echo.
echo   Stopped ^(exit code %CODE%^).
exit /b %CODE%

:fail
echo.
echo   [x] Could not start. The output above says why.
pause
exit /b 1