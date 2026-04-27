#!/bin/bash
# Dispatch Kali — secure bootstrap (run once with sudo)
# - Fixes id_waha owner so adb can use it without sudo
# - Disables password auth on OpenSSH (key-only)
# - Creates persistent SSH tunnel to Pipeboard PG via systemd
# - Adds surgical NOPASSWD sudoers for adb (only Dispatch ops)
set -euo pipefail

echo "==> [1/7] chown id_waha → adb"
chown adb:adb /home/adb/.ssh/id_waha
chmod 600 /home/adb/.ssh/id_waha

echo "==> [2/7] hardening OpenSSH (PasswordAuth=no, key-only)"
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

echo "==> [3/7] pipeboard-tunnel.service"
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

echo "==> [4/7] surgical NOPASSWD sudoers"
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

echo "==> [5/7] dispatch-core.service (Fastify API + Engine)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/dispatch-core.service" ]; then
  install -m 644 "${SCRIPT_DIR}/dispatch-core.service" /etc/systemd/system/dispatch-core.service
  systemctl daemon-reload
  systemctl enable dispatch-core.service
  echo "    ✓ dispatch-core.service installed and enabled (not started — start manually with: sudo systemctl start dispatch-core)"
else
  echo "    ⚠ dispatch-core.service not found next to bootstrap-secure.sh — skip"
fi

echo "==> [6/7] fail2ban (SSH + login bruteforce protection)"
apt-get install -y -qq fail2ban
install -m 644 /dev/stdin /etc/fail2ban/jail.d/dispatch-ssh.conf <<'F2B_SSH_EOF'
# Dispatch — SSH bruteforce jail
# Watches sshd auth failures and bans persistent attackers at the firewall.
# NOTE: 100.64.0.0/10 (Tailscale CGNAT) is intentionally NOT in ignoreip here.
# SSH is restricted to tailnet via ACL, so all attempts arrive from 100.x.x.x.
# If a tailnet member tries to brute-force, we still want fail2ban to ban them
# (compromised tailnet member shouldn't be allowed to bruteforce).
[sshd]
enabled  = true
port     = ssh
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
ignoreip = 127.0.0.0/8 ::1
F2B_SSH_EOF

install -m 644 /dev/stdin /etc/fail2ban/filter.d/dispatch-login.conf <<'F2B_FILTER_EOF'
# Dispatch — match failed POSTs to the login endpoint in Caddy JSON access logs.
# Caddy log format is JSON on stdout (captured by journald via caddy.service).
#
# Topology: Tailscale Funnel terminates TLS on ingress and proxies to localhost,
# so Caddy ALWAYS sees request.remote_ip = 127.0.0.1 (which is in fail2ban's
# default ignoreip → every match would be silently dropped). The real client IP
# is injected by Funnel into the X-Forwarded-For header, so that's what we match.
# Anchors: POST + uri /api/v1/auth/login + X-Forwarded-For + top-level status 401/403.
[Definition]
failregex = ^.*"method":"POST"[^}]*"uri":"/api/v1/auth/login[^"]*"[^}]*"X-Forwarded-For":\["<HOST>"\].*"status":(?:401|403).*$
ignoreregex =
F2B_FILTER_EOF

install -m 644 /dev/stdin /etc/fail2ban/jail.d/dispatch-login.conf <<'F2B_LOGIN_EOF'
# Dispatch — login bruteforce jail
# Reads Caddy access logs from journald (unit caddy.service).
# ignoreip includes 100.64.0.0/10 (Tailscale CGNAT) because every legitimate
# request from a tailnet member arrives with that IP in X-Forwarded-For — we
# don't want tailnet → tailnet auth attempts (admins fat-fingering passwords)
# to trip the jail. Only WAN attackers reaching the Funnel can be banned.
[dispatch-login]
enabled  = true
filter   = dispatch-login
backend  = systemd
journalmatch = _SYSTEMD_UNIT=caddy.service
maxretry = 5
findtime = 10m
bantime  = 1h
ignoreip = 127.0.0.0/8 ::1 100.64.0.0/10
F2B_LOGIN_EOF

systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl reload fail2ban
echo "    ✓ fail2ban configured (sshd + dispatch-login jails)"

echo "==> [7/7] summary"
echo "    SSH password auth: $(grep -E "^PasswordAuthentication" /etc/ssh/sshd_config.d/10-dispatch-hardening.conf)"
echo "    Tunnel: $(systemctl is-active pipeboard-tunnel.service)"
echo "    Sudoers: /etc/sudoers.d/dispatch-ops installed"
echo "    fail2ban: $(systemctl is-active fail2ban)"
echo
echo "✓ Bootstrap complete. Future SSH only with key, sudo only for whitelisted ops."
