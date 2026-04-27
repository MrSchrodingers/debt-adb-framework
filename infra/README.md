# Dispatch — Infra (Kali physical server)

Operational runbook for the always-on Kali host that runs:

- **Core** (Fastify API) — `127.0.0.1:7890`
- **UI** (Vite) — `127.0.0.1:5174`
- **Caddy** (reverse proxy) — `127.0.0.1:8080`
- **Tailscale Funnel** — public HTTPS on `:443` → Caddy

```
Internet  ──443──►  Tailscale Funnel  ──►  Caddy :8080  ──┬──►  UI    :5174
                     (*.<tailnet>.ts.net)                 ├──►  Core  :7890  (REST + Socket.IO)
                                                           └──►  /plugin/*    (Oralsin callbacks)
```

## First-time setup

```bash
git clone git@github.com:MrSchrodingers/debt-adb-framework.git
cd debt-adb-framework
make install         # apt deps, node, pnpm, adb, tailscale, caddy
make tailscale-up    # opens browser-auth URL
make build
make up              # tmux session: core + ui + caddy + tailscale watch
make funnel-up       # expose https://<host>.<tailnet>.ts.net
make funnel-status   # confirm the URL
```

### Secure bootstrap (run once after first SSH-in)

`infra/bootstrap-secure.sh` hardens the host. Copy it to `/tmp` and run with sudo:

```bash
scp infra/bootstrap-secure.sh adb@dispatch:/tmp/
ssh -t adb@dispatch 'sudo bash /tmp/bootstrap-secure.sh'
```

What it does (one-time, idempotent):

1. `chown adb:adb /home/adb/.ssh/id_waha` — lets the systemd service
   (User=adb) use the key without sudo.
2. Installs `/etc/ssh/sshd_config.d/10-dispatch-hardening.conf`:
   `PasswordAuthentication=no`, `PubkeyAuthentication=yes`,
   `PermitRootLogin=prohibit-password`, `MaxAuthTries=3`. Validates with
   `sshd -t` before reload — won't break the live session.
3. Installs `/etc/systemd/system/pipeboard-tunnel.service` (User=adb,
   Restart=always, ServerAliveInterval=30) and enables it. Required by
   the `adb-precheck` plugin to reach Pipeboard Postgres.
4. Installs `/etc/sudoers.d/dispatch-ops` with **surgical NOPASSWD**:
   only `systemctl restart/start/stop/status/reload` of `pipeboard-tunnel`
   and `caddy`, plus `journalctl -u <those>` and `tailscale funnel *`.
   No `ALL`. `apt`, `rm`, etc. still prompt for password.

Tailscale SSH continues to work because Tailscale intercepts port 22 from
tailnet peers before OpenSSH sees the connection — identity-based auth
is unaffected by `PasswordAuthentication=no`.

## Prerequisites in the Tailscale admin console (1x per tailnet)

1. **DNS** → enable MagicDNS + HTTPS certificates.
2. **Access Controls → ACLs**: grant Funnel capability to the operator.
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
3. Take note of the tailnet name (shown in `tailscale status`).

## Daily ops

| Task | Command |
|------|---------|
| Bring everything up (dev, HMR) | `make up` |
| Bring everything up (prod-like) | `make up-prod` |
| Attach tmux | `make attach` |
| Tail logs | `make logs` |
| Stop session | `make down` |
| Restart Caddy only | `make caddy-reload` |
| Expose publicly | `make funnel-up` |
| Take offline | `make funnel-down` |
| Quick health probe | `make health` |
| Environment sanity check | `make doctor` |

## Core service (systemd)

Production runs the Fastify Core under systemd (not tmux). The unit file lives
in this repo at `infra/dispatch-core.service` and is installed to
`/etc/systemd/system/dispatch-core.service` by `bootstrap-secure.sh` (block 5/6).

Hardening flags: `NoNewPrivileges`, `ProtectSystem=strict`,
`ProtectHome=read-only`, `PrivateTmp`, `ProtectKernelTunables/Modules/ControlGroups`.
Memory ceiling: `MemoryHigh=1G`, `MemoryMax=2G`. File handles: `LimitNOFILE=65536`.
Restart: `Restart=always`, `RestartSec=5`, with a 10-burst / 300s start-limit
guard. Depends on `pipeboard-tunnel.service` (Pipeboard Postgres).

Logs go to journald (`SyslogIdentifier=dispatch-core`), not files.

| Task | Command |
|------|---------|
| Start core | `make core-up` |
| Stop core | `make core-down` |
| Restart core | `make core-restart` |
| Tail journal (live) | `make core-logs` |
| Status | `make core-status` |

These targets SSH to `adb@dispatch` and call `sudo systemctl …` — the
NOPASSWD entries for `dispatch-core.service` are installed by
`bootstrap-secure.sh` block 4/6.

> **NVM pinning warning**: `dispatch-core.service` pins both `ExecStart` and
> `Environment=PATH` to the exact NVM Node version (currently `v22.22.2`).
> After any `nvm install <newer>` or `nvm alias default <newer>` on Kali, the
> service will keep launching the old Node — possibly silently if the old
> binary still exists. To upgrade: edit `infra/dispatch-core.service`, commit,
> then redeploy via the **Updating the unit file** runbook below.

### Applying the reset-failed extension (one-time on existing hosts)

Hosts bootstrapped before Task 2.1 B5 are missing the `systemctl reset-failed
dispatch-core.service` NOPASSWD entry. `infra/dispatch-core-sudoers-extend.sh`
applies it surgically and idempotently (safe to re-run). On a fresh
`bootstrap-secure.sh` run this is already covered — only run the extender on
pre-existing hosts.

```bash
scp infra/dispatch-core-sudoers-extend.sh adb@dispatch:/tmp/
ssh -t adb@dispatch 'sudo bash /tmp/dispatch-core-sudoers-extend.sh'
```

The script validates the resulting sudoers file with `visudo -cf` before
atomically replacing `/etc/sudoers.d/dispatch-ops`.

### Updating the unit file

Edit `infra/dispatch-core.service` locally, commit, then on Kali:

```bash
sudo install -m 644 /var/www/adb_tools/infra/dispatch-core.service \
  /etc/systemd/system/dispatch-core.service
sudo systemctl daemon-reload
make -C /var/www/adb_tools core-restart
```

### Rebuilding the core after a deploy

The unit's `ExecStartPre` checks for `dist/main.js`. Always rebuild before
restart:

```bash
ssh adb@dispatch 'cd /var/www/debt-adb-framework && pnpm --filter @dispatch/core build'
make -C /var/www/adb_tools core-restart
```

## Troubleshooting

### Funnel is up but 502s

- Caddy up? `systemctl status caddy` or check the tmux Caddy pane.
- Core up? `curl -fsS localhost:7890/healthz`
- UI up? `curl -fsS localhost:5174`
- Funnel listening? `tailscale funnel status` must show `https://<host>.ts.net (Funnel on)`.

### Caddy logs

Caddy runs under a systemd sandbox that blocks writes to `/var/log/caddy`, so
we keep logs on stdout and let journalctl collect them:

```bash
sudo journalctl -u caddy -f         # live tail
sudo journalctl -u caddy -n 200     # last 200 lines
```

### UI loads but HMR fails over Funnel

Expected — we pin `hmr.clientPort = 443` in `vite.config.ts`. If you changed the Funnel port, update the config accordingly.

### ADB devices not visible

- `adb devices` (host) — empty means udev or daemon issue.
- `sudo usermod -aG plugdev $USER` → log out/in.
- Replug device; authorize RSA key prompt on Android.

### Tailscale ACL won't allow Funnel

Check `tailscale funnel status` — the error message includes the exact ACL tag required. Usually fixed by adding `"attr": ["funnel"]` to the right node.

## File layout

```
infra/
├── Caddyfile               # reverse proxy config
├── README.md               # this file
├── bootstrap-secure.sh     # one-time host hardening + service install
├── dispatch-core-sudoers-extend.sh  # idempotent reset-failed sudoers patch
├── dispatch-core.service   # systemd unit for Fastify Core (prod)
├── tmux-dev.sh             # dev session (HMR)
├── tmux-prod.sh            # prod-like session (static UI)
├── logs/                   # runtime logs (git-ignored)
└── run/                    # pid files, sockets (git-ignored)
```

See the root `Makefile` for target definitions.
