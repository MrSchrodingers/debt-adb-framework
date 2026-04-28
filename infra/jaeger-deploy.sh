#!/usr/bin/env bash
# jaeger-deploy.sh — Install and start Jaeger all-in-one on Kali.
# Idempotent: safe to re-run.
# Usage: sudo bash /tmp/jaeger-deploy.sh
set -euo pipefail

echo "[1/4] Installing docker.io if missing..."
if ! command -v docker > /dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y docker.io
else
  echo "  docker already installed: $(docker --version)"
fi

echo "[2/4] Enabling and starting docker daemon..."
systemctl enable --now docker

echo "[3/4] Starting Jaeger all-in-one container..."
# Remove stale container if it exists (handles version upgrades / config changes)
if docker ps -a --format '{{.Names}}' | grep -q '^jaeger$'; then
  echo "  Removing existing jaeger container..."
  docker rm -f jaeger
fi

# Bind all ports to 127.0.0.1 so they are NOT exposed to the public interface.
# Caddy + Tailscale Funnel are the only inbound paths.
#
#   4317 — OTLP gRPC  (not used by dispatch-core; kept for future use)
#   4318 — OTLP HTTP  (dispatch-core exports traces here)
#   16686 — Jaeger UI (Caddy proxies /admin/jaeger/* here)
docker run -d --name jaeger \
  --restart=unless-stopped \
  -p 127.0.0.1:4317:4317 \
  -p 127.0.0.1:4318:4318 \
  -p 127.0.0.1:16686:16686 \
  jaegertracing/all-in-one:latest

echo "[4/4] Verifying Jaeger is reachable..."
sleep 3
if curl -sS --fail http://127.0.0.1:16686/ > /dev/null; then
  echo "  Jaeger UI reachable on :16686"
else
  echo "  WARNING: Jaeger UI did not respond — check container logs below"
fi
docker logs --tail 10 jaeger

cat <<'EOF'

Done. Next steps:
  1. Restart dispatch-core so it picks up OTEL env vars:
       make -C /var/www/adb_tools core-restart
  2. Set the following in /var/www/adb_tools/.env (if not already set):
       OTEL_ENABLED=true
       OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces
       OTEL_SERVICE_NAME=dispatch-core
  3. Open Jaeger UI via the Caddy path (requires valid bearer token):
       https://dispatch.tail106aa2.ts.net/admin/jaeger
EOF
