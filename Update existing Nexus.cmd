@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0upgrade\apply-upgrade.ps1"
pause
