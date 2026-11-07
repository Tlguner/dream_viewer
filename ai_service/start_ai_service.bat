@echo off
title DreamViewer - Local AI Video Engine
echo ========================================================
echo  DreamViewer Open-Source Video Generator (RTX 5070)
echo ========================================================
cd /d "%~dp0"
python -m pip install -r requirements.txt
python app.py
pause
