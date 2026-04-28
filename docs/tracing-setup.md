# Tracing Setup — Jaeger on Kali via Tailscale Funnel

Dispatch embeds OpenTelemetry auto-instrumentation (OTLP HTTP exporter).
The instrumentation code is deployed and compiled; it is **disabled by default**
via `OTEL_ENABLED`. Follow the steps below to turn it on.

## Prerequisites

- Kali server with Tailscale installed and the `dispatch.tail106aa2.ts.net` funnel active
- Caddy running with `infra/Caddyfile` (handles `/admin/jaeger*` reverse proxy)
- Docker available (`apt-get install -y docker.io` if missing)
- A valid Dispatch bearer token (from `POST /api/v1/auth/login`)

---

## Step 1 — Deploy Jaeger on Kali

Copy `infra/jaeger-deploy.sh` to the server and run it as root. It is idempotent:
re-running on an already-configured machine removes the old container and starts a fresh one.

```bash
scp infra/jaeger-deploy.sh root@<kali-ip>:/tmp/jaeger-deploy.sh
ssh root@<kali-ip> sudo bash /tmp/jaeger-deploy.sh
```

The script:
1. Installs `docker.io` if missing.
2. Enables and starts the Docker daemon.
3. Runs `jaegertracing/all-in-one:latest` bound to `127.0.0.1` on ports:
   - `4318` — OTLP HTTP (dispatch-core exports here)
   - `16686` — Jaeger UI (Caddy proxies via `/admin/jaeger`)
4. Verifies Jaeger UI is reachable on `:16686`.

---

## Step 2 — Configure Caddy

If Caddy is already running with the project `infra/Caddyfile`, the
`/admin/jaeger*` reverse proxy block is already present. If you replaced the
Caddyfile manually, copy it now:

```bash
sudo cp infra/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The relevant block in `Caddyfile`:

```caddyfile
handle /admin/jaeger* {
    forward_auth 127.0.0.1:7890 {
        uri /api/v1/auth/check-bearer
        copy_headers Authorization
    }
    reverse_proxy 127.0.0.1:16686 {
        header_up Host {host}
    }
}
```

Caddy calls `GET /api/v1/auth/check-bearer` on dispatch-core before proxying to
Jaeger. Any request with a valid `Authorization: Bearer <token>` header will pass.

---

## Step 3 — Enable tracing in dispatch-core

Append the following lines to `/var/www/adb_tools/.env` (or the `.env` file used
by your `dispatch-core.service`):

```env
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces
OTEL_SERVICE_NAME=dispatch-core
```

---

## Step 4 — Restart dispatch-core

```bash
sudo systemctl restart dispatch-core
# or, if running under tmux/pm2:
make -C /var/www/adb_tools core-restart
```

Confirm the service started cleanly:

```bash
journalctl -u dispatch-core -n 50 --no-pager
```

Look for a line containing `OTEL` or `OpenTelemetry` to confirm the SDK initialised.

---

## Step 5 — Verify traces

1. Send a test message through the Dispatch UI (or `curl POST /api/v1/messages`).
2. Open the Jaeger UI — requires a valid bearer token in the `Authorization` header:
   ```
   https://dispatch.tail106aa2.ts.net/admin/jaeger
   ```
   Browsers will be redirected to the Dispatch login page first (Caddy's
   `forward_auth` returns 401 if no token is present). After logging in, the token
   is stored in `localStorage` and subsequent requests to `/admin/jaeger` will pass.
3. In the Jaeger UI, select service **dispatch-core** and click **Find Traces**.
   You should see spans for `POST /api/v1/messages`, SQLite queries, and ADB commands.

---

## Troubleshooting

### Caddy admin endpoint disabled error

The `Caddyfile` includes `admin off` in the global block. This is intentional —
Caddy's admin API is not needed and disabling it reduces the attack surface.
If you see errors about the admin endpoint, ignore them; they are unrelated to the
`forward_auth` directive.

### Jaeger UI shows "Service not found"

Dispatch has not yet sent any traces. Send at least one message via the API and
retry. Traces are not back-filled.

### `forward_auth` returns 401 for all requests

The bearer token is missing or expired. Symptoms: browser redirects to the login
page in a loop. Solution: log in at `https://dispatch.tail106aa2.ts.net` and try
again. Tokens expire after 15 minutes; refresh tokens are valid for 24 hours.

### Tailscale IP whitelist / funnel not forwarding

Verify the Tailscale funnel is active:

```bash
tailscale funnel status
```

If the funnel is down, restart it:

```bash
tailscale funnel --bg 443
```

### OTLP connection refused / traces not appearing

Ensure Jaeger is running and listening on `127.0.0.1:4318`:

```bash
docker ps | grep jaeger
curl -s http://127.0.0.1:16686/ | head -5
```

If the container is stopped:

```bash
docker start jaeger
```

### Large trace volume / disk usage

Jaeger all-in-one uses in-memory storage by default. Traces are lost on container
restart. For production persistence, replace the container with a Jaeger deployment
backed by Elasticsearch or Cassandra. For development, the default is fine.
