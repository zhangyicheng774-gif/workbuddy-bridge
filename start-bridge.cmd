@echo off
rem Start the bridge on 127.0.0.1:8787. Keep this window open; closing it stops the service.
rem Set WB_UPSTREAM_BASE_URL / WB_UPSTREAM_API_KEY (and optionally the other WB_* vars)
rem in your environment, or edit this file.
chcp 65001 >nul
title WorkBuddy bridge
cd /d "%~dp0"
node server.mjs
if errorlevel 1 (
  echo.
  echo Bridge exited with an error. If it says "No upstream configured",
  echo set WB_UPSTREAM_BASE_URL + WB_UPSTREAM_API_KEY, or put the WorkBuddy
  echo adapter at vendor\wb\index.js. See README.md.
  pause
)
