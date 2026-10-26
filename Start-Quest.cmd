@echo off
chcp 65001 >nul
title Quest Controller Monitor
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-ui.ps1" %*
if errorlevel 1 pause
