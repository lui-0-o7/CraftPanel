@echo off
setlocal
cd /d "%~dp0"
title CraftPanel

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo No se encontro Node.js. Instalalo desde https://nodejs.org/ y vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Instalando dependencias por primera vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias.
    echo.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 (
  echo.
  echo CraftPanel termino con un error.
  echo.
  pause
)
