@echo off
rem Start the bridge on 127.0.0.1:8787. Keep this window open; closing it stops the service.
chcp 65001 >nul
title WorkBuddy bridge
cd /d "%~dp0"
node server.mjs
pause
