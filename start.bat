@echo off
chcp 65001 >nul
title Agent Token Viewer - 本机 Agent Token 用量总览
cd /d "%~dp0"

echo.
echo   ============================================================
echo     Agent Token Viewer - 本机 Agent Token 用量总览
echo   ============================================================
echo.
echo   正在启动本地服务（http://127.0.0.1:3457）...
echo   浏览器会在几秒后自动打开。
echo   关闭本窗口即可停止服务。
echo.

start /b "" cmd /c "timeout /t 3 /nobreak >nul && start "" http://127.0.0.1:3457"
node server.js
pause
