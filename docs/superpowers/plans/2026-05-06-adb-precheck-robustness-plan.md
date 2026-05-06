# ADB Pre-check Robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate "⚠️ Erro de verificação" leaks at scale by adding a pure UI state classifier, 3-level retry pipeline, in-place Pipedrive note upsert, and SQLite-backed pasta locks with fence tokens — enabling safe scaling from 100 → 1000+ deals per scan.

**Architecture:** Pure UI classifier extracted from `adb-probe-strategy.ts`. New `PastaLockManager` provides race-free per-pasta locks for scan and note publish. Scanner gains an end-of-scan retry pass and a manual `retry-errors` sweep entrypoint. Publisher resolves an existing Pipedrive note via `pipedrive_activities` and emits PUT instead of POST when present, with revision history via `revises_row_id`.

**Tech Stack:** TypeScript / Node 22 / better-sqlite3 / Fastify / Vitest. All migrations idempotent (`ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info`; `CREATE TABLE IF NOT EXISTS`). All tests follow TDD red → green → refactor per CLAUDE.md.

**Spec reference:** `docs/superpowers/specs/2026-05-06-adb-precheck-robustness-design.md`

---

## File map

### New files

| Path | Responsibility |
|---|---|
| `packages/core/src/locks/pasta-lock-manager.ts` | SQLite-backed lock manager with fence tokens |
| `packages/core/src/locks/pasta-lock-manager.test.ts` | Unit tests (in-memory DB) |
| `packages/core/src/check-strategies/ui-state-classifier.ts` | Pure XML → UiState classifier |
| `packages/core/src/check-strategies/ui-state-classifier.test.ts` | Fixture-driven tests |
| `packages/core/test/fixtures/ui-states/*.xml` | 9 XML fixtures for classifier |
| `packages/core/src/snapshots/probe-snapshot-writer.ts` | Quota-bounded snapshot persistence |
| `packages/core/src/snapshots/probe-snapshot-writer.test.ts` | Quota / rate-limit tests |
| `packages/core/src/snapshots/list.ts` | List snapshot files for admin endpoint |
| `scripts/e2e-precheck-scale.sh` | Manual E2E driver |
| `docs/operations/adb-precheck-runbook.md` | Operator queries & endpoints |
| `docs/operations/adb-precheck-snapshot-calibration.md` | Developer playbook for new UI states |

### Modified files

| Path | What changes |
|---|---|
| `packages/core/src/contacts/contact-registry.ts` | `attempt_phase` column + index migration |
| `packages/core/src/check-strategies/adb-probe-strategy.ts` | Delegate classification, add recover-and-retry |
| `packages/core/src/validator/contact-validator.ts` | Forward `attempt_phase` to `recordCheck` |
| `packages/core/src/plugins/adb-precheck/job-store.ts` | `triggered_by`, `parent_job_id` migrations + helpers |
| `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts` | `revises_row_id`, `http_verb` columns; `findCurrentPastaNote`, `markOrphaned` |
| `packages/core/src/plugins/adb-precheck/pipedrive-client.ts` | PUT branch, 404 detection in dispatch |
| `packages/core/src/plugins/adb-precheck/pipedrive-publisher.ts` | Resolve target, lock-protected upsert, requeue on lock miss |
| `packages/core/src/plugins/adb-precheck/scanner.ts` | End-of-scan retry pass, sweep entrypoint, fence-token guard |
| `packages/core/src/plugins/adb-precheck-plugin.ts` | Wire `PastaLockManager`; register new routes |

---

## Phase A — Foundations (locks + migrations)

No behavior change for users. Adds plumbing the rest of the plan depends on.

### Task A1: Schema + skeleton for `PastaLockManager`

**Files:**
- Create: `packages/core/src/locks/pasta-lock-manager.ts`
- Create: `packages/core/src/locks/pasta-lock-manager.test.ts`

- [ ] **Step 1: Write the failing test (smoke + initialize)**

```typescript
// packages/core/src/locks/pasta-lock-manager.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { PastaLockManager } from './pasta-lock-manager.js'

describe('PastaLockManager — initialize', () => {
  it('creates pasta_locks and pasta_lock_fences tables', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const mgr = new PastaLockManager(db)
    mgr.initialize()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('pasta_locks')
    expect(names).toContain('pasta_lock_fences')
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd packages/core && npx vitest run src/locks/pasta-lock-manager.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement skeleton with schema**

```typescript
// packages/core/src/locks/pasta-lock-manager.ts
import type Database from 'better-sqlite3'

const SCHEMA_SQL = `
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
`

export interface LockState {
  key: string
  acquiredBy: string
  acquiredAt: Date
  expiresAt: Date
  fenceToken: number
  context: object | null
}

export interface LockHandle {
  readonly key: string
  readonly fenceToken: number
  readonly acquiredAt: Date
  readonly expiresAt: Date
  release(): void
  isStillValid(): boolean
}

export class PastaLockManager {
  constructor(private readonly db: Database.Database) {}

  initialize(): void {
    this.db.exec(SCHEMA_SQL)
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
cd packages/core && npx vitest run src/locks/pasta-lock-manager.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/locks/
git commit -m "feat(locks): scaffold PastaLockManager with schema"
```

---

### Task A2: `acquire()` — happy path + null when held

**Files:**
- Modify: `packages/core/src/locks/pasta-lock-manager.ts`
- Modify: `packages/core/src/locks/pasta-lock-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('PastaLockManager — acquire', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  it('returns a handle on a free key', () => {
    const handle = mgr.acquire('scan:foo', 60_000)
    expect(handle).not.toBeNull()
    expect(handle!.key).toBe('scan:foo')
    expect(handle!.fenceToken).toBe(1)
  })

  it('returns null when key is already held', () => {
    const a = mgr.acquire('scan:foo', 60_000)
    expect(a).not.toBeNull()
    const b = mgr.acquire('scan:foo', 60_000)
    expect(b).toBeNull()
  })

  it('persists context_json', () => {
    mgr.acquire('scan:foo', 60_000, { job_id: 'abc', pasta: 'P-1' })
    const row = db.prepare('SELECT context_json FROM pasta_locks WHERE lock_key=?').get('scan:foo') as { context_json: string }
    expect(JSON.parse(row.context_json)).toEqual({ job_id: 'abc', pasta: 'P-1' })
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement `acquire`** (use `db.transaction(() => { ... })()` to wrap delete-stale → existence-check → fence-allocate → insert in a single `BEGIN IMMEDIATE`. See spec §7.2 for the full code. Key implementation points: `randomUUID()` for `acquired_by`; `INSERT INTO pasta_lock_fences VALUES (key, 2) ON CONFLICT DO UPDATE SET next_fence_token = next_fence_token + 1` for monotonic fence assignment; `fenceToken = next_fence_token - 1` after the upsert; private `releaseHolder(key, workerId, fenceToken)` deletes only when all three match; private `isHolder` does the corresponding SELECT 1.)

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/locks/
git commit -m "feat(locks): acquire/release with fence tokens"
```

---

### Task A3: Release semantics + fence-mismatch defense

- [ ] **Step 1: Write failing tests**

```typescript
describe('PastaLockManager — release & fence', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  it('release frees the key', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    a.release()
    const b = mgr.acquire('scan:foo', 60_000)
    expect(b).not.toBeNull()
  })

  it('release of stale holder is a no-op', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'scan:foo'").run()
    const b = mgr.acquire('scan:foo', 60_000)!
    expect(b.fenceToken).toBe(2)
    a.release()
    expect(b.isStillValid()).toBe(true)
  })

  it('isStillValid returns false after takeover', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'scan:foo'").run()
    mgr.acquire('scan:foo', 60_000)
    expect(a.isStillValid()).toBe(false)
  })

  it('fence token monotonic across releases', () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    a.release()
    const b = mgr.acquire('scan:foo', 60_000)!
    expect(b.fenceToken).toBe(2)
    b.release()
    const c = mgr.acquire('scan:foo', 60_000)!
    expect(c.fenceToken).toBe(3)
  })
})
```

- [ ] **Step 2: Run; expect PASS** (covered by the A2 implementation — these are regression locks)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/locks/pasta-lock-manager.test.ts
git commit -m "test(locks): cover stale-holder release and fence monotonicity"
```

---

### Task A4: `acquireWithWait`, `releaseExpired`, `describe`, `listAll`

- [ ] **Step 1: Write failing tests**

```typescript
describe('PastaLockManager — extended API', () => {
  let db: Database.Database
  let mgr: PastaLockManager
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    mgr = new PastaLockManager(db)
    mgr.initialize()
  })

  it('acquireWithWait succeeds after holder releases', async () => {
    const a = mgr.acquire('scan:foo', 60_000)!
    setTimeout(() => a.release(), 100)
    const b = await mgr.acquireWithWait('scan:foo', 60_000, { timeoutMs: 1000, pollMs: 50 })
    expect(b).not.toBeNull()
  })

  it('acquireWithWait times out and returns null', async () => {
    mgr.acquire('scan:foo', 60_000)
    const b = await mgr.acquireWithWait('scan:foo', 60_000, { timeoutMs: 200, pollMs: 50 })
    expect(b).toBeNull()
  })

  it('releaseExpired removes only expired rows', () => {
    mgr.acquire('a', 60_000)
    mgr.acquire('b', 60_000)
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'a'").run()
    const reaped = mgr.releaseExpired()
    expect(reaped).toBe(1)
    expect(mgr.describe('a')).toBeNull()
    expect(mgr.describe('b')).not.toBeNull()
  })

  it('describe returns lock state', () => {
    mgr.acquire('scan:foo', 60_000, { job_id: 'X' })
    const desc = mgr.describe('scan:foo')!
    expect(desc.key).toBe('scan:foo')
    expect(desc.context).toEqual({ job_id: 'X' })
    expect(desc.fenceToken).toBe(1)
  })

  it('listAll filters expired and returns all live', () => {
    mgr.acquire('a', 60_000)
    mgr.acquire('b', 60_000)
    db.prepare("UPDATE pasta_locks SET expires_at = '2000-01-01T00:00:00Z' WHERE lock_key = 'a'").run()
    const live = mgr.listAll()
    expect(live.map((l) => l.key)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement methods** (signatures and behavior per spec §7.2: `acquireWithWait` polls `acquire` every `pollMs` until `timeoutMs` elapses; `releaseExpired` runs `DELETE FROM pasta_locks WHERE expires_at < now` and returns `result.changes ?? 0`; `describe` selects single row by `lock_key`; `listAll` selects all live rows ordered by `acquired_at`; both `describe` and `listAll` map rows through a private `rowToState` helper that parses `context_json` into an object or null.)

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/locks/
git commit -m "feat(locks): acquireWithWait, releaseExpired, describe, listAll"
```

---

### Task A5: Migration — `wa_contact_checks.attempt_phase`

**Files:**
- Modify: `packages/core/src/contacts/contact-registry.ts`

- [ ] **Step 1: Write failing test** (in `contact-registry.test.ts`):

```typescript
describe('ContactRegistry — attempt_phase migration', () => {
  it('adds attempt_phase column with default probe_initial', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const reg = new ContactRegistry(db)
    reg.initialize()
    const cols = db
      .prepare("PRAGMA table_info('wa_contact_checks')")
      .all() as Array<{ name: string; dflt_value: string | null }>
    const phase = cols.find((c) => c.name === 'attempt_phase')
    expect(phase).toBeDefined()
    expect(phase!.dflt_value).toContain('probe_initial')
  })

  it('record() persists attempt_phase when supplied', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const reg = new ContactRegistry(db)
    reg.initialize()
    reg.record('5511999999999', {
      phone_input: '5511999999999',
      phone_variant_tried: '5511999999999',
      source: 'adb_probe',
      result: 'inconclusive',
      confidence: null,
      evidence: { ui_state: 'chat_list' },
      device_serial: 'X',
      waha_session: null,
      triggered_by: 'pre_check',
      latency_ms: 1000,
      ddd: '11',
      wa_chat_id: null,
      attempt_phase: 'probe_recover',
    })
    const row = db
      .prepare('SELECT attempt_phase FROM wa_contact_checks WHERE phone_normalized = ?')
      .get('5511999999999') as { attempt_phase: string }
    expect(row.attempt_phase).toBe('probe_recover')
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement migration in `initialize()` (idempotent guard)**

After the existing `db.exec(SCHEMA_SQL)` block in `ContactRegistry.initialize()`:

```typescript
const cols = this.db
  .prepare("PRAGMA table_info('wa_contact_checks')")
  .all() as Array<{ name: string }>
if (!cols.some((c) => c.name === 'attempt_phase')) {
  this.db.exec(
    "ALTER TABLE wa_contact_checks ADD COLUMN attempt_phase TEXT NOT NULL DEFAULT 'probe_initial'",
  )
}
this.db.exec(
  'CREATE INDEX IF NOT EXISTS idx_wa_checks_phase_time ON wa_contact_checks(attempt_phase, checked_at DESC)',
)
```

Add `attempt_phase` to `RecordCheckInput` and append the column to the existing INSERT statement (one extra `?` in VALUES). Default to `'probe_initial'` when absent.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/contacts/
git commit -m "feat(contacts): add attempt_phase column to wa_contact_checks"
```

---

### Task A6: Migration — `adb_precheck_jobs.triggered_by` + `parent_job_id`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('PrecheckJobStore — triggered_by/parent migration', () => {
  it('adds columns and indexes', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const cols = db
      .prepare("PRAGMA table_info('adb_precheck_jobs')")
      .all() as Array<{ name: string }>
    expect(cols.find((c) => c.name === 'triggered_by')).toBeDefined()
    expect(cols.find((c) => c.name === 'parent_job_id')).toBeDefined()
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='adb_precheck_jobs'")
      .all() as Array<{ name: string }>
    const names = idx.map((i) => i.name)
    expect(names).toContain('idx_jobs_parent')
    expect(names).toContain('idx_jobs_trigger')
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Add migrations to `initialize()`** (alongside the existing `pipedrive_enabled` / `hygienization_mode` PRAGMA-guarded blocks):

```typescript
if (!cols.some((c) => c.name === 'triggered_by')) {
  this.db.exec(
    "ALTER TABLE adb_precheck_jobs ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'",
  )
}
if (!cols.some((c) => c.name === 'parent_job_id')) {
  this.db.exec(
    'ALTER TABLE adb_precheck_jobs ADD COLUMN parent_job_id TEXT REFERENCES adb_precheck_jobs(id)',
  )
}
this.db.exec(
  'CREATE INDEX IF NOT EXISTS idx_jobs_parent ON adb_precheck_jobs(parent_job_id)',
)
this.db.exec(
  'CREATE INDEX IF NOT EXISTS idx_jobs_trigger ON adb_precheck_jobs(triggered_by, created_at DESC)',
)
```

Extend `createJob(params)` to accept optional `triggered_by` and `parent_job_id` and append them to the INSERT.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): triggered_by + parent_job_id on adb_precheck_jobs"
```

---

### Task A7: Migration — `pipedrive_activities.revises_row_id` + `http_verb`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('PipedriveActivityStore — upsert columns', () => {
  it('adds revises_row_id and http_verb', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const cols = db
      .prepare("PRAGMA table_info('pipedrive_activities')")
      .all() as Array<{ name: string; dflt_value: string | null }>
    expect(cols.find((c) => c.name === 'revises_row_id')).toBeDefined()
    const verb = cols.find((c) => c.name === 'http_verb')
    expect(verb).toBeDefined()
    expect(verb!.dflt_value).toContain('POST')
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement migration** (in `PipedriveActivityStore.initialize()` after existing schema):

```typescript
const cols = this.db
  .prepare("PRAGMA table_info('pipedrive_activities')")
  .all() as Array<{ name: string }>
if (!cols.some((c) => c.name === 'revises_row_id')) {
  this.db.exec('ALTER TABLE pipedrive_activities ADD COLUMN revises_row_id TEXT REFERENCES pipedrive_activities(id)')
}
if (!cols.some((c) => c.name === 'http_verb')) {
  this.db.exec("ALTER TABLE pipedrive_activities ADD COLUMN http_verb TEXT NOT NULL DEFAULT 'POST'")
}
this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipedrive_pasta_current
  ON pipedrive_activities(pasta, scenario, created_at DESC) WHERE status = 'success'`)
this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipedrive_revises
  ON pipedrive_activities(revises_row_id) WHERE revises_row_id IS NOT NULL`)
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): revises_row_id + http_verb on pipedrive_activities"
```

---

### Task A8: Wire `PastaLockManager` into plugin boot

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Write failing test in `adb-precheck-plugin.test.ts`**

```typescript
import { PastaLockManager } from '../locks/pasta-lock-manager.js'

describe('AdbPrecheckPlugin — pasta-lock wiring', () => {
  it('reaps expired pasta locks on boot', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const mgr = new PastaLockManager(db)
    mgr.initialize()
    db.prepare(`INSERT INTO pasta_locks (lock_key, acquired_by, acquired_at, expires_at, fence_token)
                VALUES ('scan:stale', 'oldworker', '2000-01-01T00:00:00Z', '2000-01-01T00:00:01Z', 1)`).run()
    expect(mgr.releaseExpired()).toBe(1)
  })
})
```

- [ ] **Step 2: Run; expect PASS** (uses existing manager; this is a smoke test for the boot logic)

- [ ] **Step 3: Wire into plugin boot path**

After the `PrecheckJobStore` construction (~line 211) in `adb-precheck-plugin.ts`:

```typescript
import { PastaLockManager } from '../locks/pasta-lock-manager.js'

private pastaLocks!: PastaLockManager
private reapInterval: NodeJS.Timeout | null = null

// In the boot method:
this.pastaLocks = new PastaLockManager(db)
this.pastaLocks.initialize()
const reaped = this.pastaLocks.releaseExpired()
if (reaped > 0) this.logger.warn('reaped expired pasta locks on boot', { count: reaped })
this.reapInterval = setInterval(() => {
  try { this.pastaLocks.releaseExpired() } catch (e) { this.logger.warn('lock reap failed', { error: String(e) }) }
}, 5 * 60_000)
this.reapInterval.unref()

// In dispose() / shutdown:
if (this.reapInterval) clearInterval(this.reapInterval)
```

- [ ] **Step 4: Run plugin tests** — `npx vitest run src/plugins/adb-precheck-plugin.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/
git commit -m "feat(precheck): wire PastaLockManager into plugin boot"
```

---

## Phase B — UI State Classifier extraction

Refactor only — behavior unchanged at the end of this phase.

### Task B1: Classifier scaffold + types + helpers

**Files:**
- Create: `packages/core/src/check-strategies/ui-state-classifier.ts`
- Create: `packages/core/src/check-strategies/ui-state-classifier.test.ts`

- [ ] **Step 1: Write failing test (smoke)**

```typescript
import { describe, it, expect } from 'vitest'
import { classifyUiState } from './ui-state-classifier.js'

describe('classifyUiState — smoke', () => {
  it('returns unknown for empty XML', () => {
    const r = classifyUiState({ xml: '' })
    expect(r.state).toBe('unknown')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(true)
  })
})
```

- [ ] **Step 2: Run; expect FAIL — module not found**

- [ ] **Step 3: Implement scaffold**

```typescript
// packages/core/src/check-strategies/ui-state-classifier.ts

export type UiState =
  | 'chat_open' | 'invite_modal' | 'searching' | 'chat_list'
  | 'contact_picker' | 'disappearing_msg_dialog' | 'unknown_dialog' | 'unknown'

export interface ClassifierInput { xml: string; topActivity?: string | null }

export interface ClassifierResult {
  state: UiState
  decisive: boolean
  retryable: boolean
  evidence: {
    matched_rule: string
    dump_length: number
    matched_text?: string
    has_modal_buttons: boolean
    has_message_box: boolean
  }
}

const DECISIVE: ReadonlySet<UiState> = new Set(['chat_open', 'invite_modal'])
const RETRYABLE: ReadonlySet<UiState> = new Set([
  'chat_list', 'contact_picker', 'disappearing_msg_dialog', 'unknown_dialog', 'unknown',
])

function build(state: UiState, matchedRule: string, xml: string, opts: { matchedText?: string } = {}): ClassifierResult {
  return {
    state,
    decisive: DECISIVE.has(state),
    retryable: RETRYABLE.has(state),
    evidence: {
      matched_rule: matchedRule,
      dump_length: xml.length,
      matched_text: opts.matchedText,
      has_modal_buttons: /android:id\/button[12]/.test(xml),
      has_message_box: /android:id\/message/.test(xml),
    },
  }
}

export function classifyUiState(input: ClassifierInput): ClassifierResult {
  return build('unknown', 'fallback_no_rule_matched', input.xml)
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/ui-state-classifier*
git commit -m "feat(probe): scaffold ui-state-classifier"
```

---

### Task B2: Capture XML fixtures from production

**Files:**
- Create: `packages/core/test/fixtures/ui-states/*.xml` (9 files)

- [ ] **Step 1: Capture pt-BR invite-modal fixture (already on device)**

The XML residual on the test device captures the exact pt-BR layout:

```bash
ssh root@100.77.249.93 "adb -s 9b01005930533036340030832250ac shell 'cat /sdcard/dispatch-probe.xml'" \
  > packages/core/test/fixtures/ui-states/invite_modal_pt_br.xml
grep -c 'não está no WhatsApp' packages/core/test/fixtures/ui-states/invite_modal_pt_br.xml
```
Expected: `1` (the message line is present).

- [ ] **Step 2: Capture chat_open fixture (test number 5543991938235)**

```bash
ssh root@100.77.249.93 "adb -s 9b01005930533036340030832250ac shell '
  am start --user 0 -a android.intent.action.VIEW -d \"https://wa.me/5543991938235\" -p com.whatsapp
  sleep 4
  uiautomator dump /sdcard/dispatch-probe.xml
  cat /sdcard/dispatch-probe.xml
'" > packages/core/test/fixtures/ui-states/chat_open_input.xml
```

Verify the file contains `com.whatsapp:id/(entry|conversation_entry|text_entry)`.

- [ ] **Step 3: Capture chat_list fixture**

```bash
ssh root@100.77.249.93 "adb -s 9b01005930533036340030832250ac shell '
  am force-stop com.whatsapp
  monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1
  sleep 4
  uiautomator dump /sdcard/dispatch-probe.xml
  cat /sdcard/dispatch-probe.xml
'" > packages/core/test/fixtures/ui-states/chat_list_full.xml
```

Verify `grep -c 'conversations_row' packages/core/test/fixtures/ui-states/chat_list_full.xml` ≥ 3.

- [ ] **Step 4: Capture contact_picker fixture**

```bash
ssh root@100.77.249.93 "adb -s 9b01005930533036340030832250ac shell '
  am start -n com.whatsapp/.contact.ui.picker.ContactPicker
  sleep 3
  uiautomator dump /sdcard/dispatch-probe.xml
  cat /sdcard/dispatch-probe.xml
'" > packages/core/test/fixtures/ui-states/contact_picker.xml
```

- [ ] **Step 5: Synthesize remaining fixtures (write files manually)**

These five fixtures are minimal but cover the rule logic; commit each as a `.xml` file. Names and exact content follow:

`invite_modal_en.xml`:
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.whatsapp">
    <node text="The phone number +55 41 ... is not on WhatsApp." resource-id="android:id/message" class="android.widget.TextView" package="com.whatsapp" />
    <node text="Invite to WhatsApp" resource-id="android:id/button1" class="android.widget.Button" package="com.whatsapp" />
    <node text="Cancel" resource-id="android:id/button2" class="android.widget.Button" package="com.whatsapp" />
  </node>
</hierarchy>
```

`searching_spinner.xml`:
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.whatsapp">
    <node text="Pesquisando..." resource-id="com.whatsapp:id/progress_bar" class="android.widget.ProgressBar" package="com.whatsapp" />
  </node>
</hierarchy>
```

`disappearing_msg_dialog.xml`:
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.whatsapp">
    <node text="Mensagens temporárias estão ativas neste chat." resource-id="android:id/message" class="android.widget.TextView" package="com.whatsapp" />
    <node text="OK" resource-id="android:id/button1" class="android.widget.Button" package="com.whatsapp" />
    <node text="Configurações" resource-id="android:id/button2" class="android.widget.Button" package="com.whatsapp" />
  </node>
</hierarchy>
```

`unknown_dialog_generic.xml`:
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" package="com.whatsapp">
    <node text="Aviso de privacidade atualizado." resource-id="android:id/message" class="android.widget.TextView" package="com.whatsapp" />
    <node text="Aceitar" resource-id="android:id/button1" class="android.widget.Button" package="com.whatsapp" />
  </node>
</hierarchy>
```

`unknown_blank.xml`:
```xml
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="com.android.systemui" /></hierarchy>
```

- [ ] **Step 6: Commit fixtures**

```bash
git add packages/core/test/fixtures/ui-states/
git commit -m "test(probe): add ui-state classifier fixtures"
```

---

### Task B3: Classify `chat_open` and `searching`

- [ ] **Step 1: Write failing tests**

```typescript
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const FIX = (name: string) => readFileSync(join(__dirname, '../../test/fixtures/ui-states', name), 'utf8')

describe('classifyUiState — chat_open', () => {
  it('input field via resource-id', () => {
    const r = classifyUiState({ xml: FIX('chat_open_input.xml') })
    expect(r.state).toBe('chat_open')
    expect(r.decisive).toBe(true)
    expect(r.retryable).toBe(false)
  })
  it('input field via EditText fallback', () => {
    const xml = `<hierarchy><node class="android.widget.EditText" package="com.whatsapp" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('chat_open')
  })
})

describe('classifyUiState — searching', () => {
  it('progress_bar id', () => {
    const r = classifyUiState({ xml: FIX('searching_spinner.xml') })
    expect(r.state).toBe('searching')
    expect(r.decisive).toBe(false)
    expect(r.retryable).toBe(false)
  })
  it('Pesquisando text', () => {
    const xml = `<hierarchy><node text="Pesquisando..."/></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('searching')
  })
})
```

- [ ] **Step 2: Run; expect FAIL — all return 'unknown'**

- [ ] **Step 3: Implement rules 1 and 3**

Replace the body of `classifyUiState`:

```typescript
export function classifyUiState(input: ClassifierInput): ClassifierResult {
  const { xml } = input

  // Rule 1: chat_open
  if (
    /resource-id="com\.whatsapp:id\/(entry|conversation_entry|text_entry)"/.test(xml) ||
    (/class="android\.widget\.EditText"/.test(xml) && /com\.whatsapp/.test(xml))
  ) {
    return build('chat_open', 'whatsapp_input_field', xml)
  }

  // Rule 3: searching
  if (/Pesquisando|Searching|Procurando|Cargando|Loading/i.test(xml)) {
    return build('searching', 'searching_text', xml)
  }
  if (/resource-id="com\.whatsapp:id\/progress_bar"/.test(xml)) {
    return build('searching', 'whatsapp_progress_bar', xml)
  }

  return build('unknown', 'fallback_no_rule_matched', xml)
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): classify chat_open and searching states"
```

---

### Task B4: Classify `invite_modal` (pt-BR + EN + invite_cta)

- [ ] **Step 1: Write failing tests**

```typescript
describe('classifyUiState — invite_modal', () => {
  it('pt-BR — "não está no WhatsApp"', () => {
    const r = classifyUiState({ xml: FIX('invite_modal_pt_br.xml') })
    expect(r.state).toBe('invite_modal')
    expect(r.decisive).toBe(true)
    expect(r.evidence.matched_rule).toMatch(/not_on_whatsapp_pt|invite_button_pt/)
  })
  it('EN — "not on WhatsApp"', () => {
    expect(classifyUiState({ xml: FIX('invite_modal_en.xml') }).state).toBe('invite_modal')
  })
  it('legacy invite_cta resource-id', () => {
    const xml = `<hierarchy><node resource-id="com.whatsapp:id/invite_cta" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('invite_modal')
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Insert rule 2 between rule 1 (chat_open) and rule 3 (searching)**

```typescript
// Rule 2: invite_modal
if (/resource-id="com\.whatsapp:id\/invite_cta"/.test(xml)) {
  return build('invite_modal', 'whatsapp_invite_cta_id', xml)
}
const notOnWaPt = /text="[^"]*não está no WhatsApp[^"]*"/i.exec(xml)
if (notOnWaPt) {
  return build('invite_modal', 'not_on_whatsapp_pt', xml, { matchedText: notOnWaPt[0].slice(0, 200) })
}
const notOnWaEn = /text="[^"]*not on WhatsApp[^"]*"/i.exec(xml)
if (notOnWaEn) {
  return build('invite_modal', 'not_on_whatsapp_en', xml, { matchedText: notOnWaEn[0].slice(0, 200) })
}
const notOnWaEs = /text="[^"]*no está en WhatsApp[^"]*"/i.exec(xml)
if (notOnWaEs) {
  return build('invite_modal', 'not_on_whatsapp_es', xml, { matchedText: notOnWaEs[0].slice(0, 200) })
}
const inviteBtn = /text="(Convidar para o WhatsApp|Invite to WhatsApp|Invitar a WhatsApp)"/i.exec(xml)
if (inviteBtn) {
  return build('invite_modal', 'invite_button_localized', xml, { matchedText: inviteBtn[0] })
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): classify invite_modal incl. pt-BR variant"
```

---

### Task B5: Classify `disappearing_msg_dialog`, `contact_picker`, `chat_list`

- [ ] **Step 1: Write failing tests**

```typescript
describe('classifyUiState — wrong screens', () => {
  it('disappearing_msg_dialog', () => {
    const r = classifyUiState({ xml: FIX('disappearing_msg_dialog.xml') })
    expect(r.state).toBe('disappearing_msg_dialog')
    expect(r.retryable).toBe(true)
  })
  it('contact_picker via topActivity', () => {
    const r = classifyUiState({ xml: '<hierarchy/>', topActivity: 'com.whatsapp/.contact.ui.picker.ContactPicker' })
    expect(r.state).toBe('contact_picker')
  })
  it('contact_picker via xml hint', () => {
    const xml = `<hierarchy><node resource-id="com.whatsapp:id/contact_row" /><node resource-id="com.whatsapp:id/contact_row" /></hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('contact_picker')
  })
  it('chat_list via multiple conversations_row', () => {
    const r = classifyUiState({ xml: FIX('chat_list_full.xml') })
    expect(r.state).toBe('chat_list')
    expect(r.retryable).toBe(true)
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement rules 4–6 (after the searching rules)**

```typescript
// Rule 4: disappearing_msg_dialog
if (
  /text="[^"]*(Mensagens temporárias|Disappearing messages|Mensajes temporales)[^"]*"/i.test(xml) &&
  /android:id\/button[12]/.test(xml)
) {
  return build('disappearing_msg_dialog', 'disappearing_messages_modal', xml)
}

// Rule 5: contact_picker
if (input.topActivity === 'com.whatsapp/.contact.ui.picker.ContactPicker') {
  return build('contact_picker', 'top_activity_contact_picker', xml)
}
const contactRowMatches = xml.match(/resource-id="com\.whatsapp:id\/(contact_row|picker_search)"/g) ?? []
if (contactRowMatches.length >= 2) {
  return build('contact_picker', 'contact_row_repeated', xml)
}

// Rule 6: chat_list
const conversationRows = xml.match(/resource-id="com\.whatsapp:id\/conversations_row(_[^"]+)?"/g) ?? []
if (conversationRows.length >= 3) {
  return build('chat_list', 'conversations_row_repeated', xml)
}
const hasChatsTab = /text="(Chats|Conversas)"/i.test(xml)
const hasStatusTab = /text="(Status|Atualizações)"/i.test(xml)
const hasCallsTab = /text="(Calls|Chamadas|Ligações)"/i.test(xml)
const inTabsContext = /resource-id="[^"]*(tabs?_|bottom_)[^"]*"/i.test(xml)
if (hasChatsTab && hasStatusTab && hasCallsTab && inTabsContext) {
  return build('chat_list', 'bottom_nav_tabs', xml)
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): classify disappearing/contact_picker/chat_list states"
```

---

### Task B6: Classify `unknown_dialog` and finalize fallback

- [ ] **Step 1: Write failing tests**

```typescript
describe('classifyUiState — unknown branches', () => {
  it('unknown_dialog when modal markers but no known text', () => {
    const r = classifyUiState({ xml: FIX('unknown_dialog_generic.xml') })
    expect(r.state).toBe('unknown_dialog')
    expect(r.evidence.has_message_box).toBe(true)
  })
  it('unknown when nothing matches', () => {
    const r = classifyUiState({ xml: FIX('unknown_blank.xml') })
    expect(r.state).toBe('unknown')
    expect(r.retryable).toBe(true)
  })
})
```

- [ ] **Step 2: Run; expect FAIL — both currently return 'unknown'**

- [ ] **Step 3: Insert rule 7 before the fallback**

```typescript
// Rule 7: unknown_dialog
if (/android:id\/message/.test(xml) || /android:id\/button[12]/.test(xml)) {
  return build('unknown_dialog', 'generic_modal_markers', xml)
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): classify unknown_dialog + finalize fallback"
```

---

### Task B7: Priority-order regression tests

- [ ] **Step 1: Add tests** (priority is enforced by rule order — these tests pin it):

```typescript
describe('classifyUiState — priority order', () => {
  it('chat_open beats chat_list when both signals present', () => {
    const xml = `<hierarchy>
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="com.whatsapp:id/entry" />
    </hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('chat_open')
  })

  it('invite_modal beats unknown_dialog', () => {
    const xml = `<hierarchy>
      <node resource-id="android:id/message" text="Number not on WhatsApp" />
      <node resource-id="android:id/button1" text="Invite to WhatsApp" />
    </hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('invite_modal')
  })

  it('disappearing_msg_dialog beats chat_list', () => {
    const xml = `<hierarchy>
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="com.whatsapp:id/conversations_row" />
      <node resource-id="android:id/message" text="Disappearing messages are on" />
      <node resource-id="android:id/button1" />
    </hierarchy>`
    expect(classifyUiState({ xml }).state).toBe('disappearing_msg_dialog')
  })
})
```

- [ ] **Step 2: Run; expect PASS**

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "test(probe): pin classifier priority order"
```

---

### Task B8: Refactor `adb-probe-strategy.ts` to use the classifier

**Files:**
- Modify: `packages/core/src/check-strategies/adb-probe-strategy.ts`

- [ ] **Step 1: Run existing probe tests as baseline**

```bash
cd packages/core && npx vitest run src/check-strategies/adb-probe-strategy.test.ts
```

- [ ] **Step 2: Replace the inline regex block (~lines 138-179) with classifier delegation**

Import the classifier and replace the polling loop so each iteration calls `classifyUiState({ xml, topActivity })`. On `chat_open` return `result: 'exists'`; on `invite_modal` return `not_exists`; on `searching` continue polling; on any other state break out and return `inconclusive` with `evidence.ui_state` preserved (recovery is added in Phase C). On deadline expiry return `inconclusive` with `evidence.timed_out: true`. Keep the existing latency / variant / device_serial fields intact.

The new evidence shape merges the classifier's `evidence` (`matched_rule`, `dump_length`, `has_modal_buttons`, `has_message_box`) plus the existing scanner fields (`polls`, `saw_searching`, `ui_state`, `timed_out` when applicable).

- [ ] **Step 3: Run probe tests; expect PASS**

If tests fail because they assert on `evidence.has_input_field` / `evidence.has_invite_cta` directly, update the assertions to use `evidence.ui_state` and `evidence.matched_rule`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "refactor(probe): delegate UI classification to classifier module"
```

---

## Phase C — Level 1 retry + snapshot persistence

### Task C1: `ProbeSnapshotWriter` with quotas

**Files:**
- Create: `packages/core/src/snapshots/probe-snapshot-writer.ts`
- Create: `packages/core/src/snapshots/probe-snapshot-writer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProbeSnapshotWriter } from './probe-snapshot-writer.js'

describe('ProbeSnapshotWriter', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snap-')) })

  it('writes file with expected naming', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 100, perMinuteCap: 100 })
    const path = w.write({ xml: '<x/>', state: 'unknown', phone: '5511999999999', timestamp: new Date('2026-05-06T10:30:45Z') })
    expect(path).toMatch(/2026-05-06\/103045_9999_unknown_4\.xml$/)
    expect(readdirSync(join(dir, '2026-05-06')).length).toBe(1)
  })

  it('respects daily quota', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 2, perMinuteCap: 100 })
    expect(w.write({ xml: '<x/>', state: 'unknown', phone: '1', timestamp: new Date('2026-05-06T10:00:00Z') })).not.toBeNull()
    expect(w.write({ xml: '<y/>', state: 'unknown', phone: '2', timestamp: new Date('2026-05-06T10:00:01Z') })).not.toBeNull()
    expect(w.write({ xml: '<z/>', state: 'unknown', phone: '3', timestamp: new Date('2026-05-06T10:00:02Z') })).toBeNull()
  })

  it('respects per-minute cap independently', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 1000, perMinuteCap: 1 })
    expect(w.write({ xml: '<x/>', state: 'unknown', phone: '1', timestamp: new Date('2026-05-06T10:00:00Z') })).not.toBeNull()
    expect(w.write({ xml: '<y/>', state: 'unknown', phone: '2', timestamp: new Date('2026-05-06T10:00:30Z') })).toBeNull()
    expect(w.write({ xml: '<z/>', state: 'unknown', phone: '3', timestamp: new Date('2026-05-06T10:01:01Z') })).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// packages/core/src/snapshots/probe-snapshot-writer.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SnapshotInput { xml: string; state: string; phone: string; timestamp?: Date }
export interface SnapshotWriterOpts { baseDir: string; dailyQuota: number; perMinuteCap: number }

export class ProbeSnapshotWriter {
  private readonly dailyCounts = new Map<string, number>()
  private readonly minuteCounts = new Map<string, number>()
  constructor(private readonly opts: SnapshotWriterOpts) {}

  write(input: SnapshotInput): string | null {
    const ts = input.timestamp ?? new Date()
    const day = ts.toISOString().slice(0, 10)
    const minute = ts.toISOString().slice(0, 16)
    const dailySoFar = this.dailyCounts.get(day) ?? 0
    if (dailySoFar >= this.opts.dailyQuota) return null
    const minuteSoFar = this.minuteCounts.get(minute) ?? 0
    if (minuteSoFar >= this.opts.perMinuteCap) return null

    const dir = join(this.opts.baseDir, day)
    mkdirSync(dir, { recursive: true })
    const hhmmss = ts.toISOString().slice(11, 19).replace(/:/g, '')
    const last4 = input.phone.slice(-4).padStart(4, '0')
    const file = `${hhmmss}_${last4}_${input.state}_${input.xml.length}.xml`
    const fullPath = join(dir, file)
    writeFileSync(fullPath, input.xml, 'utf8')

    this.dailyCounts.set(day, dailySoFar + 1)
    this.minuteCounts.set(minute, minuteSoFar + 1)
    return fullPath
  }
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/snapshots/
git commit -m "feat(snapshots): quota-bounded probe snapshot writer"
```

---

### Task C2: `recover()` helper inside probe strategy

**Files:**
- Modify: `packages/core/src/check-strategies/adb-probe-strategy.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('AdbProbeStrategy.recover', () => {
  it('force-stops on chat_list/contact_picker/unknown', async () => {
    const shells: string[] = []
    const adb = { shell: async (_s: string, cmd: string) => { shells.push(cmd); return '' } } as any
    const strat = new AdbProbeStrategy({ adb /* …other deps… */ } as any)
    await (strat as any).recover('chat_list', 'serial1')
    expect(shells.some((c) => c.includes('am force-stop com.whatsapp'))).toBe(true)
  })

  it('sends BACK keyevent on disappearing/unknown_dialog', async () => {
    const shells: string[] = []
    const adb = { shell: async (_s: string, cmd: string) => { shells.push(cmd); return '' } } as any
    const strat = new AdbProbeStrategy({ adb } as any)
    await (strat as any).recover('unknown_dialog', 'serial1')
    expect(shells.filter((c) => c.includes('input keyevent 4')).length).toBe(2)
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement private `recover`**

```typescript
private async recover(state: UiState, deviceSerial: string): Promise<void> {
  if (state === 'disappearing_msg_dialog' || state === 'unknown_dialog') {
    await this.adb.shell(deviceSerial, 'input keyevent 4')
    await this.delay(250)
    await this.adb.shell(deviceSerial, 'input keyevent 4')
    await this.delay(500)
    return
  }
  await this.adb.shell(deviceSerial, 'am force-stop com.whatsapp')
  await this.delay(1500)
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): add recover() helper per UI state"
```

---

### Task C3: `probe()` retry wrapper + `probeOnce()` extraction

**Files:**
- Modify: `packages/core/src/check-strategies/adb-probe-strategy.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('AdbProbeStrategy.probe — retry loop', () => {
  it('retries once after recover when first attempt is retryable', async () => {
    let probeStarts = 0
    const stages: string[] = []
    const adb = {
      shell: async (_s: string, cmd: string) => {
        stages.push(cmd)
        if (cmd.startsWith('am start')) { probeStarts++; return '' }
        if (cmd.includes('uiautomator dump')) return ''
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return probeStarts === 1
            ? '<hierarchy><node resource-id="com.whatsapp:id/conversations_row"/><node resource-id="com.whatsapp:id/conversations_row"/><node resource-id="com.whatsapp:id/conversations_row"/></hierarchy>'
            : '<hierarchy><node resource-id="com.whatsapp:id/entry"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy({ adb, deadlineMs: 5000 } as any)
    const result = await strat.probe('5511', { deviceSerial: 'X' })
    expect(result.result).toBe('exists')
    expect(stages.some((c) => c.includes('am force-stop com.whatsapp'))).toBe(true)
  })

  it('returns inconclusive after 2 retryable results in a row', async () => {
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return '<hierarchy><node resource-id="com.whatsapp:id/conversations_row"/><node resource-id="com.whatsapp:id/conversations_row"/><node resource-id="com.whatsapp:id/conversations_row"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy({ adb, deadlineMs: 5000 } as any)
    const result = await strat.probe('5511', { deviceSerial: 'X' })
    expect(result.result).toBe('inconclusive')
  })
})
```

- [ ] **Step 2: Run; expect FAIL** (only one attempt today)

- [ ] **Step 3: Refactor `probe` into `probeOnce` + retry wrapper**

```typescript
async probe(variant: string, ctx: ProbeContext): Promise<StrategyResult> {
  const release = await this.acquireDeviceLock(ctx.deviceSerial)
  try {
    const r1 = await this.probeOnce(variant, ctx, 'probe_initial')
    if (r1.result !== 'inconclusive') return r1
    const uiState = (r1.evidence as Record<string, unknown> | undefined)?.ui_state as UiState | undefined
    if (!uiState || !this.isRetryableUiState(uiState)) return r1
    await this.recover(uiState, ctx.deviceSerial)
    return await this.probeOnce(variant, ctx, 'probe_recover')
  } finally { release() }
}

private isRetryableUiState(s: UiState): boolean {
  return s === 'chat_list' || s === 'contact_picker' || s === 'disappearing_msg_dialog'
    || s === 'unknown_dialog' || s === 'unknown'
}

private async probeOnce(variant: string, ctx: ProbeContext, attemptPhase: 'probe_initial' | 'probe_recover'): Promise<StrategyResult> {
  // Extract the body of the previous `probe` method into here, removing the
  // device-lock acquisition (now held by the wrapper). Inject `attempt_phase`
  // into the resulting `evidence` object so the validator forwards it.
}
```

The device-lock acquisition moves out of `probeOnce` so retries reuse the same lock.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/check-strategies/
git commit -m "feat(probe): add per-phone recover-and-retry (Level 1)"
```

---

### Task C4: Wire snapshot writer into probe

**Files:**
- Modify: `packages/core/src/check-strategies/adb-probe-strategy.ts`
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('AdbProbeStrategy — snapshot capture', () => {
  it('writes snapshot when classifier returns unknown', async () => {
    const calls: any[] = []
    const writer = { write: (input: any) => { calls.push(input); return '/tmp/x.xml' } } as any
    const adb = {
      shell: async (_s: string, cmd: string) => {
        if (cmd.includes('cat /sdcard/dispatch-probe.xml')) {
          return '<hierarchy><node class="android.widget.FrameLayout" package="com.android.systemui"/></hierarchy>'
        }
        return ''
      },
    } as any
    const strat = new AdbProbeStrategy({ adb, snapshotWriter: writer } as any)
    await strat.probe('5511', { deviceSerial: 'X' })
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0].state).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Inject writer + call inside `probeOnce`**

Add `snapshotWriter?: ProbeSnapshotWriter` to the deps interface. Inside `probeOnce`, when classifier returns `unknown` or `unknown_dialog`:

```typescript
if ((result.state === 'unknown' || result.state === 'unknown_dialog') && this.deps.snapshotWriter) {
  const snapshotPath = this.deps.snapshotWriter.write({ xml, state: result.state, phone: variant })
  if (snapshotPath) result.evidence.snapshot_path = snapshotPath
}
```

In `adb-precheck-plugin.ts`, instantiate the writer near the lock manager:

```typescript
import { ProbeSnapshotWriter } from '../snapshots/probe-snapshot-writer.js'
this.snapshotWriter = new ProbeSnapshotWriter({
  baseDir: join(this.dataDir, 'probe-snapshots'),
  dailyQuota: 500,
  perMinuteCap: 10,
})
// Pass into AdbProbeStrategy deps where it's constructed.
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/
git commit -m "feat(probe): persist snapshots for unknown UI states"
```

---

### Task C5: Forward `attempt_phase` from validator to `recordCheck`

**Files:**
- Modify: `packages/core/src/validator/contact-validator.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('passes attempt_phase from probe evidence into recordCheck', async () => {
  const recorded: any[] = []
  const registry = { record: (_phone: string, input: any) => { recorded.push(input) } } as any
  const adbStrategy = {
    probe: async () => ({
      source: 'adb_probe', result: 'inconclusive', confidence: null,
      evidence: { ui_state: 'unknown', attempt_phase: 'probe_recover' },
      latency_ms: 100, variant_tried: '5511',
    }),
  } as any
  const wahaStrategy = { available: () => false, probe: async () => ({ result: 'error' }) } as any
  const cacheStrategy = { probe: async () => ({ result: 'inconclusive' }) } as any
  const v = new ContactValidator(registry, adbStrategy, wahaStrategy, cacheStrategy)
  await v.validate('5511', { triggered_by: 'pre_check' })
  expect(recorded[0].attempt_phase).toBe('probe_recover')
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Update `recordCheck` body** in `contact-validator.ts:129-149` to read `attempt_phase` from `result.evidence` and forward it as a new field on the registry input. Also accept `opts.attempt_phase` (used by Level 2 / 3 retry) and use it when explicit, falling back to `evidence.attempt_phase`, then `'probe_initial'`.

```typescript
const phase = opts.attempt_phase
  ?? ((result.evidence as Record<string, unknown> | undefined)?.attempt_phase as
      'probe_initial' | 'probe_recover' | 'scan_retry' | 'sweep_retry' | undefined)
  ?? 'probe_initial'
this.registry.record(phoneNormalized, {
  // ...existing fields...
  attempt_phase: phase,
})
```

Add `attempt_phase?: 'probe_initial' | 'probe_recover' | 'scan_retry' | 'sweep_retry'` to `ValidateOptions`.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/validator/
git commit -m "feat(validator): forward attempt_phase to wa_contact_checks"
```

---

## Phase D — Note PUT + scanner end-of-scan retry

### Task D1: `findCurrentPastaNote` + `markOrphaned` in store

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('PipedriveActivityStore — findCurrentPastaNote', () => {
  it('returns most recent successful pasta_summary row', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()

    const id1 = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1', phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id1, { status: 'success', pipedrive_response_id: '999', http_status: 201, error_msg: null, attempts: 1 })

    const found = store.findCurrentPastaNote('P-1')
    expect(found).not.toBeNull()
    expect(found!.pipedrive_response_id).toBe('999')
    expect(found!.row_id).toBe(id1)
  })

  it('returns null when no successful row', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    expect(store.findCurrentPastaNote('P-1')).toBeNull()
  })

  it('skips orphaned rows', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    const store = new PipedriveActivityStore(db)
    store.initialize()
    const id = store.insertPending({
      scenario: 'pasta_summary', deal_id: 1, pasta: 'P-1', phone_normalized: null, job_id: 'j1',
      pipedrive_endpoint: '/notes', pipedrive_payload_json: '{}',
    })
    store.updateResult(id, { status: 'success', pipedrive_response_id: '999', http_status: 201, error_msg: null, attempts: 1 })
    store.markOrphaned(id, 'PUT 404')
    expect(store.findCurrentPastaNote('P-1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement helpers**

```typescript
findCurrentPastaNote(pasta: string): { row_id: string; pipedrive_response_id: string; created_at: string } | null {
  const row = this.db
    .prepare(`
      SELECT id AS row_id, pipedrive_response_id, created_at
      FROM pipedrive_activities
      WHERE scenario = 'pasta_summary' AND pasta = ?
        AND status = 'success' AND pipedrive_response_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `)
    .get(pasta) as { row_id: string; pipedrive_response_id: string; created_at: string } | undefined
  return row ?? null
}

markOrphaned(rowId: string, reason: string): void {
  this.db.prepare('UPDATE pipedrive_activities SET status = ?, error_msg = ? WHERE id = ?')
    .run('orphaned', reason, rowId)
}
```

Extend `insertPending` to accept optional `revises_row_id` and `http_verb` (defaults `'POST'`); append both columns to the INSERT signature.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): findCurrentPastaNote + markOrphaned helpers"
```

---

### Task D2: PUT branch + 404 detection in `pipedrive-client.ts`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-client.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { vi } from 'vitest'

describe('PipedriveClient.dispatch — PUT', () => {
  it('uses PUT when intent.update_target_id is set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ data: { id: 999 } }),
    } as any))
    const client = new PipedriveClient({ apiToken: 'X', baseUrl: 'https://api.pipedrive.com', fetch: fetchMock as any })
    const r = await client.dispatch({
      kind: 'note', dedup_key: 'k1', payload: { content: 'hi' }, update_target_id: '999',
    })
    expect(r.ok).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/notes/999')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
  })

  it('returns 404 result for PUT on deleted note (no retry)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'not found' }) } as any))
    const client = new PipedriveClient({ apiToken: 'X', baseUrl: 'https://api.pipedrive.com', fetch: fetchMock as any })
    const r = await client.dispatch({ kind: 'note', dedup_key: 'k1', payload: {}, update_target_id: '999' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement PUT branch**

In the existing `dispatch` method:

```typescript
const isUpdate = Boolean(intent.update_target_id)
const url = isUpdate
  ? `${this.baseUrl}/v1/notes/${intent.update_target_id}?api_token=${this.apiToken}`
  : `${this.baseUrl}/v1/notes?api_token=${this.apiToken}`
const method = isUpdate ? 'PUT' : 'POST'
```

In the retry loop, treat 404 on PUT as a terminal failure:

```typescript
if (res.status === 404 && isUpdate) {
  return { ok: false, status: 404, attempts: attempt, error: 'note not found upstream' }
}
```

Add `update_target_id?: string` to `PipedriveOutgoingIntent` type definition.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): PUT branch + 404 detection in pipedrive client"
```

---

### Task D3: Publisher upsert + lock + 404 fallback

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-publisher.ts`

- [ ] **Step 1: Write failing tests** (use small in-memory test doubles for store and lock manager that match the real interfaces)

```typescript
describe('PipedrivePublisher — upsert', () => {
  it('first call POST creates note', async () => {
    const dispatchSpy = vi.fn(async () => ({ ok: true, status: 201, attempts: 1, responseId: '999' }))
    /* construct publisher with empty in-memory store, locks */
    /* enqueuePastaSummary; flush */
    /* assert: dispatchSpy.mock.calls[0][0].update_target_id is undefined */
    /* assert: store.insertPending called with http_verb='POST' */
  })

  it('second call PUT updates same note', async () => {
    /* seed store with one successful POST row for pasta=P-1 (pipedrive_response_id='999') */
    /* enqueue again; flush */
    /* assert: dispatchSpy called with update_target_id === '999' */
    /* assert: insertPending called with http_verb='PUT' AND revises_row_id pointing at the seeded row */
  })

  it('PUT 404 falls back to POST and orphans the previous row', async () => {
    let calls = 0
    const dispatchSpy = vi.fn(async () => {
      calls++
      if (calls === 1) return { ok: false, status: 404, attempts: 1, error: 'gone' }
      return { ok: true, status: 201, attempts: 1, responseId: 'NEW' }
    })
    /* seed store with one successful row */
    /* enqueue; flush */
    /* assert: store.markOrphaned called with the seeded row id */
    /* assert: second dispatch has update_target_id undefined and ok */
  })

  it('lock acquire failure requeues and warns', async () => {
    const locks = { acquireWithWait: async () => null } as any
    const warnSpy = vi.fn()
    /* enqueue; flush */
    /* assert: dispatchSpy NOT called and warnSpy called with pasta in payload */
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Pass `PastaLockManager` into `PipedrivePublisher` constructor (new optional 6th arg). Resolve target before building intent:**

```typescript
enqueuePastaSummary(intent: PipedrivePastaSummaryIntent, meta?: Partial<PublisherEnqueueMeta>): string | null {
  const builtIntent = buildPastaSummaryNote(intent, this.companyDomain)
  if (this.store && intent.pasta) {
    const target = this.store.findCurrentPastaNote(intent.pasta)
    if (target) builtIntent.update_target_id = target.pipedrive_response_id
  }
  return this.add(builtIntent, {
    scenario: 'pasta_summary',
    deal_id: intent.first_deal_id,
    pasta: intent.pasta,
    phone_normalized: null,
    job_id: intent.job_id,
    manual: meta?.manual,
    triggered_by: meta?.triggered_by,
  })
}
```

In `add()`, when `intent.update_target_id` is set, **bypass the dedup checks** and persist with `http_verb='PUT'` plus `revises_row_id` referring to the previous row:

```typescript
private add(intent: PipedriveOutgoingIntent, meta: PublisherEnqueueMeta): string | null {
  const isUpdate = Boolean(intent.update_target_id)
  if (!isUpdate) {
    // existing dedup logic (in-memory + store.hasRecentSuccess)
  }
  let rowId: string | null = null
  if (this.store) {
    rowId = this.store.insertPending({
      scenario: meta.scenario,
      deal_id: meta.deal_id,
      pasta: meta.pasta,
      phone_normalized: meta.phone_normalized,
      job_id: meta.job_id,
      pipedrive_endpoint: intent.kind === 'note' ? '/notes' : '/activities',
      pipedrive_payload_json: JSON.stringify(intent.payload),
      manual: meta.manual,
      triggered_by: meta.triggered_by,
      http_verb: isUpdate ? 'PUT' : 'POST',
      revises_row_id: isUpdate && meta.pasta ? this.findRowIdForTarget(intent.update_target_id!, meta.pasta) : undefined,
    })
  }
  this.queue.push({ intent, rowId, meta })
  this.kickDrain()
  return rowId
}

private findRowIdForTarget(pipedriveId: string, pasta: string): string | undefined {
  if (!this.store) return undefined
  const target = this.store.findCurrentPastaNote(pasta)
  return target?.pipedrive_response_id === pipedriveId ? target.row_id : undefined
}
```

In `drain()`, around the dispatch call, acquire `note.pasta_summary:<pasta>` for `pasta_summary` intents and handle the 404 fallback:

```typescript
private async drain(): Promise<void> {
  while (this.queue.length > 0) {
    const next = this.queue.shift()!
    let lockHandle: LockHandle | null = null
    if (this.locks && next.meta.scenario === 'pasta_summary' && next.meta.pasta) {
      lockHandle = await this.locks.acquireWithWait(
        `note.pasta_summary:${next.meta.pasta}`,
        60_000,
        { timeoutMs: 15_000, pollMs: 5_000, context: { job_id: next.meta.job_id, pasta: next.meta.pasta } },
      )
      if (!lockHandle) {
        this.logger.warn('pasta_summary lock unavailable, requeuing', { pasta: next.meta.pasta })
        this.queue.push(next)
        await new Promise((r) => setTimeout(r, 30_000))
        continue
      }
    }
    try {
      const r = await this.client.dispatch(next.intent)
      if (r.ok) {
        this.store?.updateResult(next.rowId!, {
          status: 'success', pipedrive_response_id: r.responseId ?? null,
          http_status: r.status, error_msg: null, attempts: r.attempts,
        })
      } else if (r.status === 404 && next.intent.update_target_id) {
        if (this.store && next.rowId) {
          this.store.updateResult(next.rowId, {
            status: 'failed', http_status: 404,
            error_msg: r.error ?? 'not found', attempts: r.attempts,
          })
          const orphanRowId = this.findRowIdForTarget(next.intent.update_target_id, next.meta.pasta!)
          if (orphanRowId) this.store.markOrphaned(orphanRowId, 'PUT returned 404')
        }
        this.logger.warn('pipedrive note deleted upstream, recreating', { pasta: next.meta.pasta })
        const fallback = { ...next.intent, update_target_id: undefined }
        this.queue.unshift({ intent: fallback, rowId: null, meta: next.meta })
        continue
      } else {
        this.store?.updateResult(next.rowId!, {
          status: 'failed', pipedrive_response_id: null,
          http_status: r.status, error_msg: r.error ?? null, attempts: r.attempts,
        })
      }
    } finally {
      lockHandle?.release()
    }
  }
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): pipedrive publisher upsert with PUT + 404 fallback"
```

---

### Task D4: Scanner end-of-scan retry pass

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/scanner.ts`
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts`
- Modify: `packages/core/src/validator/contact-validator.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('Scanner — end-of-scan retry pass', () => {
  it('re-validates only error phones on second pass', async () => {
    const calls: Array<{ phone: string; phase?: string }> = []
    const validator = {
      validate: vi.fn(async (phone: string, opts: any) => {
        calls.push({ phone, phase: opts.attempt_phase })
        if (phone === 'FAIL') {
          return calls.filter((c) => c.phone === phone).length === 1
            ? { phone_input: phone, phone_normalized: phone, exists_on_wa: null, source: 'adb_probe', confidence: null, attempts: [], from_cache: false, wa_chat_id: null }
            : { phone_input: phone, phone_normalized: phone, exists_on_wa: 0, source: 'adb_probe', confidence: 0.95, attempts: [], from_cache: false, wa_chat_id: null }
        }
        return { phone_input: phone, phone_normalized: phone, exists_on_wa: 1, source: 'adb_probe', confidence: 0.95, attempts: [], from_cache: false, wa_chat_id: null }
      }),
    } as any
    /* construct scanner with a single-deal page containing 2 phones (one OK, one FAIL); run with default retry_errors */
    /* assert: validator called twice for FAIL (probe_initial in main loop is masked, scan_retry in retry pass) */
    /* assert: final stored deal has phones[FAIL].outcome === 'invalid' */
  })

  it('retry_errors=false disables the pass', async () => {
    /* same setup; pass retry_errors:false; assert: only 1 validate call for FAIL */
  })

  it('aborts retry pass when scan lock is invalidated', async () => {
    /* mock lock.isStillValid → false on second iteration; assert: thrown LockExpiredError */
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement retry pass + helpers**

In `PrecheckJobStore`, add:

```typescript
listDealsWithErrors(jobId: string): Array<{ key: DealKey; phones: PhoneResult[]; valid_count: number; invalid_count: number; primary_valid_phone: string | null }> {
  const rows = this.db
    .prepare(`
      SELECT pasta, deal_id, contato_tipo, contato_id, phones_json
      FROM adb_precheck_deals
      WHERE last_job_id = ? AND phones_json LIKE '%"outcome":"error"%'
    `)
    .all(jobId) as Array<{ pasta: string; deal_id: number; contato_tipo: string; contato_id: number; phones_json: string }>
  return rows.map((r) => {
    const phones: PhoneResult[] = JSON.parse(r.phones_json)
    return {
      key: { pasta: r.pasta, deal_id: r.deal_id, contato_tipo: r.contato_tipo, contato_id: r.contato_id },
      phones,
      valid_count: phones.filter((p) => p.outcome === 'valid').length,
      invalid_count: phones.filter((p) => p.outcome === 'invalid').length,
      primary_valid_phone: phones.find((p) => p.outcome === 'valid')?.normalized ?? null,
    }
  })
}
```

In `ContactValidator.validate(...)`, accept `attempt_phase?` in `ValidateOptions` and pass it through to `recordCheck` (Task C5 already wired part of this — ensure the explicit option overrides the evidence value).

In `scanner.ts:run()`, after the `outer:` loop and before `publishOrUpdateNotes`:

```typescript
const retryErrorsEnabled = params.retry_errors !== false
if (retryErrorsEnabled) {
  await this.retryErrorsPass(jobId, scanLockHandle, params)
}

private async retryErrorsPass(jobId: string, lock: LockHandle | null, params: PrecheckScanParams): Promise<void> {
  const errorDeals = this.store.listDealsWithErrors(jobId)
  if (errorDeals.length === 0) return
  this.logger.info('end-of-scan retry pass starting', {
    jobId, deals: errorDeals.length,
    error_phones: errorDeals.reduce((n, d) => n + d.phones.filter((p) => p.outcome === 'error').length, 0),
  })

  const probeDevice = params.device_serial ?? this.deps.deviceSerial
  const probeSender = params.waha_session ?? this.deps.wahaSession
  const probeProfile = probeDevice && probeSender && this.deps.resolveProfileForSender
    ? this.deps.resolveProfileForSender(probeDevice, probeSender) ?? undefined
    : undefined

  for (const deal of errorDeals) {
    if (lock && !lock.isStillValid()) {
      this.logger.warn('lost scan lock mid-retry, aborting', { jobId })
      throw new Error('LockExpiredError: scan.<pasta>')
    }
    let mutated = false
    for (const ph of deal.phones) {
      if (ph.outcome !== 'error') continue
      try {
        const r = await this.deps.validator.validate(ph.normalized, {
          triggered_by: 'pre_check', useWahaTiebreaker: true,
          device_serial: probeDevice, waha_session: probeSender, profile_id: probeProfile,
          attempt_phase: 'scan_retry',
        })
        if (r.exists_on_wa !== null) {
          ph.outcome = r.exists_on_wa === 1 ? 'valid' : 'invalid'
          ph.source = r.source; ph.confidence = r.confidence; ph.error = null
          mutated = true
        }
      } catch { /* keep error */ }
    }
    if (mutated) {
      const validCount = deal.phones.filter((p) => p.outcome === 'valid').length
      const invalidCount = deal.phones.filter((p) => p.outcome === 'invalid').length
      this.store.upsertDeal(jobId, {
        key: deal.key,
        phones: deal.phones,
        valid_count: validCount, invalid_count: invalidCount,
        primary_valid_phone: deal.phones.find((p) => p.outcome === 'valid')?.normalized ?? null,
      })
    }
  }
}
```

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/ packages/core/src/validator/
git commit -m "feat(precheck): end-of-scan retry pass (Level 2)"
```

---

### Task D5: Hold `scan.<pasta>` lock around scan + retry pass

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/scanner.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('Scanner — scan.<pasta> lock', () => {
  it('rejects when pasta already locked', async () => {
    const locks = new PastaLockManager(db); locks.initialize()
    locks.acquire('scan:P-1', 60_000)
    /* call scanner.run({ pasta_filter: 'P-1', ... }) */
    /* expect ScanInProgressError thrown OR job marked failed */
  })

  it('releases lock after run completes', async () => {
    /* run scanner; after completion, locks.describe('scan:P-1') === null */
  })
})
```

- [ ] **Step 2: Run; expect FAIL** (no lock today)

- [ ] **Step 3: Inject `PastaLockManager` into `PrecheckScanner` deps. Add a typed error class:**

```typescript
export class ScanInProgressError extends Error {
  constructor(public readonly pasta: string, public readonly current: LockState | null) {
    super(`scan_in_progress: ${pasta}`)
  }
}
```

In `run()`, wrap the body:

```typescript
const pasta = params.pasta_filter ?? 'all'
const lockKey = `scan:${pasta}`
const scanLockHandle = this.deps.locks.acquire(lockKey, 3600_000, { job_id: jobId, pasta })
if (!scanLockHandle) {
  const existing = this.deps.locks.describe(lockKey)
  this.store.finishJob(jobId, 'failed', JSON.stringify({ error: 'scan_in_progress', pasta, current: existing }))
  throw new ScanInProgressError(pasta, existing)
}
try {
  // existing body of run() up to publishOrUpdate
} finally {
  scanLockHandle.release()
}
```

Pass `scanLockHandle` into `retryErrorsPass(jobId, scanLockHandle, params)` so the fence-token guard can run.

- [ ] **Step 4: Run; expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/
git commit -m "feat(precheck): hold scan.<pasta> lock during scan + retry pass"
```

---

## Phase E — Sweep endpoint + observability

### Task E1: `runRetryErrorsJob` on scanner + REST endpoint

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/scanner.ts`
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts`
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('Scanner.runRetryErrorsJob', () => {
  it('lists error deals and processes only error phones', async () => {
    /* seed adb_precheck_deals with 3 deals (2 with error phones) and matching adb_precheck_jobs entries */
    /* mock validator → returns invalid for retried phones */
    /* call scanner.runRetryErrorsJob({ pasta: 'P-1', max_deals: 10 }) */
    /* assert: returned new job_id has triggered_by='retry-errors-sweep' */
    /* assert: validator called only with error phones (count matches) */
  })

  it('aborts when scan.<pasta> lock is held', async () => {
    /* prelock; expect ScanInProgressError */
  })
})

describe('POST /api/v1/plugins/adb-precheck/retry-errors', () => {
  it('returns 202 with job_id', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/adb-precheck/retry-errors',
      payload: { pasta: 'P-1' },
    })
    expect(reply.statusCode).toBe(202)
    expect(JSON.parse(reply.body).job_id).toBeTruthy()
  })

  it('returns 409 when pasta scan already running', async () => {
    /* prelock; assert 409 with current_job_id in payload */
  })
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Add filter helper to `PrecheckJobStore`**

```typescript
listDealsWithErrorsByFilter(opts: { since_iso: string; pasta: string | null; limit: number }): Array<{ key: DealKey; phones: PhoneResult[]; last_job_id: string }> {
  const rows = this.db
    .prepare(`
      SELECT pasta, deal_id, contato_tipo, contato_id, phones_json, last_job_id
      FROM adb_precheck_deals
      WHERE scanned_at >= ?
        AND phones_json LIKE '%"outcome":"error"%'
        AND (? IS NULL OR pasta = ?)
      ORDER BY scanned_at DESC
      LIMIT ?
    `)
    .all(opts.since_iso, opts.pasta, opts.pasta, opts.limit) as Array<{
      pasta: string; deal_id: number; contato_tipo: string; contato_id: number;
      phones_json: string; last_job_id: string;
    }>
  return rows.map((r) => ({
    key: { pasta: r.pasta, deal_id: r.deal_id, contato_tipo: r.contato_tipo, contato_id: r.contato_id },
    phones: JSON.parse(r.phones_json),
    last_job_id: r.last_job_id,
  }))
}
```

- [ ] **Step 4: Implement scanner method**

```typescript
async runRetryErrorsJob(params: {
  pasta?: string | null
  since_iso?: string
  max_deals?: number
  dry_run?: boolean
}): Promise<{ job_id: string; deals_planned: number; status: string }> {
  const since = params.since_iso ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString()
  const limit = params.max_deals ?? 200

  const errorDeals = this.store.listDealsWithErrorsByFilter({
    since_iso: since, pasta: params.pasta ?? null, limit,
  })
  const distinctParents = new Set(errorDeals.map((d) => d.last_job_id))
  const parentJobId = distinctParents.size === 1 ? [...distinctParents][0] : undefined

  const jobId = this.store.createJob({
    pasta_filter: params.pasta ?? null,
    retry_errors: true,
    triggered_by: 'retry-errors-sweep',
    parent_job_id: parentJobId,
  } as any)

  if (params.dry_run) {
    this.store.finishJob(jobId, 'cancelled', 'dry_run')
    return { job_id: jobId, deals_planned: errorDeals.length, status: 'dry_run' }
  }

  // Run async; the existing /scan/:id endpoint serves progress.
  setImmediate(() => this.processSweep(jobId, errorDeals).catch((e) => {
    this.logger.error('sweep job failed', { jobId, error: String(e) })
    this.store.finishJob(jobId, 'failed', String(e))
  }))
  return { job_id: jobId, deals_planned: errorDeals.length, status: 'started' }
}

private async processSweep(jobId: string, errorDeals: Array<{ key: DealKey; phones: PhoneResult[]; last_job_id: string }>): Promise<void> {
  this.store.markStarted(jobId, errorDeals.length)
  const pastasToPublish = new Set<string>()

  // Group deals by pasta so we can hold scan.<pasta> lock per group.
  const byPasta = new Map<string, typeof errorDeals>()
  for (const d of errorDeals) {
    const list = byPasta.get(d.key.pasta) ?? []
    list.push(d); byPasta.set(d.key.pasta, list)
  }

  for (const [pasta, deals] of byPasta.entries()) {
    const lockKey = `scan:${pasta}`
    const lock = this.deps.locks.acquire(lockKey, 3600_000, { job_id: jobId, pasta })
    if (!lock) {
      this.logger.warn('sweep skipping pasta — scan in progress', { pasta })
      continue
    }
    try {
      for (const deal of deals) {
        if (!lock.isStillValid()) break
        let mutated = false
        for (const ph of deal.phones) {
          if (ph.outcome !== 'error') continue
          const r = await this.deps.validator.validate(ph.normalized, {
            triggered_by: 'pre_check', useWahaTiebreaker: true,
            attempt_phase: 'sweep_retry',
          })
          if (r.exists_on_wa !== null) {
            ph.outcome = r.exists_on_wa === 1 ? 'valid' : 'invalid'
            ph.source = r.source; ph.confidence = r.confidence; ph.error = null
            mutated = true
          }
        }
        if (mutated) {
          const validCount = deal.phones.filter((p) => p.outcome === 'valid').length
          const invalidCount = deal.phones.filter((p) => p.outcome === 'invalid').length
          this.store.upsertDeal(jobId, {
            key: deal.key,
            phones: deal.phones,
            valid_count: validCount, invalid_count: invalidCount,
            primary_valid_phone: deal.phones.find((p) => p.outcome === 'valid')?.normalized ?? null,
          })
          pastasToPublish.add(pasta)
        }
        this.store.markProgress(jobId, { scanned_deals: 1 })
      }
    } finally {
      lock.release()
    }
  }

  // Publish updated notes for touched pastas.
  for (const pasta of pastasToPublish) {
    await this.publishOrUpdatePastaNote(pasta, jobId)
  }
  this.store.finishJob(jobId, 'succeeded')
}
```

(`publishOrUpdatePastaNote(pasta, jobId)` is the existing publishing helper inside `Scanner` — extract it from the current `run()` body if it isn't already a method, so it can be reused by sweep.)

- [ ] **Step 5: Implement route in `adb-precheck-plugin.ts`**

In the route registration block (~line 351):

```typescript
ctx.registerRoute('POST', '/retry-errors', this.handleRetryErrors.bind(this))

private async handleRetryErrors(req: any, reply: any) {
  const body = req.body ?? {}
  try {
    const result = await this.scanner.runRetryErrorsJob({
      pasta: body.pasta ?? null,
      since_iso: body.since_iso,
      max_deals: body.max_deals,
      dry_run: body.dry_run,
    })
    reply.code(202).send(result)
  } catch (e: any) {
    if (e?.constructor?.name === 'ScanInProgressError') {
      reply.code(409).send({ error: 'scan_in_progress', pasta: e.pasta, current: e.current })
      return
    }
    throw e
  }
}
```

- [ ] **Step 6: Run; expect PASS**

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/ packages/core/src/plugins/adb-precheck-plugin.ts
git commit -m "feat(precheck): manual sweep endpoint (Level 3)"
```

---

### Task E2: `GET /jobs/:id` retry stats + UI distribution

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('GET /scan/:id returns retry_stats + ui_state_distribution + snapshots_captured', async () => {
  /* seed adb_precheck_jobs with one row, plus wa_contact_checks with 2 probe_initial,
     1 probe_recover, 1 scan_retry, both with json evidence containing ui_state */
  const reply = await app.inject({ method: 'GET', url: `/api/v1/plugins/adb-precheck/scan/${jobId}` })
  const body = JSON.parse(reply.body)
  expect(body.retry_stats).toEqual(expect.objectContaining({
    level_1_resolves: expect.any(Number),
    level_2_resolves: expect.any(Number),
    remaining_errors: expect.any(Number),
  }))
  expect(body.ui_state_distribution).toBeDefined()
  expect(body.snapshots_captured).toEqual(expect.any(Number))
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Add stats helpers to `PrecheckJobStore`**

```typescript
getRetryStats(jobId: string): { level_1_resolves: number; level_2_resolves: number; remaining_errors: number } {
  const dealsRows = this.db
    .prepare('SELECT phones_json FROM adb_precheck_deals WHERE last_job_id = ?')
    .all(jobId) as Array<{ phones_json: string }>
  let remaining_errors = 0
  for (const r of dealsRows) {
    const phones: PhoneResult[] = JSON.parse(r.phones_json)
    remaining_errors += phones.filter((p) => p.outcome === 'error').length
  }
  // Approximate Level 1 / Level 2 saves via wa_contact_checks attempt_phase counts
  // for the deals belonging to this job.
  const dealKeys = this.db
    .prepare('SELECT pasta, deal_id, contato_tipo, contato_id FROM adb_precheck_deals WHERE last_job_id = ?')
    .all(jobId) as Array<{ pasta: string; deal_id: number; contato_tipo: string; contato_id: number }>
  // For simplicity, count probe_recover / scan_retry rows associated with this job's scanned phones:
  const level_1_resolves = (this.db
    .prepare(`
      SELECT COUNT(*) AS n FROM wa_contact_checks
      WHERE attempt_phase = 'probe_recover' AND result IN ('exists','not_exists')
        AND checked_at >= (SELECT created_at FROM adb_precheck_jobs WHERE id = ?)
    `)
    .get(jobId) as { n: number }).n
  const level_2_resolves = (this.db
    .prepare(`
      SELECT COUNT(*) AS n FROM wa_contact_checks
      WHERE attempt_phase = 'scan_retry' AND result IN ('exists','not_exists')
        AND checked_at >= (SELECT created_at FROM adb_precheck_jobs WHERE id = ?)
    `)
    .get(jobId) as { n: number }).n
  return { level_1_resolves, level_2_resolves, remaining_errors }
}

getUiStateDistribution(jobId: string): Record<string, number> {
  const rows = this.db
    .prepare(`
      SELECT json_extract(evidence, '$.ui_state') AS state, COUNT(*) AS n
      FROM wa_contact_checks
      WHERE checked_at >= (SELECT created_at FROM adb_precheck_jobs WHERE id = ?)
        AND source = 'adb_probe'
        AND json_extract(evidence, '$.ui_state') IS NOT NULL
      GROUP BY state
    `)
    .all(jobId) as Array<{ state: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.state] = r.n
  return out
}

getSnapshotsCaptured(jobId: string): number {
  return (this.db
    .prepare(`
      SELECT COUNT(*) AS n FROM wa_contact_checks
      WHERE checked_at >= (SELECT created_at FROM adb_precheck_jobs WHERE id = ?)
        AND json_extract(evidence, '$.snapshot_path') IS NOT NULL
    `)
    .get(jobId) as { n: number }).n
}
```

- [ ] **Step 4: Extend the existing `handleGetJob` (the `/scan/:id` handler) to attach those fields to the response**

```typescript
const stats = this.store.getRetryStats(jobId)
const ui = this.store.getUiStateDistribution(jobId)
const snaps = this.store.getSnapshotsCaptured(jobId)
reply.send({ ...existingResponseBody, retry_stats: stats, ui_state_distribution: ui, snapshots_captured: snaps })
```

- [ ] **Step 5: Run; expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/
git commit -m "feat(precheck): scan/:id includes retry_stats + ui_state_distribution"
```

---

### Task E3: `GET /notes/:pasta/history`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts`
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('returns revision history with verb chain', async () => {
  /* seed pipedrive_activities with one POST and one PUT row, the PUT having revises_row_id */
  const reply = await app.inject({ method: 'GET', url: '/api/v1/plugins/adb-precheck/notes/P-1/history' })
  const body = JSON.parse(reply.body)
  expect(body.pasta).toBe('P-1')
  expect(body.revisions.length).toBe(2)
  expect(body.revisions[0].verb).toBe('POST')
  expect(body.revisions[1].verb).toBe('PUT')
  expect(body.revisions[1].revises_row_id).toBe(body.revisions[0].row_id)
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement store helper**

```typescript
listPastaNoteRevisions(pasta: string): Array<{ row_id: string; verb: string; created_at: string; job_id: string | null; triggered_by: string | null; revises_row_id: string | null; status: string }> {
  return this.db
    .prepare(`
      SELECT pa.id AS row_id, pa.http_verb AS verb, pa.created_at, pa.job_id,
             aj.triggered_by, pa.revises_row_id, pa.status
      FROM pipedrive_activities pa
      LEFT JOIN adb_precheck_jobs aj ON aj.id = pa.job_id
      WHERE pa.scenario = 'pasta_summary' AND pa.pasta = ?
      ORDER BY pa.created_at ASC
    `)
    .all(pasta) as any[]
}
```

- [ ] **Step 4: Register route**

```typescript
ctx.registerRoute('GET', '/notes/:pasta/history', this.handleNoteHistory.bind(this))

private async handleNoteHistory(req: any, reply: any) {
  const pasta = req.params.pasta
  const revisions = this.pipedriveActivityStore!.listPastaNoteRevisions(pasta)
  const current = this.pipedriveActivityStore!.findCurrentPastaNote(pasta)
  reply.send({
    pasta,
    current_pipedrive_id: current?.pipedrive_response_id ?? null,
    revisions,
  })
}
```

- [ ] **Step 5: Run; expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/
git commit -m "feat(precheck): notes/:pasta/history endpoint"
```

---

### Task E4: `/admin/locks` and `/admin/probe-snapshots`

**Files:**
- Create: `packages/core/src/snapshots/list.ts`
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Write failing tests**

```typescript
it('GET /admin/locks lists active pasta locks', async () => {
  pastaLocks.acquire('scan:P-1', 60_000, { job_id: 'X' })
  const reply = await app.inject({ method: 'GET', url: '/api/v1/admin/locks' })
  const body = JSON.parse(reply.body)
  expect(body.locks.find((l: any) => l.key === 'scan:P-1')).toBeDefined()
})

it('GET /admin/probe-snapshots lists files', async () => {
  /* write a snapshot via writer */
  const reply = await app.inject({ method: 'GET', url: '/api/v1/admin/probe-snapshots?since=2026-05-06' })
  const body = JSON.parse(reply.body)
  expect(body.snapshots).toBeDefined()
})
```

- [ ] **Step 2: Run; expect FAIL**

- [ ] **Step 3: Implement `listSnapshotFiles`**

```typescript
// packages/core/src/snapshots/list.ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function listSnapshotFiles(baseDir: string, opts: { since?: string; state?: string } = {}): Array<{ path: string; day: string; state: string; phone_last4: string; size: number }> {
  let days: string[]
  try { days = readdirSync(baseDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) } catch { return [] }
  if (opts.since) days = days.filter((d) => d >= opts.since!)
  const out: Array<{ path: string; day: string; state: string; phone_last4: string; size: number }> = []
  for (const day of days) {
    const dayDir = join(baseDir, day)
    let files: string[]
    try { files = readdirSync(dayDir) } catch { continue }
    for (const f of files) {
      const m = /^\d{6}_(\d{4})_([a-z_]+)_\d+\.xml$/.exec(f)
      if (!m) continue
      if (opts.state && m[2] !== opts.state) continue
      const fullPath = join(dayDir, f)
      out.push({ path: fullPath, day, state: m[2], phone_last4: m[1], size: statSync(fullPath).size })
    }
  }
  return out.sort((a, b) => b.path.localeCompare(a.path))
}
```

- [ ] **Step 4: Register routes**

```typescript
ctx.registerRoute('GET', '/admin/locks', this.handleListLocks.bind(this))
ctx.registerRoute('GET', '/admin/probe-snapshots', this.handleListSnapshots.bind(this))

private async handleListLocks(_req: any, reply: any) {
  reply.send({ locks: this.pastaLocks.listAll() })
}

private async handleListSnapshots(req: any, reply: any) {
  const since = req.query?.since
  const state = req.query?.state
  const dir = join(this.dataDir, 'probe-snapshots')
  const snapshots = listSnapshotFiles(dir, { since, state })
  reply.send({ snapshots })
}
```

- [ ] **Step 5: Run; expect PASS**

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/
git commit -m "feat(admin): /admin/locks and /admin/probe-snapshots endpoints"
```

---

### Task E5: E2E driver script + runbook docs

**Files:**
- Create: `scripts/e2e-precheck-scale.sh`
- Create: `docs/operations/adb-precheck-runbook.md`
- Create: `docs/operations/adb-precheck-snapshot-calibration.md`

- [ ] **Step 1: Write `scripts/e2e-precheck-scale.sh`**

```bash
#!/bin/bash
# E2E driver: starts a precheck scan over up to N deals of a pasta, polls until
# completion, prints retry stats and the resulting note revision.
set -euo pipefail
PASTA="${1:-15516752-A}"
MAX="${2:-100}"
BASE="${BASE_URL:-http://127.0.0.1:7890}"

echo "Starting scan: pasta=$PASTA max_deals=$MAX"
JOB_ID=$(curl -fsS -X POST "$BASE/api/v1/plugins/adb-precheck/scan" \
  -H 'content-type: application/json' \
  -d "{\"pasta_filter\":\"$PASTA\",\"max_deals\":$MAX}" | jq -r .job_id)
echo "Job id: $JOB_ID"

while true; do
  STATUS=$(curl -fsS "$BASE/api/v1/plugins/adb-precheck/scan/$JOB_ID" | jq -r .status)
  echo "  status=$STATUS"
  case "$STATUS" in succeeded|failed|cancelled) break ;; esac
  sleep 5
done

echo "--- retry_stats / ui_state_distribution / snapshots_captured ---"
curl -fsS "$BASE/api/v1/plugins/adb-precheck/scan/$JOB_ID" \
  | jq '{status, retry_stats, ui_state_distribution, snapshots_captured}'

echo "--- note revision history ---"
curl -fsS "$BASE/api/v1/plugins/adb-precheck/notes/$PASTA/history" | jq .
```

```bash
chmod +x scripts/e2e-precheck-scale.sh
```

- [ ] **Step 2: Write `docs/operations/adb-precheck-runbook.md`**

```markdown
# ADB Pre-check Runbook

## Health checks
- `curl http://127.0.0.1:7890/api/v1/plugins/adb-precheck/health` — 200 + JSON
- `curl http://127.0.0.1:7890/api/v1/admin/locks` — list of pasta locks held now

## Trigger a manual sweep
curl -X POST http://127.0.0.1:7890/api/v1/plugins/adb-precheck/retry-errors \
  -H 'content-type: application/json' -d '{"pasta":"15516752-A"}'

## SQL dashboards (against dispatch.db)

### Retry-level save rate (last 7 days)
SELECT attempt_phase, result, COUNT(*) AS n, ROUND(AVG(latency_ms)) AS avg_ms
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day')
GROUP BY attempt_phase, result
ORDER BY attempt_phase, result;

### UI states leaking as inconclusive
SELECT json_extract(evidence,'$.ui_state') AS state,
       COUNT(*) AS hits,
       SUM(CASE WHEN result = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive_n
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day') AND source='adb_probe'
GROUP BY state ORDER BY hits DESC;

### Pastas with the most lingering errors
SELECT pasta, COUNT(*) AS deals_with_errors
FROM adb_precheck_deals
WHERE phones_json LIKE '%"outcome":"error"%'
  AND scanned_at > datetime('now','-7 day')
GROUP BY pasta ORDER BY deals_with_errors DESC LIMIT 20;

### Sweep lineage
SELECT j.id AS sweep_job, j.created_at, j.parent_job_id, j.triggered_by
FROM adb_precheck_jobs j
WHERE j.triggered_by = 'retry-errors-sweep'
ORDER BY j.created_at DESC LIMIT 50;
```

- [ ] **Step 3: Write `docs/operations/adb-precheck-snapshot-calibration.md`**

```markdown
# Snapshot calibration playbook

When wa_contact_checks shows a spike in ui_state = unknown or unknown_dialog:

1. Find a representative snapshot path:
   sqlite3 dispatch.db "SELECT json_extract(evidence,'\$.snapshot_path')
                        FROM wa_contact_checks
                        WHERE json_extract(evidence,'\$.ui_state') = 'unknown'
                        ORDER BY checked_at DESC LIMIT 5;"

2. Copy a snapshot to fixtures:
   cp /var/www/debt-adb-framework/packages/core/data/probe-snapshots/<file> \
      packages/core/test/fixtures/ui-states/<new-state>.xml

3. Add a fixture-driven failing test in ui-state-classifier.test.ts.

4. Add a rule in ui-state-classifier.ts (in priority order) and run tests until green.

5. Commit + ship.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-precheck-scale.sh docs/operations/
git commit -m "docs(precheck): add E2E driver, runbook, snapshot calibration playbook"
```

---

## Phase Gate — final verification

After all tasks above land:

- [ ] **Run the full test suite**

```bash
cd packages/core && npx vitest run --coverage
```
Expected: all tests pass; coverage on `ui-state-classifier.ts` ≥ 100 %; on `pasta-lock-manager.ts` ≥ 95 %.

- [ ] **Run E2E driver against a small pasta on the test device**

```bash
./scripts/e2e-precheck-scale.sh 15516752-A 50
```
Expected: job completes; final `retry_stats.remaining_errors` < 5 % of total phones; the pasta note in Pipedrive shows a single revision (POST) for first run.

- [ ] **Re-run the same pasta — verify in-place note update**

```bash
./scripts/e2e-precheck-scale.sh 15516752-A 50
```
Expected: same `current_pipedrive_id`; `revisions[]` length grows by one; second revision has `verb: PUT` and `revises_row_id` set.

- [ ] **Trigger a sweep on residual errors**

```bash
curl -X POST http://127.0.0.1:7890/api/v1/plugins/adb-precheck/retry-errors \
  -H 'content-type: application/json' -d '{"pasta":"15516752-A"}'
```
Expected: 202 with new `job_id`; after completion, `wa_contact_checks` has `attempt_phase='sweep_retry'` rows; pasta note has a third revision.

- [ ] **Update `.dev-state/progress.md`**

Mark this iteration complete and unblock dependent phases.

```bash
git add .dev-state/progress.md
git commit -m "phase: approve adb-precheck robustness iteration"
```
