@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Exception Insight

echo ============================================
echo   Exception Insight - starting
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first: https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do echo [INFO] Node %%v

if not exist ".env" (
  echo [INFO] .env not found, creating from .env.example ...
  copy ".env.example" ".env" >nul
  powershell -NoProfile -Command "$b=New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); $s=($b | ForEach-Object { $_.ToString('x2') }) -join ''; (Get-Content -Raw -Encoding UTF8 '.env') -replace '(?m)^JWT_SECRET=.*$', ('JWT_SECRET=' + $s) | Set-Content -Encoding UTF8 '.env'"
  echo [INFO] Generated random JWT_SECRET in .env
)

if not exist "node_modules" (
  echo [INFO] Installing dependencies ...
  call npm ci --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check network / npm registry.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo [INFO] dist not found, building ...
  call npm install --no-save typescript
  call npm run build
)

echo.
echo [INFO] Open http://localhost:3000  (login: 1001 / dev123)
echo [INFO] Press Ctrl+C to stop
echo.
node dist\index.js

echo.
echo [INFO] server stopped
pause
