# 0001. Ack-rate calibration replaces Frida method-counting

Date: 2026-04-28
Status: Accepted

## Context

The 2026-04-29 research track set out to calibrate
`DISPATCH_BAN_PREDICTION_SUSPECT_THRESHOLD` by counting invocations of
WhatsApp anti-tamper classes via a Frida method-counter agent
(`scripts/research-collect.py`). The collector iterated 11 anti-tamper
classes discovered in the WhatsApp APK and forwarded suspect signals to
`BanPredictionDaemon` over TCP/9871. The threshold was meant to be
P{N} of the healthy distribution of suspect-event rate.

That plan is **abandoned** for the POCO C71 stack. Three convergent
blockers (documented in
`docs/superpowers/plans/2026-04-29-research-track-frida-redroid.md` and
the agent report 2026-04-28):

1. **Magisk 28.1 has open Zygisk regressions** (Magisk issues #8266,
   #9202). Module compatibility on this version is unverified and
   already produced runtime instability in this session.
2. **Zero public reports of Zygisk-Frida on Unisoc/Spreadtrum T603** —
   the POCO C71 chipset. All public validation is on MTK / SDM. Empirically:
   - Frida 17.9.2 + frida-server-android-arm64 → WhatsApp `Process
     terminated` after ~3 min.
   - Frida 16.6.6 → full Android reboot when frida-server-16.x binary
     was started.
3. **DenyList conflict**: Zygisk-Assistant requires `com.whatsapp` ON the
   DenyList for root hiding; ZygiskFrida requires it OFF for gadget
   injection. The two are mutually exclusive on the same package.

Net: with one device and no sacrificial duplicate, the cost of further
Frida exploration is high (boot loops, app crashes) and the ROI is
unclear. We need a calibration signal that does not require touching
the device at all.

## Decision

Pivot the ban-prediction calibration to a **WAHA `message.ack` rate
delta**.

### Why this signal works

The actual phenomenon we want to detect is **shadowban**: a state where
WhatsApp accepts the outgoing message at the protocol level (ack=1,
"server") but recipients never see it (no ack=2 / "device", no ack=3 /
"read"). Measuring that ratio directly is a direct measurement of the
phenomenon, not a proxy. Frida method-counting is a proxy at best; the
ack-rate is the ground truth.

### Schema

A new table `message_ack_history` records every `message.ack` webhook
event:

```sql
CREATE TABLE IF NOT EXISTS message_ack_history (
  id TEXT PRIMARY KEY,
  waha_message_id TEXT NOT NULL,
  ack_level INTEGER NOT NULL,           -- -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played
  ack_level_name TEXT NOT NULL,
  delivered_at TEXT,                    -- ISO when ack_level >= 2
  read_at TEXT,                         -- ISO when ack_level >= 3
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- denormalized for fast calibration query (no join):
  sender_phone TEXT,
  recipient_phone TEXT,
  UNIQUE (waha_message_id, ack_level)
);
CREATE INDEX IF NOT EXISTS idx_ack_sender_observed ON message_ack_history(sender_phone, observed_at);
CREATE INDEX IF NOT EXISTS idx_ack_msgid ON message_ack_history(waha_message_id);
```

`sender_phone` and `recipient_phone` are denormalized at insert time
from `message_history` (joined on `waha_message_id`). This lets the
calibrator run as a single indexed range scan over a single table —
no joins, no aggregation across tables. If the join misses (ack arrives
before `message_history` has the `waha_message_id`), the row is
inserted with NULLs and the calibrator skips it from per-sender stats
but still counts it in totals when needed.

The `UNIQUE (waha_message_id, ack_level)` constraint plus
`INSERT OR IGNORE` makes ack persistence idempotent — webhook replays
do not create duplicates.

### Calibrator math

Implementation: `packages/core/src/research/ack-rate-calibrator.ts`.
Pure function `calibrateAckRate({ events, windowMs, minSampleSize,
percentile })`.

1. Group events by `senderPhone`, dropping NULL-sender rows.
2. For each sender, group `ack` events into time buckets of size
   `windowMs` keyed by `floor(observedAt / windowMs)`. The bucket of
   the *first* ack observed for a message is the bucket the message
   "belongs to" — this prevents one message from being counted across
   multiple windows when an ack=1 lands in window N and ack=3 lands in
   window N+1.
3. Per bucket, compute `read_count / sent_count`. The recommended
   threshold for the sender is **P{percentile}** of the per-bucket
   read-ratio distribution (default P05).
4. **Confidence** = `min(1, sampleWindows/30) * (1 -
   normalizedVariance)` where `normalizedVariance = min(1, variance /
   0.25)` (0.25 is the maximum variance of a Bernoulli-style ratio).
   Bounded in `[0, 1]`.
5. **Warnings**:
   - `sampleWindows < minSampleSize` → "sparse sample"
   - `totalSent < 50` → "low absolute volume"
   - `variance > 0.05` (with enough samples) → "unstable distribution"

### Persistence wiring

- `WebhookHandler.handleAck` injects `AckHistory` via constructor and
  calls `ackHistory.insert(...)` for every ack event before emitting
  the existing `waha:message_ack` event. No regression on existing
  emit-only behaviour.
- `server.ts` instantiates `AckHistory` once at boot and passes it into
  `WebhookHandler`. The new table is created idempotently via
  `CREATE TABLE IF NOT EXISTS`.

### CLI

`scripts/dispatch-calibrate-ack-rate.ts` — read-only TypeScript script
runnable on Kali via `pnpm tsx scripts/dispatch-calibrate-ack-rate.ts`.
Flags: `--since`, `--window`, `--db`, `--percentile`, `--min-windows`.
Output: per-sender table + global verdict (SUFFICIENT / SPARSE /
INSUFFICIENT). The script does NOT modify `.env` — it only suggests.

## When to apply the recommendation

Only when the verdict is **SUFFICIENT**:
- At least one sender crosses `--min-windows` (default 24, i.e. one
  full day of 1-hour buckets).
- That sender's `confidence` is ≥ 0.7.
- The sender's `warnings` array does not include "high variance".

Apply the threshold to `.env` manually, e.g.:

```env
DISPATCH_BAN_PREDICTION_READ_RATIO_THRESHOLD=0.42
```

(Exact env name to be defined when the daemon consumes the threshold;
out of scope for this task — the calibrator only emits the number.)

## What "sufficient data" means

- **SUFFICIENT** — at least one sender has ≥ `minSampleSize` windows of
  data with non-zero traffic. Threshold is trustworthy.
- **SPARSE** — at least one sender has ≥ `minSampleSize / 2` windows
  but none crossed the full bar. Threshold is provisional; keep
  collecting before applying.
- **INSUFFICIENT** — neither bar crossed. Either widen `--since`, or
  wait until traffic accumulates.

For a single sender at typical campaign volume (~hundreds of msgs/day
across all hours), 7 days of `--since 7d --window 1h` should cross
SUFFICIENT comfortably.

## Consequences

- **(+)** Zero device touch, zero Magisk / Zygisk risk.
- **(+)** Direct measurement of shadowban — the actual phenomenon we
  care about, not a proxy.
- **(+)** Pure-function calibrator → fully deterministic, fully
  unit-testable. No real-device dependency in CI.
- **(+)** Backwards compatible: WAHA was already emitting
  `message.ack`; we previously emitted-but-discarded the data. The
  schema migration is one new table — no data migration needed.
- **(−)** Requires N days of accumulation before calibration is
  confident. Cannot calibrate on a fresh deployment.
- **(−)** Frida-based research is deferred until a 2nd POCO arrives or
  we have a redroid environment to test offline.
- **(−)** A WAHA outage that drops `message.ack` events leaves a hole
  in the dataset; the calibrator's variance check should catch this,
  but operators should be aware.

## Future work

- **Frida re-eval** when a sacrificial device arrives. The 11
  anti-tamper classes already discovered (preserved in the docstring
  of `scripts/research-collect.py` on `research-track/2026-04-29`)
  remain the starting point for that work.
- **Anomaly detection daemon** that consumes the threshold from `.env`
  and emits `sender:suspect` alerts when the live read-ratio drops
  below `recommendedThreshold` for K consecutive windows. Out of scope
  for this task — depends on threshold being calibrated first.
- **Multi-percentile output** — show P05 / P10 / P25 simultaneously so
  operators can pick conservative vs. aggressive thresholds.
- **Hysteresis** — pair `recommendedThreshold` with a recovery
  threshold so a sender that briefly dips doesn't toggle in/out of
  suspect state.
