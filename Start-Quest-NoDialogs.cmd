@echo off
chcp 65001 >nul
title Quest Controller Monitor - Temporary Dialog Mode
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\start-ui.ps1" --disable-dialogs %*
if errorlevel 1 pause
