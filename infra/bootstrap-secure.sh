#!/bin/bash
# Dispatch Kali — secure bootstrap (run once with sudo)
# - Fixes id_waha owner so adb can use it without sudo
# - Disables password auth on OpenSSH (key-only)
# - Creates persistent SSH tunnel to Pipeboard PG via systemd
# - Adds surgical NOPASSWD sudoers for adb (only Dispatch ops)
set -euo pipefail

echo "==> [1/6] chown id_waha → adb"
chown adb:adb /home/adb/.ssh/id_waha
chmod 600 /home/adb/.ssh/id_waha

echo "==> [2/6] hardening OpenSSH (PasswordAuth=no, key-only)"
install -m 644 /dev/stdin /etc/ssh/sshd_config.d/10-dispatch-hardening.conf <<HARDENING_EOF
# Dispatch hardening — added by dispatch-secure-bootstrap.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
PermitEmptyPasswords no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
HARDENING_EOF
sshd -t
systemctl reload ssh || systemctl reload sshd || true
echo "    ✓ sshd validated and reloaded"

echo "==> [3/6] pipeboard-tunnel.service"
install -m 644 /dev/stdin /etc/systemd/system/pipeboard-tunnel.service <<UNIT_EOF
[Unit]
Description=SSH tunnel to Pipeboard Postgres (localhost:25432 -> remote:15432)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=adb
Type=simple
ExecStart=/usr/bin/ssh -i /home/adb/.ssh/id_waha -N \
  -L 25432:localhost:15432 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new \
  claude@188.245.66.92
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT_EOF
systemctl daemon-reload
systemctl enable --now pipeboard-tunnel.service
sleep 2
systemctl is-active pipeboard-tunnel.service && echo "    ✓ tunnel active"
ss -ltnp | grep 25432 >/dev/null && echo "    ✓ tunnel listening on 25432" || echo "    ⚠ not listening yet (give it 5s)"

echo "==> [4/6] surgical NOPASSWD sudoers"
install -m 440 /dev/stdin /etc/sudoers.d/dispatch-ops <<SUDOERS_EOF
# Allow adb to manage Dispatch infra without password.
# Scope is narrow: only systemctl on Dispatch services + journal reads + tunnel restart.
# NOTE: do NOT widen this to ALL — it would defeat the SSH hardening.
adb ALL=(root) NOPASSWD: /bin/systemctl restart pipeboard-tunnel.service
adb ALL=(root) NOPASSWD: /bin/systemctl start pipeboard-tunnel.service
adb ALL=(root) NOPASSWD: /bin/systemctl stop pipeboard-tunnel.service
adb ALL=(root) NOPASSWD: /bin/systemctl status pipeboard-tunnel.service
adb ALL=(root) NOPASSWD: /bin/systemctl restart caddy.service
adb ALL=(root) NOPASSWD: /bin/systemctl reload caddy.service
adb ALL=(root) NOPASSWD: /bin/systemctl status caddy.service
adb ALL=(root) NOPASSWD: /bin/systemctl restart dispatch-core.service
adb ALL=(root) NOPASSWD: /bin/systemctl start dispatch-core.service
adb ALL=(root) NOPASSWD: /bin/systemctl stop dispatch-core.service
adb ALL=(root) NOPASSWD: /bin/systemctl status dispatch-core.service
adb ALL=(root) NOPASSWD: /bin/systemctl reset-failed dispatch-core.service
adb ALL=(root) NOPASSWD: /bin/journalctl -u pipeboard-tunnel.service *
adb ALL=(root) NOPASSWD: /bin/journalctl -u caddy.service *
adb ALL=(root) NOPASSWD: /bin/journalctl -u tailscaled.service *
adb ALL=(root) NOPASSWD: /bin/journalctl -u dispatch-core.service *
adb ALL=(root) NOPASSWD: /bin/journalctl -u dispatch-core *
adb ALL=(root) NOPASSWD: /usr/bin/tailscale funnel *
SUDOERS_EOF
visudo -cf /etc/sudoers.d/dispatch-ops >/dev/null && echo "    ✓ sudoers validated"

echo "==> [5/6] dispatch-core.service (Fastify API + Engine)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/dispatch-core.service" ]; then
  install -m 644 "${SCRIPT_DIR}/dispatch-core.service" /etc/systemd/system/dispatch-core.service
  systemctl daemon-reload
  systemctl enable dispatch-core.service
  echo "    ✓ dispatch-core.service installed and enabled (not started — start manually with: sudo systemctl start dispatch-core)"
else
  echo "    ⚠ dispatch-core.service not found next to bootstrap-secure.sh — skip"
fi

echo "==> [6/6] summary"
echo "    SSH password auth: $(grep -E "^PasswordAuthentication" /etc/ssh/sshd_config.d/10-dispatch-hardening.conf)"
echo "    Tunnel: $(systemctl is-active pipeboard-tunnel.service)"
echo "    Sudoers: /etc/sudoers.d/dispatch-ops installed"
echo
echo "✓ Bootstrap complete. Future SSH only with key, sudo only for whitelisted ops."
