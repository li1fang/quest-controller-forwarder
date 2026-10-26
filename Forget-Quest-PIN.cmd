@echo off
chcp 65001 >nul
title Quest - Forget Saved PIN
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\forget-pin.ps1" %*
if errorlevel 1 pause
