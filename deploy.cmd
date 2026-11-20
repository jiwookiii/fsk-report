@echo off
rem Double-click to publish site changes (run build\tools\site.mjs first)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
pause
