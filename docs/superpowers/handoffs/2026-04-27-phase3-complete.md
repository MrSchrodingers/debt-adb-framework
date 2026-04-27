# Handoff — 2026-04-27 — Phase 3 complete, ready for Phase 4

**Repo**: https://github.com/MrSchrodingers/debt-adb-framework
**Branch**: `main` (HEAD: `fc591b88`)
**Plan being executed**: `docs/superpowers/plans/2026-04-27-dispatch-platform-overhaul.md` (1785 lines, 13 phases, 47 features)
**Last session**: dispatched subagent-driven implementation, 7 tasks completed (P1+P2+P3 quick wins + full Phase 3).

---

## What was done in the last session

| # | Task | Commits | What landed |
|---|---|---|---|
| 1 | **2.1** systemd unit `dispatch-core.service` | `6ce25309` + `89fa5f17` | tmux→systemd migration, Restart=always, hardening flags, NOPASSWD ops (start/stop/restart/status + journalctl + reset-failed), Makefile `core-*` targets, `infra/dispatch-core-sudoers-extend.sh` |
| 2 | **1.1** fail2ban (SSH + login) | `2741765e` + `a2bfc2f8` | sshd jail, dispatch-login jail (X-Forwarded-For for Tailscale Funnel), Caddy `log { output stdout; format json }` directive, ignoreip=`127.0.0.0/8 ::1 100.64.0.0/10` for login jail |
| 3 | **3.1** bcrypt password | `64dc6aa4` | `password-hash.ts` (isPasswordHashed/hashPassword/verifyPassword), 12 rounds bcryptjs, plaintext fallback for migration, `scripts/hash-password.ts` CLI, .env on Kali was hashed in-place + backup taken |
| 4 | **3.2** HMAC outbound | `7c9306c1` | `X-Dispatch-Signature: sha256=<hex>` on all callback POSTs (was bare hex pre-fix — inbound/outbound mismatch silent bug squashed), `buildHeaders()` helper |
| 5 | **3.3** Bearer-only UI | `44ab0ab2` | API_KEY/VITE_API_KEY/`__DISPATCH_API_KEY__` removed from UI bundle, screenshots load via `fetch + URL.createObjectURL(blob)` instead of `<img src="?key=…">` |
| 6 | **3.4** JWT refresh tokens | `fc591b88` | RefreshTokenStore (sqlite, sha256-hashed opaque tokens, atomic rotate transaction), `POST /api/v1/auth/refresh`, 15min access JWT + 24h refresh, UI auto-refresh ~60s before expiry + 401-replay |

**Test count**: 876 baseline → **922 passing** (+46 net new). 0 failures.
**Commit count this session**: 7. **Bytes pushed**: ~1500 LOC (test-heavy).

### Code-audit follow-up (post Task 3.3)

Audited X-API-Key consumers across the codebase:
- UI: ✅ fully clean (no `API_KEY` / `X-API-Key` / `__DISPATCH_API_KEY__` references in `packages/ui/src/` or in built `dist/assets/*.js`)
- Backend: 🔵 `X-API-Key` path **intentionally active** for service-to-service. `api-auth.ts:65` accepts X-API-Key OR Bearer JWT — both optional, any one passes. Live test from Kali: `curl -H "X-API-Key: $KALI_KEY" /api/v1/devices` → HTTP 200.
- Implementer of 3.3 had falsely concluded "static API key retired" — the 401 they observed was from a stale local `.env` key (RNJ0gf-U…) that doesn't match Kali (JaVcAgC5…). Local `.env` is dev-only; production is fine.

Decision: X-API-Key remains by design. If team wants to retire it, separate Phase 8 task with stakeholder migration (Oralsin Django still uses `X-API-Key: <PLUGIN_ORALSIN_API_KEY>` per `docs/contract-dispatch-oralsin.md:12`).

---

## Production state at handoff

```
SSH:                    ssh adb@dispatch  (Tailscale MagicDNS, passwordless)
Public URL:             https://dispatch.tail106aa2.ts.net
Service:                dispatch-core.service (systemd, active, healthy)
                        MainPID changes per restart; survives reboot
Devices online:         2/2 (POCO C71 pair, serials 9b01005930533036340030832250ac + …9bac)
Plugins active:         adb-precheck, oralsin
Pipeboard tunnel:       systemd pipeboard-tunnel.service (127.0.0.1:25432 → 188.245.66.92:15432)
Caddy:                  active (running since 2026-04-24, JSON access logs to journald)
fail2ban:               active, jails: sshd + dispatch-login (XFF-aware)
Repo HEAD on Kali:      fc591b88 (synced with origin/main)
.env perms:             /var/www/debt-adb-framework/packages/core/.env  600 owner=adb
DISPATCH_AUTH_PASSWORD: bcrypt $2b$12$… (hashed in this session — backup at .env.bak.20260427-182511)
Cleared SSH key quarantine: /home/adb/quarantine/touch-2026-04-27 (ED25519, mrschrodingers@gmail.com — preserve or destroy at user discretion)
```

### Live healthz
```bash
curl -sS https://dispatch.tail106aa2.ts.net/healthz
# {"status":"healthy","devices":{"online":2,"total":2},"queue":{"pending":0,"processing":0,"failed_last_hour":0},"plugins":{"adb-precheck":"active","oralsin":"active"},"failed_callbacks":0}
```

---

## Connection & execution constants

```
SSH_HOST            = adb@dispatch         (preferred — MagicDNS)
SSH_HOST_IP         = adb@100.77.249.93
KALI_REPO_PATH      = /var/www/debt-adb-framework
LOCAL_REPO_PATH     = /var/www/adb_tools
PUBLIC_URL          = https://dispatch.tail106aa2.ts.net
LOGIN_USERNAME      = debt
LOGIN_PASSWORD      = (bcrypt-hashed in Kali .env; plaintext is in user's password manager)
TEST_PHONE_NUMBER   = 5543991938235  (NEVER any other number for dev tests)
KALI_SUDOERS        = /etc/sudoers.d/dispatch-ops  (NOPASSWD cirurgical)
ENV_FILE            = /var/www/debt-adb-framework/packages/core/.env  (perms 600 adb:adb)
```

### NOPASSWD entries currently configured
```
/bin/systemctl {start,stop,restart,status,reset-failed} dispatch-core.service
/bin/journalctl -u dispatch-core{.service,} *
/bin/systemctl {restart,reload,status} caddy.service
/bin/journalctl -u caddy.service *
/bin/systemctl status pipeboard-tunnel.service
/bin/journalctl -u pipeboard-tunnel.service *
/bin/systemctl status tailscaled.service
/usr/bin/tailscale funnel status
```

### Things that STILL need a sudo password (for follow-up #7)
- `apt install`, `apt update`
- `tee` / `install` to `/etc/*` paths
- `systemctl reload fail2ban`, `fail2ban-client *`
- Editing `/etc/sudoers.d/dispatch-ops` itself

---

## Workflow conventions (per CLAUDE.md + observed)

**Each feature**:
```
1. Edit code in /var/www/adb_tools (LOCAL)
2. pnpm --filter @dispatch/<pkg> build
3. pnpm --filter @dispatch/<pkg> test  (filtered if possible)
4. git add … && git commit -m "type(scope): msg" && git push origin main
5. ssh adb@dispatch 'cd /var/www/debt-adb-framework && git pull --ff-only && pnpm install --frozen-lockfile && pnpm --filter @dispatch/<pkg> build'
6. make -C /var/www/adb_tools core-restart   (uses NOPASSWD)
7. Smoke test via curl loopback or Funnel
```

**Branch policy**: stay on `main`. Plan Step 0.6 explicitly says no feature branches.

**Sudo-required deploys**: stage a script on Kali at `/tmp/<task>.sh`, then ask user to run `ssh -t adb@dispatch 'sudo bash /tmp/<task>.sh'`. Pattern is well-established (see `dispatch-core-sudoers-extend.sh`, `dispatch-fail2ban-deploy.sh`).

**Caddy reload**: BROKEN — admin endpoint `:2019` is disabled in Caddyfile global block. Use `systemctl restart caddy` instead (~1s downtime is acceptable). Already in NOPASSWD.

**make up-prod**: confirmed running `tsx src/main.ts` (dev hot-reload mode), NOT `node dist/main.js`. systemd unit IS correct (`node dist/main.js`). `make up-prod` is misnamed/misconfigured — orphaned process from `make down` not killing tmux child was the bug behind Task 2.1's deploy hiccup. **Tracked as task #4 follow-up.**

---

## Pending tasks (TaskList state at handoff)

### Critical-path remaining in plan

| # | Task | Phase | Estimate |
|---|---|---|---|
| — | **4.1** failed_callbacks abandoned + dead-letter | P4 | M |
| — | **4.2** Circuit breaker per device | P4 | M |
| — | **4.3** Idempotency window dedupe | P4 | S |
| — | **4.4** Backpressure 429 + Retry-After | P4 | S |
| — | **5.x** Phase 5 (intelligence) | P5 | 22h |
| — | **6.x** Phase 6 (ops polish) | P6 | 14h |
| — | **7.x** Phase 7 (UX foundations) | P7 | 13h |
| — | **8.x** Phase 8 (productivity) | P8 | 18h |
| — | **9.x** Phase 9 (insights) | P9 | 14h |
| — | **10.x** Phase 10 (UX polish) | P10 | 16h |
| — | **11.x** Phase 11 (security closing) | P11 | 12h |
| — | **12.x** Phase 12 (Frida ban prediction) | P12 | 8h |
| — | **13.x** Phase 13 (APK reverse toolkit) | P13 | 4h |

### Follow-ups acumulados (12 items, all non-blocking)

```
#4   make up-prod runs tsx (dev) instead of node dist (prod) — fix or retire
#6   explicit action= in dispatch-login jail (clarity over Debian default)
#7   NOPASSWD for fail2ban-client + is-active fail2ban
#8   warn-on-startup if password fallback is plaintext (Important from review)
#9   verifyPassword: empty-string guard + missing wrong-username-on-hash-mode test (Important)
#10  unify safeEqual helpers (auth-login.ts vs password-hash.ts) (Important)
#11  commit deploy migration script + rollback runbook for bcrypt migration
#12  Phase 8: remove plaintext fallback in verifyPassword (after #8 confirms no env still uses plaintext)
#15  audit external X-API-Key consumers — RESOLVED in this session (X-API-Key intentionally kept)
#17  live smoke test of refresh flow (login + auto-refresh) — needs browser
#18  refresh_tokens table cleanup cron (Phase 8)
#19  sync local packages/core/.env DISPATCH_API_KEY with Kali (dev parity, low priority)
```

---

## Architectural findings worth remembering

1. **Tailscale Funnel masks remote IP**: Caddy ALWAYS sees `request.remote_ip = 127.0.0.1` because Funnel terminates TLS on ingress and proxies to localhost. Real client IP is in `request.headers.X-Forwarded-For["…"]`. Affects fail2ban regex design AND any rate-limiting work in Phase 4 — must extract from XFF, not remote_ip.

2. **Caddy admin endpoint disabled**: `caddy reload` (which uses `localhost:2019` HTTP API) does NOT work. Use `systemctl restart caddy` for any Caddyfile change. ~1s downtime acceptable for now.

3. **No file-based migrations**: this codebase uses **inline `CREATE TABLE IF NOT EXISTS` in module init** (see `health-collector.ts:15`, `device-manager.ts:24`, `sender-mapping.ts:60`, `refresh-token.ts` from this session). Don't create `migrations/*.sql` files; put schema in the constructor.

4. **JWT is custom HS256**: `packages/core/src/api/jwt.ts` is a hand-rolled minimal HS256 implementation (no `jsonwebtoken` package). Refresh tokens are NOT JWTs — they're 64-char hex random opaque strings, sha256-hashed at rest.

5. **Inbound/outbound HMAC parity**: both use `X-Dispatch-Signature: sha256=<hex>`, body=`JSON.stringify(payload)`. Pre-Task 3.2 outbound was emitting bare hex without `sha256=` prefix — silent mismatch (no callback receiver was strictly verifying yet, so no observable failure).

6. **Auth-login timing-leak mitigation**: `verifyPassword` runs UNCONDITIONALLY in `auth-login.ts`, even when `userOk=false`. Bcrypt's ~250ms dominates and masks "wrong username" vs "wrong password" timing. Test `auth-login.test.ts:does not leak which field was wrong` enforces this.

7. **fail2ban + Tailscale**: dispatch-login `ignoreip = 127.0.0.0/8 ::1 100.64.0.0/10` — full Tailscale CGNAT range is ignored so tailnet members can't ban each other (every Funnel-routed request shows tailnet IP in XFF when sourced from a tailnet peer). Live `Total failed` will only increment for non-tailnet WAN attackers — testing from inside the tailnet is structurally impossible.

8. **bcryptjs vs bcrypt**: `bcryptjs` (pure JS) chosen for portability. ~30% slower than native, irrelevant for an admin login endpoint. `BCRYPT_ROUNDS=12` (~250ms compare on Kali).

---

## Recovery checklist (run at start of next session)

```bash
# 1. Confirm SSH access
ssh -o ConnectTimeout=5 adb@dispatch "echo OK; hostname; uname -r"
# Expected: OK / debt-adbkali / 6.19.11+kali-amd64

# 2. Confirm repo HEAD on Kali matches origin/main
ssh adb@dispatch 'cd /var/www/debt-adb-framework && git rev-parse HEAD && git status --short'
# Expected: fc591b88… / clean

# 3. Confirm core service health
ssh adb@dispatch '
  for svc in caddy ssh tailscaled pipeboard-tunnel dispatch-core fail2ban; do
    printf "  %-22s %s\n" "$svc" "$(systemctl is-active $svc 2>/dev/null)"
  done
'
# Expected: all "active"

# 4. Confirm public Funnel
curl -sS https://dispatch.tail106aa2.ts.net/healthz | head -c 200

# 5. Read the plan + this handoff
# - docs/superpowers/plans/2026-04-27-dispatch-platform-overhaul.md (lines 1042+ for Phase 4)
# - docs/superpowers/handoffs/2026-04-27-phase3-complete.md (this file)
```

---

## Next action

**Phase 4 — Backend Resilience** (deps: P3 ✅ done). Order per plan: 4.1 → 4.2 → 4.3 → 4.4.

**Task 4.1 (B2) — failed_callbacks abandoned + dead-letter** (plan lines 1046+):
Files to expect:
- `packages/core/src/plugins/callback-delivery.ts`
- `packages/core/src/plugins/callback-delivery.test.ts`
- Schema: `failed_callbacks` table likely already exists (refresh memory by `grep -rn 'failed_callbacks' packages/core/src/`)

This is mostly a backend-only TDD task. ~3-5h estimate.

After 4.1 → 4.2 (circuit breaker) → 4.3 (idempotency window) → 4.4 (backpressure). Then Phase 4 closed in ~10h total.
