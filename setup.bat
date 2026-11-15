@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH.
  echo Install Node.js 20 or newer from https://nodejs.org and run setup.bat again.
  pause
  exit /b 1
)
node scripts\setup.js %*
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
