#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  Exception Insight - starting"
echo "============================================"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 18+ first: https://nodejs.org"
  exit 1
fi
echo "[INFO] Node $(node -v)"

if [ ! -f .env ]; then
  echo "[INFO] .env not found, creating from .env.example ..."
  cp .env.example .env
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # 替换 JWT_SECRET（macOS/Linux 兼容写法）
  node -e "
const fs=require('fs');
const s=process.argv[1];
let t=fs.readFileSync('.env','utf8').replace(/^JWT_SECRET=.*$/m,'JWT_SECRET='+s);
fs.writeFileSync('.env',t);
" "$SECRET"
  echo "[INFO] Generated random JWT_SECRET in .env"
fi

if [ ! -d node_modules ]; then
  echo "[INFO] Installing dependencies ..."
  npm ci --omit=dev
fi

if [ ! -f dist/index.js ]; then
  echo "[INFO] dist not found, building ..."
  npm install --no-save typescript
  npm run build
fi

echo
echo "[INFO] Open http://localhost:3000  (login: 1001 / dev123)"
echo "[INFO] Press Ctrl+C to stop"
echo
exec node dist/index.js
