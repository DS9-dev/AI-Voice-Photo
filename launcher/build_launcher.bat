@echo off
rem Builds "AI Voice Photo.exe" (no console window, app icon) with the C# compiler that ships with Windows.
setlocal
cd /d "%~dp0\.."
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo .NET Framework 4 C# compiler not found.
  exit /b 1
)
"%CSC%" /nologo /target:winexe /optimize+ /win32icon:app\assets\icon.ico /reference:System.Windows.Forms.dll /out:"AI Voice Photo.exe" launcher\AIVoicePhotoLauncher.cs
exit /b %ERRORLEVEL%
