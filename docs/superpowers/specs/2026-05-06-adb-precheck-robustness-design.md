# ADB Pre-check — Robustness, Retry & Note Upsert

**Status**: design (pending implementation plan)
**Date**: 2026-05-06
**Author**: brainstorm session w/ Daniel Munhoz
**Scope**: `packages/core/src/plugins/adb-precheck/`, `packages/core/src/check-strategies/`, `packages/core/src/validator/`

---

## 1. Context & problem statement

### 1.1 Symptom

Operator sees "⚠️ Erro de verificação" cells in the Pipedrive `pasta_summary` notes for some phones during ADB pre-check. The frequency rises with scan volume, blocking auto-archival of deals (`archive_if_empty` is skipped because not all columns came back as `invalid` — some are `error`).

### 1.2 Diagnosis (data from Kali production DB)

51 deals affected over the sampled period. **100% of error outcomes** trace to the same code path:

- `scanner.ts:365` maps `validator.validate() → r.exists_on_wa === null` to `outcome: 'error'`.
- `validator` returns `null` when no strategy reaches a decisive verdict (`contact-validator.ts:117-126`).
- All sampled rows have `source: 'adb_probe'`, `confidence: null`, `error: null` — no exception raised; the ADB probe simply timed out as `inconclusive`.

Distribution of `wa_contact_checks.evidence.ui_dump_length` for ADB probe (last 24h):

| result | n | min | max | avg |
|---|---|---|---|---|
| `exists` | 262 | 16 339 | 21 470 | 17 179 |
| `not_exists` | 520 | 5 292 | 5 293 | 5 293 |
| `inconclusive` | 221 | 4 896 | 60 701 | 56 725 |

The dominant inconclusive bucket is `ui_dump_length: 58048` (124× — UI grande estável). Confirmed via `dumpsys activity activities` that the WhatsApp top activity at fail-time was `com.whatsapp/.contact.ui.picker.ContactPicker` — the intent did not navigate to the chat.

A second smaller bucket (~5 500 chars) matches the layout of the pt-BR modal "**O número de telefone +55 ... não está no WhatsApp**", which the current regex (`Convidar|invite to WhatsApp|not on WhatsApp`) does **not** match — `não está no WhatsApp` is missing.

### 1.3 Two distinct bugs, one symptom

1. **Wrong-screen leak** (~85% of errors): `wa.me` intent leaves the user on a non-conversation screen (chat list, contact picker, splash). The probe poll loop times out without seeing any terminal state.
2. **Untranslated terminal state**: pt-BR variant of the "not on WhatsApp" modal escapes the regex set, leading to `inconclusive` instead of `not_exists`.

### 1.4 Adjacent gaps surfaced during diagnosis

- Scanner is **fully sequential** (`for await page; for row of page; for phone of phones`) — fine for 1 device, but no in-scan retry mechanism today.
- Note publication is **always POST**; re-running a pasta scan creates duplicate notes in Pipedrive.
- No structured snapshot of unknown UI states — adding new classifiers requires manual reproduction on hardware.

---

## 2. Goals & non-goals

### 2.1 Goals

1. Reduce `outcome: 'error'` rate to **< 1%** in steady state across 100+ deal scans.
2. Keep an **idempotent single Pipedrive note per pasta** — successive scans `PUT` the same `note_id`, do not create duplicates.
3. Provide a **manual sweep endpoint** (Level 3 retry) to recover historic errors without re-scanning the full pasta.
4. Add **enough auditing to debug a production failure without reproducing it on hardware** — every probe attempt classified, every UI unknown snapshotted, every note revision linked to its predecessor.
5. Make the entire flow **race-free under concurrent scans**, using SQLite-backed pasta locks with fence tokens.

### 2.2 Non-goals

- **Multi-device parallelism** for the ADB pre-check itself (single device today; expansion is in the notification-sender path, separate plugin).
- **Auto-cron sweep**. The endpoint exists; scheduling is left to ops (systemd timer / external cron).
- **Reverse-engineering WhatsApp internals** — we treat the UI dump as the source of truth and classify defensively.

---

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       ADB-PRECHECK SCAN PIPELINE (v2)                    │
│                                                                          │
│  ┌────────────────┐    ┌─────────────────────┐   ┌──────────────────┐    │
│  │  Pipeboard PG  │───►│  Scanner (per-deal) │──►│ Validator        │    │
│  │  iterateDeals  │    │  acquires pasta-lock│   │ (cache→ADB→WAHA) │    │
│  └────────────────┘    └─────────────────────┘   └────────┬─────────┘    │
│                                  │                         │             │
│                                  │                  ┌──────▼─────────┐   │
│                                  │                  │ AdbProbe (v2)  │   │
│                                  │                  │ ┌───────────┐  │   │
│                                  │                  │ │UiState-   │◄─┼── snapshots/ (unknown)
│                                  │                  │ │Classifier │  │   │
│                                  │                  │ └─────┬─────┘  │   │
│                                  │                  │       │        │   │
│                                  │                  │ ┌─────▼─────┐  │   │
│                                  │                  │ │Recover +  │  │   │
│                                  │                  │ │1× retry   │◄── Level 1
│                                  │                  │ └───────────┘  │   │
│                                  │                  └────────────────┘   │
│                                  │                                       │
│                       ┌──────────▼──────────┐                            │
│                       │ End-of-scan retry   │ ◄── Level 2 (errors only)  │
│                       │ (per-deal, bounded) │                            │
│                       └──────────┬──────────┘                            │
│                                  │                                       │
│                       ┌──────────▼──────────┐                            │
│                       │ NoteUpsert          │                            │
│                       │ (POST first / PUT   │                            │
│                       │  subsequent)        │                            │
│                       └─────────────────────┘                            │
│                                                                          │
│  Manual/cron entrypoint (Level 3):                                       │
│   POST /api/v1/plugins/adb-precheck/retry-errors                         │
│         body: { since_iso?, pasta?, max_deals? }                         │
│   → reuses Scanner with `retry_errors_only=true` flag                    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Lock map** (SQLite `pasta_locks` table + in-memory device mutex):

| Lock key | Backing | Granularity | TTL | Policy | Held by |
|---|---|---|---|---|---|
| `probe.<device_serial>` | in-memory mutex | per device | indefinite (released in `finally`) | exclusive | `AdbProbeStrategy.probe()` *(existing)* |
| `scan.<pasta>` | SQLite | per pasta | 3600 s | fail-fast 409 | scanner during full scan + retry pass |
| `note.pasta_summary:<pasta>` | SQLite | per pasta | 60 s | wait-with-retry 5 s × 3 | publisher during upsert |
| `job.<job_id>` | existing (`adb_precheck_jobs.status`) | per job | n/a | CAS via `UPDATE WHERE status='pending'` | scanner *(existing)* |

**Files touched:**

| File | Change |
|---|---|
| `packages/core/src/check-strategies/ui-state-classifier.ts` | **new** — pure function, fixture-tested |
| `packages/core/src/check-strategies/adb-probe-strategy.ts` | refactor: delegate classification, add recover-and-retry |
| `packages/core/src/plugins/adb-precheck/scanner.ts` | add end-of-scan retry pass; `retry_errors_only` mode |
| `packages/core/src/plugins/adb-precheck/pipedrive-publisher.ts` | resolve current note + emit PUT when present |
| `packages/core/src/plugins/adb-precheck/pipedrive-client.ts` | add PUT branch, 404 detection |
| `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts` | `findCurrentPastaNote()`, `markOrphaned()`, `revises_row_id` |
| `packages/core/src/plugins/adb-precheck/job-store.ts` | `triggered_by`, `parent_job_id` columns |
| `packages/core/src/contacts/contact-registry.ts` | `attempt_phase` column on `wa_contact_checks` |
| `packages/core/src/locks/pasta-lock-manager.ts` | **new** |
| `packages/core/src/api/admin.ts` (or equivalent) | `GET /admin/locks`, `GET /admin/probe-snapshots` |
| `packages/core/src/api/adb-precheck.ts` | `POST /retry-errors`, `GET /jobs/:id` extension, `GET /notes/:pasta/history` |

---

## 4. UI State Classifier

### 4.1 Contract — pure function

```typescript
// packages/core/src/check-strategies/ui-state-classifier.ts
export type UiState =
  | 'chat_open'                // decisivo → exists
  | 'invite_modal'             // decisivo → not_exists
  | 'searching'                // transitório → poll again
  | 'chat_list'                // wrong screen → retry
  | 'contact_picker'           // wrong screen → retry
  | 'disappearing_msg_dialog'  // wrong screen → BACK + retry
  | 'unknown_dialog'           // unclassified modal → snapshot + retry
  | 'unknown'                  // nothing matched → snapshot + retry

export interface ClassifierInput {
  xml: string
  topActivity?: string | null
}

export interface ClassifierResult {
  state: UiState
  decisive: boolean             // only chat_open & invite_modal
  retryable: boolean            // wrong screens + unknowns
  evidence: {
    matched_rule: string
    dump_length: number
    matched_text?: string       // first 200 chars that triggered the match
    has_modal_buttons: boolean
    has_message_box: boolean
  }
}

export function classifyUiState(input: ClassifierInput): ClassifierResult
```

### 4.2 Classification order (first match wins)

```
1. chat_open       — resource_id /(entry|conversation_entry|text_entry)/ OR
                     (class=EditText AND package=com.whatsapp)
                     ✅ decisive: exists

2. invite_modal    — any of:
                     • resource-id="com.whatsapp:id/invite_cta"
                     • android:id/message text matches
                       /não está no WhatsApp|not on WhatsApp|
                        no está en WhatsApp|不在 WhatsApp/i
                     • android:id/button1 text matches
                       /Convidar para o WhatsApp|Invite to WhatsApp|
                        Invitar a WhatsApp/i
                     ✅ decisive: not_exists

3. searching       — text /Pesquisando|Searching|Procurando|Cargando|Loading/i
                     OR resource-id="com.whatsapp:id/progress_bar"
                     ⏳ transient (continue polling)

4. disappearing_   — text /Mensagens temporárias|Disappearing messages|
   msg_dialog        Mensajes temporales|消失的消息/i AND has_modal_buttons
                     🔁 retry after BACK keyevent

5. contact_picker  — topActivity == "com.whatsapp/.contact.ui.picker.ContactPicker"
                     OR resource-id /contact_row|picker_search/  AND  NOT chat_open
                     🔁 retry after force-stop

6. chat_list       — multiple occurrences (≥3) of resource-id="com.whatsapp:id/conversations_row_*"
                     OR all of {Chats|Conversas, Status|Atualizações, Calls|Chamadas|Ligações} present
                       as TextView text in nodes whose resource-id matches /tabs?_|bottom_/i
                     🔁 retry after force-stop

7. unknown_dialog  — has_message_box OR has_modal_buttons (some generic modal)
                     📸 snapshot + retry after BACK

8. unknown         — fallback (nothing matched)
                     📸 snapshot + retry after force-stop
```

### 4.3 Snapshot policy (audit & calibration)

When the classifier returns `unknown` or `unknown_dialog`, the probe persists the XML:

```
data/probe-snapshots/
  YYYY-MM-DD/
    HHMMSS_<phone-last4>_<state>_<dump-length>.xml
```

- **Daily quota**: 500 snapshots/day (FIFO drop above cap).
- **Per-minute cap**: 10 snapshots/minute (storm protection).
- **Retention**: 14 days, sweep on boot via `find ... -mtime +14 -delete`.
- **Trigger**: only `unknown_dialog` and `unknown` (known states are not snapshotted).
- **Anonymization**: only last 4 digits of phone in filename; full XML preserved (it is local data, no PII beyond what is already in `wa_contact_checks`).
- **Path persisted** in `wa_contact_checks.evidence.snapshot_path`.

**Calibration workflow**: developer queries `wa_contact_checks` for recent unknowns, copies the snapshot path's XML into `packages/core/test/fixtures/ui-states/<new-state>.xml`, adds a classifier rule and a test case, opens a PR — no hardware reproduction needed.

### 4.4 Why a pure function

- Testable without hardware (fixture XML → expected result).
- Deterministic — same input, same output.
- Reusable — future health-check could detect stuck UI with the same classifier.
- Auditable — `evidence.matched_rule` appears in every log, easing production debug.

### 4.5 Probe integration

`adb-probe-strategy.ts` shifts from inline regex + early returns to:

```typescript
while (Date.now() < deadline) {
  await dump()
  const xml = await read()
  const result = classifyUiState({ xml, topActivity })
  recordAttempt(result)                  // always logs to wa_contact_checks
  if (result.decisive) return mapToStrategyResult(result)
  if (result.state === 'searching') continue
  if (result.retryable) return { result: 'recover_required', ui_state: result.state, evidence: result.evidence }
}
```

The probe **does not decide retries**. Recovery and retry are handled by the orchestrator (Level 1 below). Single responsibility.

---

## 5. Retry pipeline (3 levels)

Each level only knows about the previous one. No cross-level coupling.

### 5.1 Level 1 — In-probe recover-and-retry

**Where**: `adb-probe-strategy.ts` (impure — operates on the device).
**Trigger**: classifier returned a `retryable` state, OR deadline expired without a decisive result.
**Limit**: **1 retry** (initial + retry → 2 total attempts).
**Recovery action by state**:

| state | recovery |
|---|---|
| `chat_list`, `contact_picker`, `unknown` | `am force-stop com.whatsapp` + 1500 ms cold-start wait |
| `disappearing_msg_dialog`, `unknown_dialog` | `input keyevent KEYCODE_BACK` × 2 + 500 ms (modal is dismissable) |

```typescript
async probe(phone, ctx) {
  const r1 = await probeOnce(phone, ctx)
  if (r1.decisive || !r1.retryable) return r1
  await recover(r1.state, ctx)
  const r2 = await probeOnce(phone, ctx)
  return r2  // if still retryable → result='inconclusive' final
}
```

**Auditing**: each `probeOnce` writes to `wa_contact_checks` with `attempt_phase`:
- `probe_initial` — 1st attempt
- `probe_recover` — after recovery

**Expected cost** (no ban): ~3 s mean; ~10–12 s when retry fires. At 100 deals × ~5 % retry rate ≈ +5 s/deal → +8 min total.

### 5.2 Level 2 — End-of-scan retry pass

**Where**: `scanner.ts`, new method `retryErrorsPass(jobId, errorDeals[])`.
**Trigger**: after the main `for await (page of iterateDeals)` loop completes; scanner picks deals where `errorCount > 0`.
**Limit**: **1 pass**, processes **only phones with `outcome === 'error'`** (does not retest already valid/invalid phones).
**Lock**: already inside `scan.<pasta>` lock — no contention.

```typescript
async run(jobId, params) {
  const allResults = await scanMainLoop(jobId, params)
  const errorDeals = allResults.filter(d => d.phones.some(p => p.outcome === 'error'))

  if (errorDeals.length > 0 && params.retry_errors !== false) {
    logger.info('end-of-scan retry pass starting', {
      jobId,
      errorDeals: errorDeals.length,
      errorPhones: errorDeals.flatMap(d => d.phones.filter(p => p.outcome === 'error')).length,
    })
    await retryErrorsPass(jobId, errorDeals)  // mutates phones in place
  }

  await publishOrUpdateNotes(jobId, allResults)
}
```

**Bounded cost**: if 5 of 100 deals failed (≈15 phones), retry pass = 15 × ~10 s ≈ 2.5 min. Worst case 100 % failure is bounded by `total_phones × probe_max_latency`.

**Auditing**: `attempt_phase = 'scan_retry'`.

**Idempotence**: `retryErrorsPass` mutates `outcome` `error → invalid|valid|error` and **rewrites** `phoneResults` on the deal before `publishOrUpdateNotes`. If `error` persists, it stays `error` (Level 3 handles it).

**Optional bypass**: scan request param `retry_errors: false` (default `true`) — useful for debugging.

### 5.3 Level 3 — Manual sweep / cron

**Where**: new endpoint `POST /api/v1/plugins/adb-precheck/retry-errors` + new method `Scanner.runRetryErrorsJob(params)`.

**Body**:
```json
{
  "pasta": "15516752-A",
  "since_iso": "2026-05-01",
  "max_deals": 100,
  "dry_run": false
}
```

All fields optional (`pasta` defaults to all; `since_iso` defaults to last 7 days; `max_deals` defaults to 200).

**Behavior**:
1. Creates a new `adb_precheck_jobs` row with `triggered_by='retry-errors-sweep'`. `parent_job_id` is set when **all** targeted deals share a single `last_job_id` (typical when `pasta` is supplied and that pasta has not been re-scanned since the failing job); otherwise `parent_job_id` is `null` and the lineage is implicit via `wa_contact_checks.attempt_phase = 'sweep_retry'` rows referencing the original deals.
2. Instead of `pg.iterateDeals(...)`, lists deals from the **local cache**:
   ```sql
   SELECT * FROM adb_precheck_deals
   WHERE scanned_at >= ?
     AND phones_json LIKE '%"outcome":"error"%'
     AND (? IS NULL OR pasta = ?)
   ORDER BY scanned_at DESC
   LIMIT ?
   ```
3. For each deal, re-runs **only the phones with `error`** (same logic as Level 2).
4. After processing all deals of a pasta, calls `publishOrUpdateNotes()` — finds the existing note for the pasta and PUTs it (Section 6).
5. Returns `{ job_id, deals_planned, status }` immediately; processing is async.

**Auditing**: `attempt_phase = 'sweep_retry'`; the `triggered_by` column on `adb_precheck_jobs` enables a "sweep history" query.

**Locking**: takes `scan.<pasta>` like a normal scan — if a main scan is already running on the same pasta, the sweep aborts with 409 and a clear message (default; configurable).

**Cron** (suggested, not built-in):
```
0 */6 * * *  curl -X POST .../retry-errors -d '{"since_iso":"-24h"}'
```
Out of scope for Dispatch — it is an ops decision (systemd timer).

---

## 6. Note upsert (POST → PUT in-place)

### 6.1 Principle

The "pasta note" is a **single logical resource** with one stable Pipedrive `note_id`. Successive scans of pasta `X` reuse the same `pipedrive_response_id` and PUT updates instead of creating new notes.

### 6.2 Target resolution

```sql
SELECT pipedrive_response_id, id AS row_id, created_at
FROM pipedrive_activities
WHERE scenario = 'pasta_summary'
  AND pasta = ?
  AND status = 'success'
  AND pipedrive_response_id IS NOT NULL
ORDER BY created_at DESC
LIMIT 1;
```

- Row found → **PUT** with `target = pipedrive_response_id`.
- No row → **POST** (first note for the pasta).

### 6.3 Edge case — note deleted in Pipedrive

When `PUT /v1/notes/:id` returns `404`:

1. Mark `pipedrive_activities.status = 'orphaned'` on the previous row.
2. Issue a fresh **POST** (creates a replacement note).
3. Persist new `pipedrive_response_id` in a fresh row.
4. Log at `level=warn`: `"pipedrive note deleted upstream, recreating"`.

No silent 404s — the operator must be aware when notes disappear.

### 6.4 Client changes

`PipedriveOutgoingIntent` gains an optional field:

```typescript
type PipedriveOutgoingIntent = {
  kind: 'note' | 'activity'
  payload: object
  dedup_key: string
  update_target_id?: string  // when set → PUT instead of POST
}
```

`dispatch()` branches:

```typescript
const url = intent.update_target_id
  ? `${baseUrl}/v1/notes/${intent.update_target_id}?api_token=${token}`
  : `${baseUrl}/v1/notes?api_token=${token}`

const method = intent.update_target_id ? 'PUT' : 'POST'
```

The existing 429/5xx retry/backoff continues to apply — only the verb changes. The PUT response shape matches POST (`{ data: { id, ... } }`).

### 6.5 Publisher changes

`enqueuePastaSummary()` resolves the target before enqueueing:

```typescript
enqueuePastaSummary(intent, meta) {
  const target = this.store?.findCurrentPastaNote(meta.pasta)
  const builtIntent = buildPastaSummaryNote(intent, this.companyDomain)
  if (target) builtIntent.update_target_id = target.pipedrive_response_id
  return this.add(builtIntent, { ...meta, target_row_id: target?.row_id ?? null })
}
```

**Dedup behavior changes**:

| Scenario | Dedup |
|---|---|
| No `update_target_id` (POST first note) | active (blocks duplicate `dedup_key`) |
| With `update_target_id` (PUT) | **disabled** — always attempt update |

This is correct: dedup exists to prevent "scan ran twice → 2 notes". With PUT this is no longer a problem — same call twice = same content on same id = idempotent.

### 6.6 Lock — atomic "lookup + dispatch"

Critical race avoided:

```
T0  scan-A reads pipedrive_activities → no row → goes POST
T1  scan-B reads pipedrive_activities → no row → goes POST
T2  scan-A POST OK → row created with note_id=999
T3  scan-B POST OK → row created with note_id=1000  ← ✗ duplicate notes
```

Solution: `note.pasta_summary:<pasta>` lock (Section 7) acquired before the lookup, held until `updateResult` finishes.

### 6.7 Revision history

Every successful PUT writes a **new** row in `pipedrive_activities`:

```
status                = 'success'
scenario              = 'pasta_summary'
pasta                 = '15516752-A'
pipedrive_response_id = '999'   ← same id as previous row
revises_row_id        = <previous row id>
http_verb             = 'PUT'
http_status           = 200
attempts              = N
created_at            = now
```

→ the table becomes an **immutable revision log**: `SELECT * WHERE pipedrive_response_id = '999' ORDER BY created_at` shows the full edit history of that note.

### 6.8 Guarantees

| Guarantee | Mechanism |
|---|---|
| One note per pasta in Pipedrive | `note.pasta_summary:<pasta>` lock + lookup-then-write |
| Manual delete recovery | 404 detection → POST + `status='orphaned'` |
| Revision history | `revises_row_id` chains successive edits |
| PUT idempotence | 429/5xx backoff (existing); operation is naturally idempotent |
| No duplicate note in race | Lock + `dedup_key` (defense in depth) |

---

## 7. Locking & concurrency

### 7.1 SQLite schemas

```sql
CREATE TABLE IF NOT EXISTS pasta_locks (
  lock_key       TEXT PRIMARY KEY,
  acquired_by    TEXT NOT NULL,
  acquired_at    TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  fence_token    INTEGER NOT NULL,
  context_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_pasta_locks_expires ON pasta_locks(expires_at);

CREATE TABLE IF NOT EXISTS pasta_lock_fences (
  lock_key            TEXT PRIMARY KEY,
  next_fence_token    INTEGER NOT NULL DEFAULT 1
);
```

`pasta_lock_fences` keeps the monotonic counter even after a lock is released — fence tokens are never reused.

### 7.2 `PastaLockManager` API

```typescript
export interface LockHandle {
  readonly key: string
  readonly fenceToken: number
  readonly acquiredAt: Date
  readonly expiresAt: Date
  release(): void              // idempotent
  isStillValid(): boolean      // true while still the current holder
}

export class PastaLockManager {
  acquire(key: string, ttlMs: number, context?: object): LockHandle | null

  acquireWithWait(key: string, ttlMs: number, opts: {
    timeoutMs: number
    pollMs: number
    context?: object
  }): Promise<LockHandle | null>

  releaseExpired(): number     // cleanup; called on boot + every 5 min
  describe(key: string): LockState | null
  listAll(): LockState[]
}
```

**Atomic acquire** (single SQLite transaction = `BEGIN IMMEDIATE`):

```typescript
acquire(key, ttlMs, context) {
  return this.db.transaction(() => {
    const now = new Date()
    const expiresIso = new Date(now.getTime() + ttlMs).toISOString()

    // 1. Lazy reaping for this key
    this.db.prepare(
      `DELETE FROM pasta_locks WHERE lock_key = ? AND expires_at < ?`
    ).run(key, now.toISOString())

    // 2. Held check
    const existing = this.db.prepare(
      `SELECT acquired_by FROM pasta_locks WHERE lock_key = ?`
    ).get(key)
    if (existing) return null

    // 3. Allocate next fence token (monotonic, persistent)
    this.db.prepare(`
      INSERT INTO pasta_lock_fences (lock_key, next_fence_token)
      VALUES (?, 2)
      ON CONFLICT (lock_key) DO UPDATE SET next_fence_token = next_fence_token + 1
    `).run(key)
    const { next_fence_token } = this.db.prepare(
      `SELECT next_fence_token FROM pasta_lock_fences WHERE lock_key = ?`
    ).get(key) as { next_fence_token: number }
    const fenceToken = next_fence_token - 1

    // 4. Insert
    const workerId = randomUUID()
    this.db.prepare(`
      INSERT INTO pasta_locks (lock_key, acquired_by, acquired_at, expires_at, fence_token, context_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(key, workerId, now.toISOString(), expiresIso, fenceToken, JSON.stringify(context ?? null))

    return {
      key, fenceToken, acquiredAt: now, expiresAt: new Date(expiresIso),
      release: () => this.release(key, workerId, fenceToken),
      isStillValid: () => this.isHolder(key, workerId, fenceToken),
    }
  })()
}
```

`release()` deletes only if `acquired_by = workerId AND fence_token = fenceToken`. If another process resumed the lock (TTL expired), release is a no-op for the new holder.

### 7.3 Fence tokens — zombie-holder defense

```
T0   scanner-A acquire(scan:foo)  → fence=10, ttl=1h
T1   scanner-A starts scan, processes 50 deals
T2   scanner-A: long GC pause / event-loop stall
T3   ttl expires (1h)
T4   scanner-B acquire(scan:foo)  → fence=11
T5   scanner-B starts a parallel scan
T6   scanner-A "wakes up" → tries to write
                                           ◀ ✗ corruption without defense
```

**Defense**: every critical write checks `lock.isStillValid()` before commit. If the token has changed (`fence=11 ≠ 10`), the write is aborted:

```typescript
async retryErrorsPass(jobId, errorDeals) {
  const lock = this.activeLocks.get(`scan:${pasta}`)!
  for (const deal of errorDeals) {
    if (!lock.isStillValid()) {
      logger.warn('lost scan lock mid-retry, aborting', { jobId, fenceToken: lock.fenceToken })
      throw new LockExpiredError()
    }
    await this.retryPhones(deal)
  }
}
```

Cost: one indexed `SELECT` per critical loop iteration — negligible.

### 7.4 Contention policies

**`scan.<pasta>` — fail-fast (HTTP 409)**

```
HTTP/1.1 409 Conflict
{
  "error": "scan_in_progress",
  "pasta": "15516752-A",
  "current_job_id": "QU0R8kJsDt0z5mBoNnHrw",
  "acquired_at": "2026-05-06T14:00:00Z",
  "expires_at": "2026-05-06T15:00:00Z"
}
```

The operator knows **which job** is running and **when its lock expires**. Cancel or wait.

**`note.pasta_summary:<pasta>` — wait-with-retry**

The publisher can wait (up to 15 s, 3 polls × 5 s) because dispatch is async — there is no operator blocking on a UI:

```typescript
const lock = await locks.acquireWithWait(
  `note.pasta_summary:${pasta}`,
  60_000,
  { timeoutMs: 15_000, pollMs: 5_000, context: { job_id, pasta } }
)
if (!lock) {
  this.queue.unshift(item)
  await sleep(30_000)
  return
}
```

### 7.5 Cleanup & observability

- **Boot reap**: `pastaLocks.releaseExpired()` called once on startup; `level=warn` if reaped > 0.
- **Periodic reap**: `setInterval(() => pastaLocks.releaseExpired(), 5 * 60_000)`.
- **Diagnostic endpoint** `GET /api/v1/admin/locks`: returns full lock list with context.

### 7.6 Race-free guarantees

| Race | Defense |
|---|---|
| Two concurrent scans on same pasta | `scan.<pasta>` fail-fast 409 |
| Crash mid-scan leaves dangling lock | TTL + reaping |
| Zombie holder after GC/crash | Fence token verified on critical writes |
| Two publishers POSTing same pasta | `note.pasta_summary:<pasta>` + `dedup_key` |
| PUT to deleted note id | 404 detect → fallback POST + `status='orphaned'` |
| Concurrent ADB probe on same device | `probe.<device_serial>` mutex (existing) |
| Worker A retry overwrites Worker B's result | Fence check before `store.upsertDeal()` |

---

## 8. Auditing & snapshots

### 8.1 Migrations (idempotent, run on boot via `initialize()`)

#### `wa_contact_checks` — attempt phase

```sql
ALTER TABLE wa_contact_checks
  ADD COLUMN attempt_phase TEXT NOT NULL DEFAULT 'probe_initial';

CREATE INDEX IF NOT EXISTS idx_wa_checks_phase_time
  ON wa_contact_checks(attempt_phase, checked_at DESC);
```

Values: `probe_initial`, `probe_recover`, `scan_retry`, `sweep_retry`.

`evidence` JSON gains:
```json
{
  "ui_state": "chat_list",
  "matched_rule": "conversations_row_repeated",
  "dump_length": 58048,
  "snapshot_path": null,
  "polls": 4,
  "fence_token": 17,
  "recovery_action": "force_stop"
}
```

#### `adb_precheck_jobs` — sweep lineage

```sql
ALTER TABLE adb_precheck_jobs
  ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE adb_precheck_jobs
  ADD COLUMN parent_job_id TEXT REFERENCES adb_precheck_jobs(id);

CREATE INDEX IF NOT EXISTS idx_jobs_parent ON adb_precheck_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_trigger ON adb_precheck_jobs(triggered_by, created_at DESC);
```

Values for `triggered_by`: `manual`, `retry-errors-sweep`, `cron`, `webhook`.

#### `pipedrive_activities` — note revisions

```sql
ALTER TABLE pipedrive_activities
  ADD COLUMN revises_row_id TEXT REFERENCES pipedrive_activities(id);

ALTER TABLE pipedrive_activities
  ADD COLUMN http_verb TEXT NOT NULL DEFAULT 'POST';

CREATE INDEX IF NOT EXISTS idx_pipedrive_pasta_current
  ON pipedrive_activities(pasta, scenario, created_at DESC)
  WHERE status = 'success';

CREATE INDEX IF NOT EXISTS idx_pipedrive_revises
  ON pipedrive_activities(revises_row_id) WHERE revises_row_id IS NOT NULL;
```

#### `pasta_locks` + `pasta_lock_fences` — see Section 7.1.

### 8.2 Probe snapshots — filesystem

Layout, naming, quotas, retention — see Section 4.3.

### 8.3 New observability endpoints

`GET /api/v1/plugins/adb-precheck/jobs/:id` — gains:

```json
{
  "id": "QU0R8kJsDt0z5mBoNnHrw",
  "triggered_by": "manual",
  "parent_job_id": null,
  "retry_stats": {
    "level_1_resolves": 23,
    "level_2_resolves": 4,
    "remaining_errors": 2
  },
  "ui_state_distribution": {
    "chat_open": 287,
    "invite_modal": 52,
    "chat_list": 18,
    "unknown_dialog": 3,
    "unknown": 1
  },
  "snapshots_captured": 4
}
```

`GET /api/v1/plugins/adb-precheck/notes/:pasta/history`:

```json
{
  "pasta": "15516752-A",
  "current_pipedrive_id": "999",
  "revisions": [
    { "row_id": "abc", "verb": "POST", "created_at": "...", "job_id": "...", "triggered_by": "manual" },
    { "row_id": "def", "verb": "PUT", "created_at": "...", "job_id": "...", "triggered_by": "retry-errors-sweep", "revises_row_id": "abc" }
  ]
}
```

`GET /api/v1/admin/locks` — see Section 7.5.

`GET /api/v1/admin/probe-snapshots?since=&state=&pasta=` — list snapshot files with metadata.

### 8.4 Operational queries (documented in `docs/operations/`)

```sql
-- Save rate by retry level (calibration)
SELECT attempt_phase, result, COUNT(*) AS n, ROUND(AVG(latency_ms)) AS avg_ms
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day')
GROUP BY attempt_phase, result
ORDER BY attempt_phase, result;

-- Most common failing UI states (classifier calibration)
SELECT json_extract(evidence,'$.ui_state') AS state,
       COUNT(*) AS hits,
       SUM(CASE WHEN result = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive_n
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day') AND source='adb_probe'
GROUP BY state ORDER BY hits DESC;

-- Pastas with most dangling errors (sweep prioritization)
SELECT pasta, COUNT(*) AS deals_with_errors
FROM adb_precheck_deals
WHERE phones_json LIKE '%"outcome":"error"%'
  AND scanned_at > datetime('now','-7 day')
GROUP BY pasta ORDER BY deals_with_errors DESC LIMIT 20;

-- Sweep lineage (which sweep recovered which job)
SELECT j.id AS sweep_job, j.created_at, j.parent_job_id,
       p.pasta, p.scanned_deals AS parent_total,
       (SELECT COUNT(*) FROM adb_precheck_deals d WHERE d.last_job_id = j.id) AS sweep_processed
FROM adb_precheck_jobs j
LEFT JOIN adb_precheck_jobs p ON p.id = j.parent_job_id
WHERE j.triggered_by = 'retry-errors-sweep'
ORDER BY j.created_at DESC;
```

### 8.5 Structured-logging fields

Every scanner / probe / publisher log entry carries (when applicable):

| Field | Scope |
|---|---|
| `correlation_id` | always (existing) |
| `job_id` | inside scan/sweep |
| `pasta` | inside scan/sweep |
| `attempt_phase` | probe + retry |
| `ui_state` | probe + retry |
| `fence_token` | critical writes |
| `lock_held_for_ms` | on lock release |

End-to-end trace by deal:
```bash
grep '"job_id":"QU0R8..."' logs/dispatch.*.log | jq -r '"\(.time) [\(.attempt_phase // "-")] \(.msg)"'
```

---

## 9. Testing strategy

TDD red → green → refactor per CLAUDE.md. Most logic is deterministic (pure classifier, SQLite locks, publisher branches) → high coverage without hardware.

### 9.1 Tier 1 — Pure unit tests (zero infra)

#### `ui-state-classifier.test.ts`

Fixture-driven (`packages/core/test/fixtures/ui-states/*.xml`):

| Fixture | Source |
|---|---|
| `chat_open_input.xml` | live capture in chat |
| `invite_modal_pt_br.xml` | **already captured** from device 9b0100… |
| `invite_modal_en.xml` | locale-switched capture |
| `chat_list_full.xml` | home dump |
| `contact_picker.xml` | post `am start ContactPicker` |
| `disappearing_msg_dialog.xml` | open contact with timer set |
| `searching_spinner.xml` | mid-intent dump |
| `unknown_dialog_generic.xml` | synthesized with `android:id/message` + button1/2 |
| `unknown_blank.xml` | post-crash dump |
| `regression/2026-05-06_chat_list_58048.xml` | reproduce stuck-screen capture |

Tests cover decisive, retryable, unknown, and explicit priority-order edge cases (e.g. `chat_open` beats `chat_list` when both signals present).

Coverage target: **100 %** branches.

#### `pasta-lock-manager.test.ts`

In-memory SQLite (`new Database(':memory:')` → `initialize()`). Cases:

- acquire on free key
- acquire returns null when held
- release deletes only when holder matches
- release after fence mismatch is a no-op
- expired lock cleaned up on next acquire
- fence token monotonic across releases
- `acquireWithWait` waits and succeeds when holder releases
- `acquireWithWait` times out gracefully
- `isStillValid` detects stale holder
- `describe` returns lock state
- `listAll` filters expired

Coverage target: **95 %** branches.

#### `pipedrive-publisher.test.ts` (extension)

- first call POST creates note
- second call PUT updates same note
- PUT 404 falls back to POST and marks orphaned
- dedup is bypassed for PUT
- lock acquire failure requeues

Coverage target: **90 %** branches on the upsert path.

### 9.2 Tier 2 — Integration with real SQLite

#### `scanner.test.ts` (extension — retry pass)

- phones with error are re-validated on the 2nd pass
- already-valid phones are NOT re-validated
- `retry_errors=false` disables the pass
- retry pass respects fence_token (aborts if lost)
- final `errorCount` reflects post-retry state

#### `scanner-retry-errors-sweep.test.ts` (new)

- lists deals with errors and re-validates only error phones
- updates note in-place after sweep
- respects `scan.<pasta>` lock — 409 on concurrent

### 9.3 Tier 3 — Strategy with mocked ADB

#### `adb-probe-strategy.test.ts` (extension — recover-and-retry)

- classifier returns `chat_list` → force-stop + retry → exists
- `disappearing_msg_dialog` → BACK keyevent + retry (no force-stop)
- 2 retryable results in a row → final `inconclusive`
- snapshot persisted when `ui_state = unknown`
- daily 500-snapshot quota enforced
- per-minute 10-snapshot rate limit enforced

### 9.4 Tier 4 — E2E with real device (manual, before merge)

Not in CI; mandatory pre-merge per CLAUDE.md. Scenarios:

1. **Happy-path scale**: precheck 100 real deals; expect job completion, error rate < 1 %, single Pipedrive note, traceable logs.
2. **Re-run pasta**: same pasta scanned twice; expect existing note updated (`http_verb='PUT'`, `revises_row_id` set), no duplicate in Pipedrive.
3. **Manual sweep**: after a scan with residual errors, `POST /retry-errors`; expect new sweep job row, error count drops, note updated.
4. **Lock contention**: second scan on same pasta returns 409 with `current_job_id`.
5. **Snapshot capture**: force unknown UI before scan; expect XML in `data/probe-snapshots/`, `wa_contact_checks.evidence.snapshot_path` populated.
6. **Crash recovery**: kill the process mid-scan; restart confirms `releaseExpired()` reaped, `adb_precheck_jobs` marked `failed`, locks cleared.

E2E driver script: `scripts/e2e-precheck-scale.sh` (see Section 7.6 of the brainstorm; full bash to be specified in the implementation plan).

---

## 10. Migration & rollout

### 10.1 Order of merge (single PR per phase)

1. **Phase A — Foundations** (no behavior change for users):
   - Add `pasta-lock-manager.ts` + tests + migrations.
   - Add `attempt_phase`, `triggered_by`, `parent_job_id`, `revises_row_id`, `http_verb` columns.
   - Wire migrations into boot path.
2. **Phase B — Classifier extraction**:
   - Add `ui-state-classifier.ts` as a pure module.
   - Refactor `adb-probe-strategy.ts` to delegate; behavior unchanged at this point.
   - All existing tests pass (regression).
3. **Phase C — Level 1 retry + snapshots**:
   - Add recover-and-retry inside the probe.
   - Wire snapshot persistence (with quotas).
   - Adds new `attempt_phase: probe_recover` rows.
4. **Phase D — Level 2 retry + Pipedrive PUT**:
   - End-of-scan retry pass.
   - Publisher → upsert with `update_target_id`.
   - PastaLock taken around publish.
5. **Phase E — Level 3 sweep endpoint + observability**:
   - `POST /retry-errors`.
   - `GET /jobs/:id` extension, `GET /notes/:pasta/history`, `GET /admin/locks`, `GET /admin/probe-snapshots`.

Each phase ships standalone, tests pass, behavior is monotonic (retry only adds protection, never regresses). Rollback path: revert the offending PR; migrations are additive and idempotent.

### 10.2 Deployment safety

- All new SQLite columns have `DEFAULT` values → existing rows valid post-migration.
- New tables (`pasta_locks`, `pasta_lock_fences`) created `IF NOT EXISTS`.
- Old code reading `pipedrive_activities` ignores `revises_row_id` and `http_verb` (extra columns).
- Snapshot directory auto-created on first miss.

### 10.3 Operational runbook (to commit alongside)

- `docs/operations/adb-precheck-runbook.md` — paste-ready SQL queries (Section 8.4), endpoint URLs, lock-clear instructions.
- `docs/operations/adb-precheck-snapshot-calibration.md` — workflow for promoting a captured XML to a fixture and adding a classifier rule.

---

## 11. Open questions / future work

- **Cron-driven sweep**: ops decision on cadence; if frequent, expose Prometheus metric `adb_precheck_remaining_errors` and trigger sweep when it crosses a threshold.
- **Snapshot-driven classifier auto-update**: long-term, a periodic job could cluster `unknown` snapshots by structural similarity to suggest new classifier rules to the dev. Out of scope for this iteration.
- **Multi-device parallelism inside ADB pre-check**: not needed today (single device); revisit if pre-check throughput becomes the bottleneck once notification path scales to 15+ devices.
- **Pipedrive note size limit**: a pasta with very many deals could exceed Pipedrive's note body limit. Today the formatter truncates implicitly; an explicit pagination strategy (e.g., supplemental notes) may be needed at >1 000 deals/pasta.
