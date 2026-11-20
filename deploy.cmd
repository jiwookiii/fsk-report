@echo off
rem Double-click to publish, or drag report.enc.json onto this file
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -EncFile "%~1"
)
pause
