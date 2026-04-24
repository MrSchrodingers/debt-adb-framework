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
├── Caddyfile        # reverse proxy config
├── README.md        # this file
├── tmux-dev.sh      # dev session (HMR)
├── tmux-prod.sh     # prod-like session (static UI)
├── logs/            # runtime logs (git-ignored)
└── run/             # pid files, sockets (git-ignored)
```

See the root `Makefile` for target definitions.
