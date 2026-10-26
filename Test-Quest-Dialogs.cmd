@echo off
chcp 65001 >nul
title Quest Dialog Test
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\test-dialogs.ps1" %*
if errorlevel 1 pause
