@echo off
cd /d "%~dp0"
npm run desktop
if errorlevel 1 pause
