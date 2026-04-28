#!/usr/bin/env bash
# finalize-deploy.sh — one-shot operator script to make every Phase 4-13 feature
# fully functional on the Kali host. Idempotent — safe to re-run.
#
# Run on Kali via:
#   ssh -t adb@dispatch 'sudo bash /var/www/debt-adb-framework/infra/finalize-deploy.sh'
#
# Steps:
#   1. apt install: apktool, jq, python3-pip
#   2. pip install (as adb user): frida-tools
#   3. Deploy Jaeger via existing infra/jaeger-deploy.sh
#   4. Copy updated Caddyfile to /etc/caddy/ and restart caddy
#   5. Append OTEL_* env vars to packages/core/.env if missing
#   6. Restart dispatch-core
#   7. Smoke test all surfaces

set -euo pipefail

REPO=/var/www/debt-adb-framework
ENV_FILE="$REPO/packages/core/.env"
ADB_USER=adb

echo "============================================================"
echo "  Dispatch Phase 4-13 Finalize Deploy"
echo "============================================================"

# ── Step 1: apt deps ──────────────────────────────────────────────
echo ""
echo "[1/7] Installing apt deps (apktool, jq, python3-pip)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apktool jq python3-pip python3-full python3-venv

# ── Step 2: frida-tools (per-user pip) ────────────────────────────
echo ""
echo "[2/7] Installing frida-tools for user '$ADB_USER'..."
if ! sudo -u "$ADB_USER" bash -lc 'command -v frida >/dev/null'; then
  sudo -u "$ADB_USER" bash -lc '
    if [ ! -d ~/.venv-frida ]; then python3 -m venv ~/.venv-frida; fi
    ~/.venv-frida/bin/pip install --upgrade pip frida-tools >/dev/null
    if ! grep -q ".venv-frida/bin" ~/.bashrc 2>/dev/null; then
      echo "export PATH=\"\$HOME/.venv-frida/bin:\$PATH\"" >> ~/.bashrc
    fi
    if ! grep -q ".venv-frida/bin" ~/.zshrc 2>/dev/null; then
      echo "export PATH=\"\$HOME/.venv-frida/bin:\$PATH\"" >> ~/.zshrc
    fi
  '
  echo "  frida installed at ~$ADB_USER/.venv-frida/bin/frida"
else
  echo "  frida already installed; skipping."
fi

# ── Step 3: Jaeger ────────────────────────────────────────────────
echo ""
echo "[3/7] Deploying Jaeger all-in-one..."
bash "$REPO/infra/jaeger-deploy.sh"

# ── Step 4: Caddy ─────────────────────────────────────────────────
echo ""
echo "[4/7] Updating /etc/caddy/Caddyfile..."
if ! cmp -s "$REPO/infra/Caddyfile" /etc/caddy/Caddyfile; then
  cp "$REPO/infra/Caddyfile" /etc/caddy/Caddyfile
  systemctl restart caddy
  echo "  Caddyfile updated and caddy restarted."
else
  echo "  Caddyfile already up to date."
fi

# ── Step 5: OTel env vars ─────────────────────────────────────────
echo ""
echo "[5/7] Appending OTEL_* env vars to $ENV_FILE if missing..."
ensure_env() {
  local key="$1" val="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    echo "${key}=${val}" >> "$ENV_FILE"
    echo "  added ${key}"
  else
    echo "  ${key} already set; skipping."
  fi
}
ensure_env OTEL_ENABLED true
ensure_env OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:4318/v1/traces
ensure_env OTEL_SERVICE_NAME dispatch-core
chown "$ADB_USER:$ADB_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── Step 6: Restart dispatch-core ─────────────────────────────────
echo ""
echo "[6/7] Restarting dispatch-core..."
systemctl restart dispatch-core.service
sleep 4
systemctl is-active dispatch-core.service

# ── Step 7: Smoke test all surfaces ───────────────────────────────
echo ""
echo "[7/7] Smoke tests..."

echo -n "  apktool         → "
sudo -u "$ADB_USER" apktool --version 2>&1 | head -1 || echo "FAIL"

echo -n "  jq              → "
jq --version || echo "FAIL"

echo -n "  frida           → "
sudo -u "$ADB_USER" bash -lc '~/.venv-frida/bin/frida --version' 2>&1 | head -1 || echo "FAIL"

echo -n "  Jaeger UI       → "
if curl -sS --max-time 5 -o /dev/null -w "HTTP %{http_code}" http://127.0.0.1:16686/ ; then echo ""; else echo " FAIL"; fi

echo -n "  dispatch-core   → "
curl -sS --max-time 5 http://127.0.0.1:8080/healthz | head -c 200
echo ""

echo -n "  /admin/jaeger   → "
curl -sS --max-time 5 -o /dev/null -w "HTTP %{http_code} (expects 401 unauthenticated)" http://127.0.0.1:8080/admin/jaeger
echo ""

echo ""
echo "============================================================"
echo "  Finalize complete. Next steps:"
echo "  - Send a test message to verify traces in Jaeger UI"
echo "    (https://dispatch.tail106aa2.ts.net/admin/jaeger — Bearer required)"
echo "  - Optionally set DISPATCH_ALERT_SLACK_WEBHOOK or"
echo "    DISPATCH_ALERT_TELEGRAM_BOT_TOKEN/CHAT_ID in .env to enable alerts"
echo "  - For monthly APK snapshots, schedule via cron:"
echo "    0 3 1 * * $REPO/scripts/apk-snapshot.sh <device-serial>"
echo "============================================================"
