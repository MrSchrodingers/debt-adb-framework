#!/usr/bin/env bash
# Dispatch — prod-like session (UI served as static build via `vite preview`)
set -euo pipefail

SESSION="${DISPATCH_SESSION:-dispatch}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${ROOT}/infra/logs"
mkdir -p "$LOG_DIR"

if tmux has-session -t "$SESSION" 2>/dev/null; then
	echo "tmux session '$SESSION' already exists. Attach: tmux attach -t $SESSION"
	exit 0
fi

# Ensure UI is built
if [[ ! -d "$ROOT/packages/ui/dist" ]]; then
	echo "UI build missing — running pnpm --filter ui build..."
	(cd "$ROOT" && pnpm --filter ui build)
fi

tmux new-session -d -s "$SESSION" -n main -c "$ROOT"

# Pane 0: core (production entrypoint)
tmux send-keys -t "$SESSION:main.0" \
	"cd $ROOT/packages/core && NODE_ENV=production pnpm dev 2>&1 | tee -a $LOG_DIR/core.log" C-m

# Pane 1: ui preview (static)
tmux split-window -h -t "$SESSION:main.0" -c "$ROOT"
tmux send-keys -t "$SESSION:main.1" \
	"cd $ROOT/packages/ui && pnpm preview --host 127.0.0.1 --port 5174 2>&1 | tee -a $LOG_DIR/ui.log" C-m

# Pane 2: caddy (logs to stdout)
tmux split-window -v -t "$SESSION:main.0" -c "$ROOT"
tmux send-keys -t "$SESSION:main.2" \
	"sudo caddy run --config $ROOT/infra/Caddyfile --adapter caddyfile" C-m

# Pane 3: tailscale
tmux split-window -v -t "$SESSION:main.1" -c "$ROOT"
tmux send-keys -t "$SESSION:main.3" \
	"watch -n 5 'tailscale status | head -15; echo; tailscale funnel status'" C-m

tmux select-pane -t "$SESSION:main.0"
echo "tmux session '$SESSION' (prod-like) started. Attach: tmux attach -t $SESSION"
