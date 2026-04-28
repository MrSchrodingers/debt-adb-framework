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
echo "[1/7] Installing apt deps (apktool, jq, python3-pip, scrcpy)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq apktool jq python3-pip python3-full python3-venv scrcpy

# ── Step 2: frida-tools (per-user pip) + frida-server download ────
echo ""
echo "[2/7] Installing frida-tools + frida-server (host + device)..."
sudo -u "$ADB_USER" bash -lc '
  set -e
  if ! command -v ~/.venv-frida/bin/frida >/dev/null 2>&1; then
    if [ ! -d ~/.venv-frida ]; then python3 -m venv ~/.venv-frida; fi
    ~/.venv-frida/bin/pip install --upgrade pip frida-tools >/dev/null
    grep -q ".venv-frida/bin" ~/.bashrc 2>/dev/null || echo "export PATH=\"\$HOME/.venv-frida/bin:\$PATH\"" >> ~/.bashrc
    grep -q ".venv-frida/bin" ~/.zshrc  2>/dev/null || echo "export PATH=\"\$HOME/.venv-frida/bin:\$PATH\"" >> ~/.zshrc
  fi
  FRIDA_VER="$(~/.venv-frida/bin/frida --version)"
  if [ ! -f ~/frida-server ]; then
    echo "  downloading frida-server-${FRIDA_VER}-android-arm64..."
    curl -sSL -o ~/frida-server.xz "https://github.com/frida/frida/releases/download/${FRIDA_VER}/frida-server-${FRIDA_VER}-android-arm64.xz"
    xz -d ~/frida-server.xz
    chmod +x ~/frida-server
  fi
'
echo "  frida client: $(sudo -u "$ADB_USER" bash -lc '~/.venv-frida/bin/frida --version')"
echo "  frida-server binary: $(ls -la $(getent passwd $ADB_USER | cut -d: -f6)/frida-server 2>/dev/null | awk "{print \$5}") bytes"

# Install/start frida-server on the device if a device is connected
SERIAL="$(sudo -u "$ADB_USER" adb devices 2>/dev/null | awk 'NR==2 {print $1}')"
if [ -n "$SERIAL" ]; then
  echo "  pushing frida-server to device $SERIAL..."
  sudo -u "$ADB_USER" bash -lc "
    cd /var/www/debt-adb-framework
    bash research/frida/setup-device.sh '$SERIAL' ~/frida-server 2>&1 | tail -5
  " || echo "  (frida-server setup had warnings; check manually with research/frida/setup-device.sh)"
else
  echo "  no ADB device connected; skipping frida-server push."
fi

# ── Step 2b: apktool-modern (upstream JAR, distro 2.7 is too old for WA) ──
echo ""
echo "[2b/7] Installing apktool-modern (upstream JAR)..."
sudo -u "$ADB_USER" bash -lc '
  set -e
  mkdir -p ~/.local/bin
  if [ ! -f ~/.local/bin/apktool.jar ]; then
    curl -sSL -o ~/.local/bin/apktool.jar https://github.com/iBotPeaches/Apktool/releases/download/v2.10.0/apktool_2.10.0.jar
  fi
  cat > ~/.local/bin/apktool-modern << "EOF"
#!/usr/bin/env bash
exec java -jar "$HOME/.local/bin/apktool.jar" "$@"
EOF
  chmod +x ~/.local/bin/apktool-modern
  ~/.local/bin/apktool-modern --version
'

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

echo -n "  apktool-modern  → "
sudo -u "$ADB_USER" bash -lc '~/.local/bin/apktool-modern --version' 2>&1 | head -1 || echo "FAIL"

echo -n "  jq              → "
jq --version || echo "FAIL"

echo -n "  frida (client)  → "
sudo -u "$ADB_USER" bash -lc '~/.venv-frida/bin/frida --version' 2>&1 | head -1 || echo "FAIL"

echo -n "  frida-server    → "
SERIAL="$(sudo -u "$ADB_USER" adb devices 2>/dev/null | awk 'NR==2 {print $1}')"
if [ -n "$SERIAL" ]; then
  sudo -u "$ADB_USER" adb -s "$SERIAL" shell "su -c 'pidof frida-server'" 2>/dev/null \
    && echo "  (running on $SERIAL)" || echo "NOT RUNNING on device"
else
  echo "no ADB device"
fi

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
