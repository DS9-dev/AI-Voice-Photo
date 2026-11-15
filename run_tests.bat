@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\run_tests.js %*
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
