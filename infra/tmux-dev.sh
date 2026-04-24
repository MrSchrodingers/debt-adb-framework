#!/usr/bin/env bash
# Dispatch — dev session (HMR enabled)
# Layout:
#   ┌─────────────┬─────────────┐
#   │ core (api)  │ ui (vite)   │
#   ├─────────────┼─────────────┤
#   │ caddy log   │ tailscale   │
#   └─────────────┴─────────────┘
set -euo pipefail

SESSION="${DISPATCH_SESSION:-dispatch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ROOT}/infra/logs"
mkdir -p "$LOG_DIR"

if tmux has-session -t "$SESSION" 2>/dev/null; then
	echo "tmux session '$SESSION' already exists. Attach: tmux attach -t $SESSION"
	exit 0
fi

tmux new-session -d -s "$SESSION" -n main -c "$ROOT"

# Pane 0: core
tmux send-keys -t "$SESSION:main.0" \
	"cd $ROOT/packages/core && pnpm dev 2>&1 | tee -a $LOG_DIR/core.log" C-m

# Pane 1 (right): ui
tmux split-window -h -t "$SESSION:main.0" -c "$ROOT"
tmux send-keys -t "$SESSION:main.1" \
	"cd $ROOT/packages/ui && pnpm dev 2>&1 | tee -a $LOG_DIR/ui.log" C-m

# Pane 2 (bottom-left): caddy (runs in foreground, reload friendly)
tmux split-window -v -t "$SESSION:main.0" -c "$ROOT"
tmux send-keys -t "$SESSION:main.2" \
	"sudo -E DISPATCH_CADDY_LOG=$LOG_DIR/caddy.log caddy run --config $ROOT/infra/Caddyfile --adapter caddyfile" C-m

# Pane 3 (bottom-right): tailscale status watcher
tmux split-window -v -t "$SESSION:main.1" -c "$ROOT"
tmux send-keys -t "$SESSION:main.3" \
	"watch -n 5 'tailscale status | head -15; echo; tailscale funnel status'" C-m

tmux select-pane -t "$SESSION:main.0"
echo "tmux session '$SESSION' started. Attach: tmux attach -t $SESSION"
