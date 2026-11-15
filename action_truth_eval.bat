@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\action_truth_eval.js %*
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
