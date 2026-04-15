#!/bin/bash
# Start Dispatch production server in tmux
# Usage: bash scripts/start-production.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CORE_DIR="$PROJECT_DIR/packages/core"

echo "=== Starting Dispatch Production ==="

# Kill existing sessions
tmux kill-session -t dispatch 2>/dev/null || true

# Create tmux session with 2 windows
tmux new-session -d -s dispatch -n server
tmux new-window -t dispatch -n ngrok

# Window 1: Dispatch server
tmux send-keys -t dispatch:server "cd $CORE_DIR && set -a && source .env.production && set +a && cd $PROJECT_DIR && pnpm --filter @dispatch/core dev" Enter

# Window 2: ngrok
tmux send-keys -t dispatch:ngrok "sleep 3 && ngrok http 7890" Enter

echo ""
echo "Dispatch server starting in tmux session 'dispatch'"
echo "  tmux attach -t dispatch       — attach to session"
echo "  tmux attach -t dispatch:server — server logs"
echo "  tmux attach -t dispatch:ngrok  — ngrok tunnel"
echo ""
echo "Waiting for server..."
sleep 5

# Verify
if curl -sf http://localhost:7890/api/v1/health > /dev/null 2>&1; then
  echo "Server: UP"
else
  echo "Server: STARTING (check tmux attach -t dispatch:server)"
fi

sleep 3
NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; print([t['public_url'] for t in json.load(sys.stdin)['tunnels'] if t['public_url'].startswith('https')][0])" 2>/dev/null || echo "pending")
echo "Ngrok:  $NGROK_URL"
