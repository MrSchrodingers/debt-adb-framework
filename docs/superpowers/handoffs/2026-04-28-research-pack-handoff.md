# Handoff — 2026-04-28 → Research Track session

> **For the next agent reading this fresh after `/clear`:** read this entire file BEFORE starting Task 0 of `docs/superpowers/plans/2026-04-29-research-track-frida-redroid.md`. Production state, env vars, telegram credentials, and risk constraints all live here. Do not skip.

---

## What was done in the closing minutes of the previous session

- Layout fix on `<FilmStrip>` (thumbnails 9:16, label below image, counter only when >1 frame, controls hidden for single frame).
- Manual circuit breaker: `DispatchPauseState` (SQLite + in-memory cache) with 6 scopes (global/plugin/sender/device/chain/message), wired into `WorkerOrchestrator.tickDevice` and `processMessage`. 4 admin endpoints (`GET /pause`, `GET /pause/history`, `POST /pause`, `POST /pause/resume`). Audit-logged, Telegram-alerted. UI tab at `/admin → Pause manual`.
- `/api/v1/admin/banned-numbers` GET/DELETE + UI tab.
- `oralsin-messages.tsx` ScreenshotSlot now consumes Phase 7.5 structured-404 shape (5 codes + meta).
- PWA SW set to `selfDestroying: true` to recover users stuck behind old SW.
- Mirror tab (`<DevicesGridMirror>`): tile view, 1 Hz per-device polling of `/api/v1/devices/:serial/screen`, auto-pause on tab hidden, click-to-expand, per-tile pause.
- `apk-snapshot.sh` rewritten to pull every APK split (base + arm64_v8a + density). Fixes the gap where native libs (likely anti-cheat code) weren't being captured.
- `apk-diff.sh` filter to `com/whatsapp/(security|util|protocol|client|core|registration|verification|infra/security)` + top-10 changed classes inline diff.
- `infra/finalize-deploy.sh` now installs `scrcpy` alongside apktool/jq/frida-tools.

**Last commit on `main`**: `d9ef30bc` — `feat(ui+research): mirror grid + multi-split apk-snapshot + filtered apk-diff`. **Verify with `git log -1`** before starting.

---

## Production state (Kali server)

```
SSH:               ssh adb@dispatch                  (Tailscale MagicDNS, passwordless)
SSH IP fallback:   ssh adb@100.77.249.93
Host:              debt-adbkali (Linux 6.19.11+kali-amd64, 7.7GB RAM)
Public URL:        https://dispatch.tail106aa2.ts.net
Repo on Kali:      /var/www/debt-adb-framework
Repo on local:     /var/www/adb_tools
Branch:            main
HEAD (verify):     d9ef30bc  (or later — git log -1)

Service:           dispatch-core.service (systemd, active)
                   PID changes per restart; survives reboot
                   uptime 6883s+ at session close
Caddy:             active (reverse proxy 8080→ 7890 + UI preview)
fail2ban:          active (sshd + dispatch-login jails)
docker:            active
Jaeger:            container 'jaeger' running (port 16686)
ban-prediction:    daemon listening 127.0.0.1:9871
Pipeboard tunnel:  active (127.0.0.1:25432 → Hetzner postgres)
.env perms:        /var/www/debt-adb-framework/packages/core/.env  (mode 600 owner adb)
```

### Devices currently online (via `adb devices`)

```
9b01005930533036340030832250ac    POCO C71 #1 (production sender — DO NOT use for research)
                                    sender_mapping: 554391938235
9b0100593053303634003083239bac    POCO C71 #2 (offline at session close)
                                    sender_mapping: 554396837813
```

**No second physical device is sacrificial yet.** Research session must either:
- (a) Get a third POCO connected and add its serial to `RESEARCH_SACRIFICIAL_SERIALS`, OR
- (b) Use the redroid container (Task 3 of plan).

### Live healthz at session close

```json
{
  "status": "healthy",
  "uptime_seconds": 6883,
  "devices": { "online": 1, "total": 2 },
  "queue": { "pending": 0, "processing": 0, "failed_last_hour": 0 },
  "plugins": { "adb-precheck": "active", "oralsin": "active" },
  "failed_callbacks": 0
}
```

---

## Connection & execution constants

```
TEST_PHONE_NUMBER       = 5543991938235          (NEVER any other recipient for dev tests / research)
PUBLIC_URL              = https://dispatch.tail106aa2.ts.net
KALI_REPO_PATH          = /var/www/debt-adb-framework
LOCAL_REPO_PATH         = /var/www/adb_tools
LOGIN_USERNAME          = debt
LOGIN_PASSWORD          = (bcrypt-hashed in .env; plaintext is in user's password manager)

FRIDA_CLIENT            = ~adb/.venv-frida/bin/frida   (17.9.2)
FRIDA_SERVER_BIN        = ~adb/frida-server             (53MB, android-arm64, 17.9.2)
APKTOOL_MODERN          = ~adb/.local/bin/apktool-modern (2.10.0)
APK_BACKUP_DIR (default)= /var/backups/whatsapp-apks    (cron monthly populates)
APK_BACKUP_DIR (used)   = ~adb/test-apk-backup          (test snapshot from 2026-04-28)
JAEGER_UI               = https://dispatch.tail106aa2.ts.net/admin/jaeger  (Bearer required)
BAN_PREDICTION_DAEMON   = 127.0.0.1:9871                (TCP JSONL listener, default off but ON now)
SCRCPY                  = NOT YET INSTALLED — finalize-deploy.sh will install on next sudo run

TELEGRAM_BOT_TOKEN      = 8680246475:AAEoRGFhHVe5QWV9FltnB_n31ybn3ghDs7A
TELEGRAM_CHAT_ID        = -1003942208119          (DEBT HUB Notifications supergroup)
TELEGRAM_THREAD_ID      = 396                     (Dispatch topic)
TELEGRAM_BOT_USERNAME   = notificacoes_debt_hub_bot
```

### NOPASSWD entries currently configured on Kali

```
/bin/systemctl {start,stop,restart,status,reset-failed} dispatch-core.service
/bin/systemctl {restart,reload,status} caddy.service
/bin/systemctl status pipeboard-tunnel.service
/bin/systemctl status tailscaled.service
/bin/journalctl -u {dispatch-core,caddy,pipeboard-tunnel,tailscaled}.service *
/usr/bin/tailscale funnel status
```

**Things that STILL need a sudo password** (will block automation):
- `apt install` / `apt update` (needed for scrcpy, redroid prerequisites)
- `tee` / `install` to `/etc/*` paths
- `docker` commands (need `adb` user added to `docker` group, currently NOT done — `sudo docker` is required)
- Editing `/etc/sudoers.d/*`

---

## Workflow conventions

**Each feature commit**:
```
1. Edit code in /var/www/adb_tools (LOCAL)
2. pnpm --filter @dispatch/<pkg> build
3. pnpm --filter @dispatch/<pkg> test
4. git add … && git commit -m "type(scope): msg" && git push origin main
5. ssh adb@dispatch 'cd /var/www/debt-adb-framework && git pull --ff-only && pnpm install --frozen-lockfile && pnpm --filter @dispatch/<pkg> build'
6. ssh adb@dispatch 'sudo systemctl restart dispatch-core.service'  (NOPASSWD)
7. Smoke via curl loopback or Funnel
```

**Branch policy**: stay on `main`. Plan Step 0.6 explicitly says no feature branches. EXCEPTION: this research plan creates a worktree on `research-track/2026-04-29` (per Task 0.3) since multi-day work with parallel data collection benefits from isolation. Merge with `--no-ff` at the end (final task).

**Sudo-required ops**: stage a script on Kali at `/tmp/<task>.sh`, then ask user to run `ssh -t adb@dispatch 'sudo bash /tmp/<task>.sh'`. Pattern is well-established (see `infra/finalize-deploy.sh`).

**Caddy**: `caddy reload` is broken (admin endpoint disabled in Caddyfile). Use `sudo systemctl restart caddy` for any Caddyfile change (~1s downtime, NOPASSWD).

**Pkill caveat**: `pkill -f "ssh.*dispatch"` will kill the SSH process running it (kills self). Use specific patterns or accept exit 144.

---

## Workflow conventions for the Research Track

1. **NEVER target a production sender serial.** Production POCOs are mapped in `sender_mapping`. The plan's Task 1 introduces `RESEARCH_SACRIFICIAL_SERIALS` env var + a worker guard — this is the contract; respect it.
2. **NEVER register a real Oralsin / production WhatsApp account inside redroid.** Use a burner only.
3. **Test-recipient is `5543991938235`** for ALL outbound research messages. The validation in `scripts/research-abuse.sh` enforces this.
4. **Frida sessions are short bursts unless on Zygisk.** Standard `frida-server` is detectable. 24h baseline is OK on a sacrificial device because the device is disposable, but if the sacrificial WA account gets banned mid-collection, that's expected — proceed.
5. **Save raw JSONL.** Even if calibration fails today, the data is the input for future analysis. Never `rm` collected files until after merge.
6. **Telegram milestone per Task** — execution must announce at start + end of each Task to the topic 396. `sendCriticalAlert` factories in `packages/core/dist/alerts/notifier.js` already work end-to-end.

---

## Pending tasks at close (state of TaskList)

| # | Task | Where | Estimate |
|---|---|---|---|
| 0 | Bootstrap & verify state | this handoff + plan Task 0 | 5 min |
| 1 | Sacrificial device guard | plan Task 1 | 30 min |
| 2 | Frida stealth toolchain + baseline hook | plan Task 2 | 45 min |
| 3 | redroid container | plan Task 3 | 1 h (incl. sudo) |
| 4 | 24h baseline collection | plan Task 4 | 24 h wall-clock (background) |
| 5 | 1h abuse collection | plan Task 5 | 1 h wall-clock |
| 6 | Threshold calibrator + apply | plan Task 6 | 45 min code + 10 min calibrate |
| 7 | Zygisk-Frida (kernel-level) | plan Task 7 | 30 min IF physical sacrificial available |
| Final | Merge research branch + deploy | plan Final | 15 min |

**Total active work**: ~4 h. **Plus 24-25 h wall-clock idle waiting for collection** (Task 4 runs in background while other tasks proceed).

### Follow-ups acumulados (not in this plan, future)

```
#1   Cron mensal APK snapshot — already configured on Kali, but APK_BACKUP_DIR points to ~adb/test-apk-backup (test path).
     Production should use /var/backups/whatsapp-apks (needs sudo mkdir + chown adb).
#2   PWA re-enable plan: cache semantics for binary endpoints (screenshot/screen) are now correct in vite.config.ts,
     but selfDestroying is true. After a couple of weeks of stable selfDestroying, flip back to standard PWA.
#3   Multi-tile mirror is one-screenshot-per-second per device. For 4+ devices this is 4 ADB screencaps/sec —
     fine for short windows, may stress device. Consider scrcpy WebRTC integration if operator wants smooth video.
#4   Oralsin team: 4 P0 items in docs/oralsin-pending-actions.md not yet done by them.
     Coordinate flip of PLUGIN_ORALSIN_HMAC_REQUIRED=true after Oralsin confirms.
#5   apk_versions.json shape changed in commit d9ef30bc — old single-record format vs new multi-part format.
     Nobody reads this file in code today, but if a future tool does, handle both shapes.
#6   `frida-server` runs as root on POCO via `su -c '...&'`. If POCO reboots, it does NOT auto-start.
     Add init.d/systemd-on-Android (Magisk module) for persistence on the sacrificial device.
#7   `RESEARCH_SACRIFICIAL_SERIALS` is read at orchestrator constructor time. SIGHUP doesn't re-instantiate the
     orchestrator. Hot-reload coordinator could be extended to call `orchestrator.reload(sacrificialSerials)`,
     but for now just `sudo systemctl restart dispatch-core` after editing the env value.
```

---

## Architectural findings worth carrying forward

1. **Sacrificial-device contract is enforced in code, not just policy.** The `WorkerOrchestrator` guard added in Task 1 of the plan is the canonical gate. Tests pin the behavior.
2. **redroid + WhatsApp is research-only.** SafetyNet/Play Integrity rejection is expected. Don't waste cycles trying to make a redroid WA register normally — it's for class-discovery and APK fingerprint capture, not active sends.
3. **Ban-prediction threshold is currently arbitrary** (`3 sinais / 60s`). The whole point of the plan is replacing this with calibrated values from real data. If calibration confidence < 0.5, the daemon is **noise generator** rather than signal — leave threshold alone and rerun collection.
4. **Frida hooks on com.whatsapp can themselves trigger anti-tamper.** The `hook-baseline.js` is intentionally PASSIVE (no method replacement, just observation). Active method replacement is a separate experiment for after threshold is calibrated.
5. **`sender_mapping.profile_id`** already supports multi-user Android (E in the previous session's analysis). The dispatch-core can use 4 WhatsApp accounts per POCO via Android user profiles. This is the "virtualization" path that does NOT trigger SafetyNet — already in the codebase, just underused.

---

## Recovery checklist (run at start of next session)

```bash
# 1. Confirm SSH access
ssh -o ConnectTimeout=5 adb@dispatch "echo OK; hostname; uname -r"
# Expected: OK / debt-adbkali / 6.19.11+kali-amd64

# 2. Confirm repo HEAD on Kali matches origin/main
ssh adb@dispatch 'cd /var/www/debt-adb-framework && git rev-parse HEAD && git status --short'
# Expected: d9ef30bc (or later) / clean

# 3. Confirm core service health
ssh adb@dispatch '
  for svc in caddy ssh tailscaled pipeboard-tunnel dispatch-core fail2ban docker; do
    printf "  %-22s %s\n" "$svc" "$(systemctl is-active $svc 2>/dev/null)"
  done
'
# Expected: all "active"

# 4. Confirm public Funnel
curl -sS https://dispatch.tail106aa2.ts.net/healthz | head -c 200
# Expected: status:"healthy"

# 5. Confirm Jaeger reachable + ban-prediction listening
ssh adb@dispatch 'curl -sS http://127.0.0.1:16686/api/services | head -c 200; echo; ss -tlnp 2>/dev/null | grep 9871'

# 6. Confirm frida toolchain
ssh adb@dispatch '~/.venv-frida/bin/frida --version; ls -la ~/frida-server'
# Expected: 17.9.2 / -rwxr-xr-x ... 53103840 ... frida-server

# 7. Read the plan
cat /var/www/adb_tools/docs/superpowers/plans/2026-04-29-research-track-frida-redroid.md | head -80

# 8. Optional: send Telegram "session started" signal (Task 0 Step 4 of the plan)
```

If any check fails, write a recovery message — do not start research changes against an inconsistent baseline.

---

## Next action

Open `docs/superpowers/plans/2026-04-29-research-track-frida-redroid.md` and execute Task 0. Subagent-driven development is recommended (`superpowers:subagent-driven-development`) — fresh subagent per task, two-stage review between tasks. Plan was structured for this pattern: each task has clean file boundaries.
