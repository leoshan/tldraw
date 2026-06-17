@echo off
title Windows Screen Capture Helper
echo Starting Windows Capture Helper...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0win-capture-helper.ps1"
pause
