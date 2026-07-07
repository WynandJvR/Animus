@echo off
REM Double-click this to launch Animus (bot + brain). It just runs launch.ps1
REM with the execution-policy bypass so Windows doesn't block the script.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"
pause
