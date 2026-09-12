#!/usr/bin/env bash
# Token Viewer 启动脚本（macOS / Linux / Git Bash）
cd "$(dirname "$0")" || exit 1
( sleep 3 && (xdg-open "http://127.0.0.1:3457" >/dev/null 2>&1 || open "http://127.0.0.1:3457" >/dev/null 2>&1) ) &
node server.js
