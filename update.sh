#!/bin/bash
# update.sh — place in /scrapeit/
# Pulls latest from GitHub and restarts the server.
# Manual: bash update.sh
# Auto every 5 min: */5 * * * * /scrapeit/update.sh

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$REPO_DIR/update.log"
BRANCH="${1:-main}"

echo "[$(date)] Checking for updates..." | tee -a "$LOG"

cd "$REPO_DIR"
git fetch origin "$BRANCH" 2>&1 | tee -a "$LOG"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[$(date)] Already up to date." | tee -a "$LOG"
  exit 0
fi

echo "[$(date)] New commits found — pulling..." | tee -a "$LOG"
git pull origin "$BRANCH" 2>&1 | tee -a "$LOG"

# Create .env from .env.example if it doesn't exist yet
if [ ! -f "$REPO_DIR/backend/.env" ]; then
  echo "[$(date)] No .env found — copying from .env.example. Edit backend/.env to set ADMIN_TOKEN!" | tee -a "$LOG"
  cp "$REPO_DIR/backend/.env.example" "$REPO_DIR/backend/.env"
fi

# Install any new/updated dependencies
cd "$REPO_DIR/backend"
npm install --omit=dev 2>&1 | tee -a "$LOG"

# Restart the server
if command -v pm2 &> /dev/null; then
  echo "[$(date)] Restarting via pm2..." | tee -a "$LOG"
  pm2 restart scrapeit 2>/dev/null || pm2 start server.js --name scrapeit --cwd "$REPO_DIR/backend" 2>&1 | tee -a "$LOG"
else
  echo "[$(date)] Restarting via node..." | tee -a "$LOG"
  pkill -f "node server.js" 2>/dev/null || true
  sleep 1
  nohup node "$REPO_DIR/backend/server.js" >> "$LOG" 2>&1 &
  echo "[$(date)] Server started (PID $!)" | tee -a "$LOG"
fi

echo "[$(date)] Done." | tee -a "$LOG"
