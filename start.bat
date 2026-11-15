@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\package.json" (
  echo Electron is not installed yet. Run setup.bat first.
  pause
  exit /b 1
)
call npm start
exit /b %ERRORLEVEL%
