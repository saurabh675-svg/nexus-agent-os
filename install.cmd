@echo off
setlocal
title Nexus - setup
cd /d "%~dp0"

echo.
echo   NEXUS  ^|  setup
echo   ------------------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js was not found on this PC.
  echo.
  echo       1. Open https://nodejs.org and download the LTS installer
  echo       2. Run it, accept the defaults
  echo       3. Close this window, then run install.cmd again
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo   [ok] Node.js %NODEVER%

if not exist "data" mkdir "data"
if not exist "data\workspace" mkdir "data\workspace"

echo   [ok] data folder ready
echo.
echo   Creating the desktop shortcut...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$p = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Nexus.lnk';" ^
  "$s = $w.CreateShortcut($p);" ^
  "$s.TargetPath = '%ComSpec%';" ^
  "$s.Arguments = '/c \"\"%~dp0start.cmd\"\"';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = 'shell32.dll,13';" ^
  "$s.Description = 'Nexus - local agent OS';" ^
  "$s.Save();" ^
  "Write-Host ('   [ok] shortcut: ' + $p)"

echo.
echo   ------------------------------------------------------------
echo   Done. Double-click the new "Nexus" shortcut on your Desktop.
echo.
echo   First time only: open Settings and pick a model.
echo     local:  ollama pull qwen2.5:7b
echo     cloud:  paste an OpenAI-compatible base URL + key
echo.
echo   Full walkthrough with Google, Kaggle and Discord setup:
echo     INSTALL.md
echo   ------------------------------------------------------------
echo.
choice /c YN /n /m "Start Nexus now? [Y/N] "
if errorlevel 2 goto :end
if errorlevel 1 start "" "%~dp0start.cmd"
:end
endlocal
