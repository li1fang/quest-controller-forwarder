@echo off
chcp 65001 >nul
title Quest - Restore Dialog Setting
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\restore-dialogs.ps1" %*
if errorlevel 1 pause
