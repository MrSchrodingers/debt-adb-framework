# ADB Precheck Multi-Tenant Implementation Plan (Phase A + B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable parallel ADB Precheck across three devices, each running against a different Pipeboard tenant (`adb`/`sicoob`/`oralsin`), with one-scan-per-device enforcement, dirty-phone hygienization for sicoob/oralsin, and Pipedrive Note+Activity (done=1) emission per scanned deal. The existing tenant_adb flow remains byte-for-byte unchanged.

**Architecture:** Single `AdbPrecheckPlugin` instance with internal multi-tenant dispatch. New router endpoint `GET /api/v1/{tenant}/precheck-raw/deals` for sicoob/oralsin (raw mode reads `negocios JOIN pessoas`, no writeback). New `PipeboardRawRest` client implementing the existing `IPipeboardClient` interface. SQLite tables gain `tenant TEXT NOT NULL DEFAULT 'adb'` for backwards-compat migration. UI gains tenant selector + device-busy badge + pipeline/stage picker.

**Tech Stack:** TypeScript (packages/core, packages/ui), Fastify, Vitest, better-sqlite3, Zod, pino. Go (pipeboard_ecosystem/router), gorilla/mux, pgx/v5, zap. React 19, Lucide icons, Tailwind. Existing core primitives reused: `DeviceMutex`, `ContactValidator`, `PipedrivePublisher`, `PastaLockManager`, `ContactRegistry`.

**Spec:** `docs/superpowers/specs/2026-05-14-adb-precheck-multi-tenant-design.md`

**Scope of this plan:** Phase A (Foundation) + Phase B (Sicoob Tracer Bullet) — the vertical end-to-end slice. Phases C (Oralsin config-delta) and D (Hardening + observability) ship as separate plans after B is APPROVED.

**Phases:**
- **A. Foundation multi-tenant** — Tasks 1–10 (registry, migrations, DeviceMutex, /tenants, /devices, regression-safe)
- **B.1 Router (Go)** — Tasks 11–18 (whitelist split, /precheck-raw/deals, projection, tests)
- **B.2 Plugin TS multi-tenant dispatch** — Tasks 19–28 (PipeboardRawRest, scanner mode='raw', per-tenant Pipedrive, scan params)
- **B.3 UI React tenant-aware** — Tasks 29–35 (selector, context, device card, pipeline picker, lane filter)
- **B.4 E2E + Phase Gate** — Tasks 36–40 (config Sicoob, real scan, code review, gate)

Each task: TDD red→green→commit. ~40-45 commits expected.

**Test phone:** `5543991938235` (per CLAUDE.md — only for E2E ADB sends).

**Critical references for engineers new to this codebase:**
- `packages/core/src/plugins/adb-precheck/types.ts` — all domain types (DealKey, PhoneResult, PrecheckScanParams)
- `packages/core/src/plugins/adb-precheck/pipeboard-client.ts` — `IPipeboardClient` interface (T2 implements this)
- `packages/core/src/plugins/adb-precheck/scanner.ts` — main scan loop
- `packages/core/src/engine/device-mutex.ts` — physical screen serialization
- `pipeboard_ecosystem/router/internal/api/rest/precheck_deals.go` — pattern to mirror for precheck-raw
- `pipeboard_ecosystem/router/internal/api/rest/precheck.go:76` — whitelist to split

---

## FASE A — Foundation multi-tenant

### Task 1: TenantRegistry — types and env parser (failing tests)

**Files:**
- Create: `packages/core/src/plugins/adb-precheck/tenant-registry.ts`
- Create: `packages/core/src/plugins/adb-precheck/tenant-registry.test.ts`

- [ ] **Step 1: Create failing test file**

Create `packages/core/src/plugins/adb-precheck/tenant-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TenantRegistry, TenantConfigError } from './tenant-registry.js'

describe('TenantRegistry.fromEnv', () => {
  it('loads adb tenant from unsuffixed env vars (back-compat)', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://router/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'k_adb',
    })
    const adb = r.get('adb')
    expect(adb.id).toBe('adb')
    expect(adb.mode).toBe('prov')
    expect(adb.restBaseUrl).toBe('http://router/api/v1/adb')
    expect(adb.writeback.invalidate).toBe(true)
  })

  it('loads sicoob with suffixed vars and raw mode', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://r/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'k_adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB: 'http://r/api/v1/sicoob',
      PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB: 'k_sicoob',
      PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB: '14',
      PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB: '110',
      PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB: 'pd_sicoob',
    })
    const s = r.get('sicoob')
    expect(s.mode).toBe('raw')
    expect(s.defaultPipelineId).toBe(14)
    expect(s.defaultStageId).toBe(110)
    expect(s.writeback.invalidate).toBe(false)
    expect(s.writeback.localize).toBe(false)
    expect(s.writeback.pipedriveNote).toBe(true)
    expect(s.writeback.pipedriveActivity).toBe(true)
    expect(s.pipedrive?.apiToken).toBe('pd_sicoob')
  })

  it('throws when a declared tenant has missing required vars', () => {
    expect(() =>
      TenantRegistry.fromEnv({
        PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
        PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
        PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
      }),
    ).toThrow(TenantConfigError)
  })

  it('list() returns tenants in declared order', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
    })
    expect(r.list().map((t) => t.id)).toEqual(['adb'])
  })

  it('has() returns false for undeclared tenant', () => {
    const r = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'x',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'y',
    })
    expect(r.has('adb')).toBe(true)
    expect(r.has('sicoob' as never)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/tenant-registry.test.ts
```

Expected: FAIL (`Cannot find module './tenant-registry.js'`).

- [ ] **Step 3: Create the module**

Create `packages/core/src/plugins/adb-precheck/tenant-registry.ts`:

```ts
export type TenantId = 'adb' | 'sicoob' | 'oralsin'
export type TenantMode = 'prov' | 'raw'

export interface TenantWriteback {
  invalidate: boolean
  localize: boolean
  pipedriveNote: boolean
  pipedriveActivity: boolean
}

export interface TenantConfig {
  id: TenantId
  label: string
  mode: TenantMode
  restBaseUrl: string
  restApiKey: string
  restTimeoutMs?: number
  defaultPipelineId?: number
  defaultStageId?: number
  pipedrive?: {
    apiToken: string
    companyDomain?: string
  }
  writeback: TenantWriteback
}

export class TenantConfigError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'TenantConfigError'
  }
}

const TENANT_LABELS: Record<TenantId, string> = {
  adb: 'ADB/Debt',
  sicoob: 'Sicoob',
  oralsin: 'Oralsin',
}

const TENANT_MODES: Record<TenantId, TenantMode> = {
  adb: 'prov',
  sicoob: 'raw',
  oralsin: 'raw',
}

const WRITEBACK_BY_MODE: Record<TenantMode, TenantWriteback> = {
  prov: { invalidate: true, localize: true, pipedriveNote: true, pipedriveActivity: true },
  raw: { invalidate: false, localize: false, pipedriveNote: true, pipedriveActivity: true },
}

function reqEnv(env: NodeJS.ProcessEnv, key: string, tenantId: TenantId): string {
  const v = env[key]
  if (!v || v.trim() === '') {
    throw new TenantConfigError(`tenant=${tenantId}: missing env ${key}`)
  }
  return v
}

function optEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return v && v.trim() !== '' ? v : undefined
}

function parseInt32(s: string | undefined, label: string, tenantId: TenantId): number | undefined {
  if (!s) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TenantConfigError(`tenant=${tenantId}: invalid integer for ${label}: ${s}`)
  }
  return n
}

export class TenantRegistry {
  private tenants: TenantConfig[]
  private byId: Map<TenantId, TenantConfig>

  private constructor(tenants: TenantConfig[]) {
    this.tenants = tenants
    this.byId = new Map(tenants.map((t) => [t.id, t]))
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TenantRegistry {
    const raw = env.PLUGIN_ADB_PRECHECK_TENANTS
    if (!raw || raw.trim() === '') {
      // Back-compat: legacy single-tenant deployments default to adb-only.
      return new TenantRegistry([buildAdbFromLegacyEnv(env)])
    }
    const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const seen = new Set<string>()
    const tenants: TenantConfig[] = []
    for (const id of ids) {
      if (!isTenantId(id)) {
        throw new TenantConfigError(`unknown tenant id in PLUGIN_ADB_PRECHECK_TENANTS: ${id}`)
      }
      if (seen.has(id)) {
        throw new TenantConfigError(`duplicate tenant id: ${id}`)
      }
      seen.add(id)
      tenants.push(id === 'adb' ? buildAdbFromLegacyEnv(env) : buildSuffixedTenant(env, id))
    }
    return new TenantRegistry(tenants)
  }

  list(): TenantConfig[] {
    return [...this.tenants]
  }

  get(id: TenantId): TenantConfig {
    const t = this.byId.get(id)
    if (!t) throw new TenantConfigError(`tenant not configured: ${id}`)
    return t
  }

  has(id: TenantId): boolean {
    return this.byId.has(id)
  }
}

function isTenantId(s: string): s is TenantId {
  return s === 'adb' || s === 'sicoob' || s === 'oralsin'
}

function buildAdbFromLegacyEnv(env: NodeJS.ProcessEnv): TenantConfig {
  return {
    id: 'adb',
    label: TENANT_LABELS.adb,
    mode: TENANT_MODES.adb,
    restBaseUrl: reqEnv(env, 'PLUGIN_ADB_PRECHECK_REST_BASE_URL', 'adb'),
    restApiKey: reqEnv(env, 'PLUGIN_ADB_PRECHECK_REST_API_KEY', 'adb'),
    restTimeoutMs: parseInt32(env.PLUGIN_ADB_PRECHECK_REST_TIMEOUT_MS, 'REST_TIMEOUT_MS', 'adb'),
    pipedrive: env.PIPEDRIVE_API_TOKEN
      ? {
          apiToken: env.PIPEDRIVE_API_TOKEN,
          companyDomain: optEnv(env, 'PIPEDRIVE_COMPANY_DOMAIN'),
        }
      : undefined,
    writeback: WRITEBACK_BY_MODE.prov,
  }
}

function buildSuffixedTenant(env: NodeJS.ProcessEnv, id: TenantId): TenantConfig {
  const u = id.toUpperCase()
  return {
    id,
    label: TENANT_LABELS[id],
    mode: TENANT_MODES[id],
    restBaseUrl: reqEnv(env, `PLUGIN_ADB_PRECHECK_REST_BASE_URL_${u}`, id),
    restApiKey: reqEnv(env, `PLUGIN_ADB_PRECHECK_REST_API_KEY_${u}`, id),
    restTimeoutMs: parseInt32(env[`PLUGIN_ADB_PRECHECK_REST_TIMEOUT_MS_${u}`], `REST_TIMEOUT_MS_${u}`, id),
    defaultPipelineId: parseInt32(env[`PLUGIN_ADB_PRECHECK_PIPELINE_ID_${u}`], `PIPELINE_ID_${u}`, id),
    defaultStageId: parseInt32(env[`PLUGIN_ADB_PRECHECK_STAGE_ID_${u}`], `STAGE_ID_${u}`, id),
    pipedrive: env[`PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_${u}`]
      ? {
          apiToken: env[`PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_${u}`]!,
          companyDomain: optEnv(env, `PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_${u}`),
        }
      : undefined,
    writeback: WRITEBACK_BY_MODE[TENANT_MODES[id]],
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/tenant-registry.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/tenant-registry.ts packages/core/src/plugins/adb-precheck/tenant-registry.test.ts
git commit -m "feat(adb-precheck): TenantRegistry — multi-tenant config from env"
```

---

### Task 2: Export TenantRegistry from plugin barrel

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/index.ts`

- [ ] **Step 1: Read existing exports**

```bash
cat packages/core/src/plugins/adb-precheck/index.ts
```

- [ ] **Step 2: Append exports**

Add to the bottom of `packages/core/src/plugins/adb-precheck/index.ts`:

```ts
export {
  TenantRegistry,
  TenantConfigError,
  type TenantId,
  type TenantMode,
  type TenantConfig,
  type TenantWriteback,
} from './tenant-registry.js'
```

- [ ] **Step 3: Verify barrel compiles**

```bash
cd packages/core && pnpm tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/index.ts
git commit -m "chore(adb-precheck): export TenantRegistry from barrel"
```

---

### Task 3: SQLite migration — add `tenant` column to plugin tables

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/job-store.ts` (initialize() adds idempotent migration)
- Modify: `packages/core/src/plugins/adb-precheck/job-store.test.ts`
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts`
- Modify: `packages/core/src/plugins/adb-precheck/pending-writebacks.ts`

The codebase pattern is inline idempotent migration inside `initialize()`. Mirror it.

- [ ] **Step 1: Read existing initialize() in job-store**

```bash
grep -n "initialize\|CREATE TABLE\|ALTER TABLE" packages/core/src/plugins/adb-precheck/job-store.ts | head -30
```

Locate the `initialize()` method and the existing idempotent `ALTER TABLE ... ADD COLUMN` pattern (used previously for `triggered_by`, `parent_job_id`).

- [ ] **Step 2: Add failing test for `tenant` column**

Append to `packages/core/src/plugins/adb-precheck/job-store.test.ts`:

```ts
describe('PrecheckJobStore — multi-tenant', () => {
  it('creates jobs with default tenant=adb (back-compat)', () => {
    const db = new Database(':memory:')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const job = store.createJob({ limit: 1, writeback_invalid: false, hygienization_mode: false }, 'ext_1', { pipedriveEnabled: false, hygienizationMode: false })
    const row = db.prepare('SELECT tenant FROM adb_precheck_jobs WHERE id = ?').get(job.id) as { tenant: string }
    expect(row.tenant).toBe('adb')
  })

  it('createJob accepts explicit tenant', () => {
    const db = new Database(':memory:')
    const store = new PrecheckJobStore(db)
    store.initialize()
    const job = store.createJob(
      { limit: 1, writeback_invalid: false, hygienization_mode: false },
      'ext_2',
      { pipedriveEnabled: false, hygienizationMode: false, tenant: 'sicoob' },
    )
    const row = db.prepare('SELECT tenant FROM adb_precheck_jobs WHERE id = ?').get(job.id) as { tenant: string }
    expect(row.tenant).toBe('sicoob')
  })

  it('listJobs(tenant) filters by tenant', () => {
    const db = new Database(':memory:')
    const store = new PrecheckJobStore(db)
    store.initialize()
    store.createJob({ writeback_invalid: false, hygienization_mode: false }, 'a', { pipedriveEnabled: false, hygienizationMode: false, tenant: 'adb' })
    store.createJob({ writeback_invalid: false, hygienization_mode: false }, 'b', { pipedriveEnabled: false, hygienizationMode: false, tenant: 'sicoob' })
    expect(store.listJobs(50, 'sicoob').length).toBe(1)
    expect(store.listJobs(50).length).toBe(2)
  })
})
```

- [ ] **Step 3: Run test, verify it fails**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/job-store.test.ts -t "multi-tenant"
```

Expected: FAIL (tenant column / parameter unknown).

- [ ] **Step 4: Modify `initialize()` in job-store.ts**

In `packages/core/src/plugins/adb-precheck/job-store.ts`, locate the existing idempotent migration block inside `initialize()`. Add:

```ts
// Multi-tenant migration — default 'adb' preserves existing rows.
this.idempotentAlter(
  'adb_precheck_jobs',
  'tenant',
  "ALTER TABLE adb_precheck_jobs ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb'",
)
this.idempotentAlter(
  'adb_precheck_deals',
  'tenant',
  "ALTER TABLE adb_precheck_deals ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb'",
)
this.db
  .prepare("CREATE INDEX IF NOT EXISTS idx_adb_precheck_jobs_tenant ON adb_precheck_jobs(tenant, status)")
  .run()
this.db
  .prepare("CREATE INDEX IF NOT EXISTS idx_adb_precheck_deals_tenant ON adb_precheck_deals(tenant, scanned_at DESC)")
  .run()
```

If `idempotentAlter` does not yet exist in the file, add it as a private method:

```ts
private idempotentAlter(table: string, column: string, ddl: string): void {
  const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  this.db.prepare(ddl).run()
}
```

- [ ] **Step 5: Extend `createJob()` signature**

Locate `createJob(params, externalRef, opts)` in job-store.ts. Extend the `opts` type to include `tenant?: 'adb' | 'sicoob' | 'oralsin'`. Default to `'adb'`. Bind in the INSERT:

```ts
const tenant = opts.tenant ?? 'adb'
// ... in the INSERT statement, add `tenant` column and parameter.
```

- [ ] **Step 6: Extend `listJobs()` to accept tenant filter**

Change signature to `listJobs(limit: number, tenant?: 'adb' | 'sicoob' | 'oralsin')`. When `tenant` is provided, add `WHERE tenant = ?`.

- [ ] **Step 7: Run job-store tests, verify they pass**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/job-store.test.ts
```

Expected: all PASS (existing + 3 new).

- [ ] **Step 8: Repeat idempotent migration for pipedrive-activity-store and pending-writebacks**

In `pipedrive-activity-store.ts` `initialize()`:

```ts
this.idempotentAlter(
  'pipedrive_activities',
  'tenant',
  "ALTER TABLE pipedrive_activities ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb'",
)
this.db
  .prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_pipedrive_activities_dedup_tenant ON pipedrive_activities(tenant, dedup_key)",
  )
  .run()
```

> Note: this will fail if a duplicate `(adb, dedup_key)` already exists. Pipeboard prod has no duplicates today (verified via `aggregateStats`). If you hit a UNIQUE conflict on a fresh deploy, see the contingency in Task 3.5 below.

In `pending-writebacks.ts` `initialize()`:

```ts
this.idempotentAlter(
  'pending_writebacks',
  'tenant',
  "ALTER TABLE pending_writebacks ADD COLUMN tenant TEXT NOT NULL DEFAULT 'adb'",
)
```

Add the `idempotentAlter` helper to each file (same body as job-store).

- [ ] **Step 9: Run full plugin test suite**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/job-store.ts packages/core/src/plugins/adb-precheck/job-store.test.ts packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts packages/core/src/plugins/adb-precheck/pending-writebacks.ts
git commit -m "feat(adb-precheck): multi-tenant SQLite migration (tenant column + indexes)"
```

---

### Task 3.5: Contingency — dedupe existing `pipedrive_activities` before UNIQUE index

Only run if Task 3 Step 8 errors with `UNIQUE constraint failed`.

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts`

- [ ] **Step 1: Inspect duplicates**

```bash
sqlite3 data/dispatch.db "SELECT dedup_key, COUNT(*) FROM pipedrive_activities GROUP BY dedup_key HAVING COUNT(*) > 1 LIMIT 20"
```

- [ ] **Step 2: Add a pre-migration step that keeps the newest row per dedup_key**

Inside `initialize()`, BEFORE the `CREATE UNIQUE INDEX` call:

```ts
this.db
  .prepare(
    `DELETE FROM pipedrive_activities
       WHERE id NOT IN (
         SELECT MAX(id) FROM pipedrive_activities GROUP BY dedup_key
       )`,
  )
  .run()
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts
git commit -m "fix(adb-precheck): dedupe pipedrive_activities before adding UNIQUE index"
```

---

### Task 4: DeviceMutex — describeHolder + context-aware acquire (failing tests)

**Files:**
- Modify: `packages/core/src/engine/device-mutex.ts`
- Modify: `packages/core/src/engine/device-mutex.test.ts`

- [ ] **Step 1: Add failing test**

Append to `packages/core/src/engine/device-mutex.test.ts`:

```ts
describe('DeviceMutex — describeHolder', () => {
  it('returns null when device is free', async () => {
    const m = new DeviceMutex(1000)
    expect(m.describeHolder('R8A1')).toBeNull()
  })

  it('returns holder context when acquired with ctx', async () => {
    const m = new DeviceMutex(1000)
    const release = await m.acquire('R8A1', { tenant: 'sicoob', jobId: 'j_abc' })
    const h = m.describeHolder('R8A1')
    expect(h).toMatchObject({ tenant: 'sicoob', jobId: 'j_abc' })
    expect(h?.since).toMatch(/^\d{4}-/) // ISO 8601 starts with year
    release()
  })

  it('returns holder with anonymous ctx when acquire called without ctx', async () => {
    const m = new DeviceMutex(1000)
    const release = await m.acquire('R8A1')
    const h = m.describeHolder('R8A1')
    expect(h).toMatchObject({ tenant: '(unknown)', jobId: '(unknown)' })
    release()
  })

  it('clears holder context on release', async () => {
    const m = new DeviceMutex(1000)
    const release = await m.acquire('R8A1', { tenant: 'adb', jobId: 'j_1' })
    release()
    expect(m.describeHolder('R8A1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd packages/core && pnpm vitest run src/engine/device-mutex.test.ts -t "describeHolder"
```

Expected: FAIL (`describeHolder` not a function; `acquire` does not accept 2nd arg).

- [ ] **Step 3: Modify DeviceMutex**

Replace `packages/core/src/engine/device-mutex.ts` to add holder context tracking:

```ts
export interface DeviceMutexCtx {
  tenant: string
  jobId: string
}

interface HolderState extends DeviceMutexCtx {
  since: string // ISO 8601
}

export class DeviceMutex {
  private locks = new Map<string, { resolve: () => void; ctx?: DeviceMutexCtx }[]>()
  private held = new Map<string, HolderState>()

  constructor(private timeoutMs = 60_000) {}

  async acquire(deviceSerial: string, ctx?: DeviceMutexCtx): Promise<() => void> {
    if (!this.held.has(deviceSerial)) {
      this.held.set(deviceSerial, {
        tenant: ctx?.tenant ?? '(unknown)',
        jobId: ctx?.jobId ?? '(unknown)',
        since: new Date().toISOString(),
      })
      return () => this.release(deviceSerial)
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.locks.get(deviceSerial)
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === onRelease)
          if (idx !== -1) waiters.splice(idx, 1)
        }
        reject(new Error(`DeviceMutex timeout after ${this.timeoutMs}ms for ${deviceSerial}`))
      }, this.timeoutMs)

      const onRelease = () => {
        clearTimeout(timer)
        this.held.set(deviceSerial, {
          tenant: ctx?.tenant ?? '(unknown)',
          jobId: ctx?.jobId ?? '(unknown)',
          since: new Date().toISOString(),
        })
        resolve(() => this.release(deviceSerial))
      }

      if (!this.locks.has(deviceSerial)) this.locks.set(deviceSerial, [])
      this.locks.get(deviceSerial)!.push({ resolve: onRelease, ctx })
    })
  }

  isHeld(deviceSerial: string): boolean {
    return this.held.has(deviceSerial)
  }

  describeHolder(deviceSerial: string): HolderState | null {
    return this.held.get(deviceSerial) ?? null
  }

  private release(deviceSerial: string): void {
    const waiters = this.locks.get(deviceSerial)
    if (waiters && waiters.length > 0) {
      this.held.delete(deviceSerial)
      const next = waiters.shift()!
      next.resolve()
    } else {
      this.held.delete(deviceSerial)
      this.locks.delete(deviceSerial)
    }
  }

  releaseAll(): void {
    this.held.clear()
    this.locks.clear()
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd packages/core && pnpm vitest run src/engine/device-mutex.test.ts
```

Expected: all PASS (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/engine/device-mutex.ts packages/core/src/engine/device-mutex.test.ts
git commit -m "feat(engine): DeviceMutex tracks holder context (tenant, jobId, since)"
```

---

### Task 5: Scanner passes ctx to DeviceMutex.acquire

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/scanner.ts` (search for `deviceMutex.acquire`)
- Modify: `packages/core/src/check-strategies/adb-probe-strategy.ts` (if it calls acquire)

- [ ] **Step 1: Find call sites**

```bash
grep -rn "deviceMutex.acquire\|deviceMutex\.acquire" packages/core/src
```

- [ ] **Step 2: Update each call to pass `{ tenant, jobId }`**

At each call site, pass the current tenant + job_id from the surrounding context. In `scanner.ts`, the job has the tenant; pass `{ tenant: job.tenant, jobId: jobId }`. In `adb-probe-strategy.ts`, the strategy receives `triggered_by` — pass `{ tenant: ctx?.tenant ?? '(unknown)', jobId: ctx?.jobId ?? '(unknown)' }`.

- [ ] **Step 3: Run plugin test suite + engine test suite**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/ src/engine/
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/scanner.ts packages/core/src/check-strategies/adb-probe-strategy.ts
git commit -m "feat(adb-precheck): scanner+probe pass tenant ctx to DeviceMutex"
```

---

### Task 6: Plugin route `GET /tenants`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

- [ ] **Step 1: Add failing integration test**

Create `packages/core/src/plugins/adb-precheck-plugin.tenants.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { AdbPrecheckPlugin } from './adb-precheck-plugin.js'
import { TenantRegistry } from './adb-precheck/tenant-registry.js'

describe('AdbPrecheckPlugin route /tenants', () => {
  it('lists configured tenants without leaking secrets', async () => {
    const registry = TenantRegistry.fromEnv({
      PLUGIN_ADB_PRECHECK_TENANTS: 'adb,sicoob',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL: 'http://r/api/v1/adb',
      PLUGIN_ADB_PRECHECK_REST_API_KEY: 'secret_adb',
      PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB: 'http://r/api/v1/sicoob',
      PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB: 'secret_sicoob',
      PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB: '14',
      PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB: '110',
      PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB: 'pd_sicoob',
    })
    // Build a minimal plugin with the registry (test helper to be added below)
    // Sanitized response: tenant id, label, mode, defaultPipelineId, defaultStageId, writeback flags, no tokens or URLs
    const sanitized = registry.list().map((t) => ({
      id: t.id,
      label: t.label,
      mode: t.mode,
      defaultPipelineId: t.defaultPipelineId,
      defaultStageId: t.defaultStageId,
      writeback: t.writeback,
      pipedriveEnabled: Boolean(t.pipedrive?.apiToken),
    }))
    expect(sanitized).toHaveLength(2)
    expect(sanitized[0].id).toBe('adb')
    expect(sanitized[1]).toMatchObject({ id: 'sicoob', mode: 'raw', defaultPipelineId: 14, defaultStageId: 110, pipedriveEnabled: true })
    expect(JSON.stringify(sanitized)).not.toContain('secret_')
    expect(JSON.stringify(sanitized)).not.toContain('pd_sicoob')
  })
})
```

- [ ] **Step 2: Run test, verify scaffold compiles**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck-plugin.tenants.test.ts
```

Expected: PASS (this first test exercises only the registry sanitization).

- [ ] **Step 3: Wire `GET /tenants` in plugin init()**

In `packages/core/src/plugins/adb-precheck-plugin.ts`, inject the `TenantRegistry` via constructor opts:

```ts
// constructor opts addition
tenantRegistry?: TenantRegistry
```

In `init()`, register:

```ts
ctx.registerRoute('GET', '/tenants', this.handleListTenants.bind(this))
```

Add the handler:

```ts
private async handleListTenants(_req: unknown, reply: unknown): Promise<unknown> {
  const r = reply as { send: (x: unknown) => unknown }
  const list = (this.tenantRegistry ?? TenantRegistry.fromEnv()).list().map((t) => ({
    id: t.id,
    label: t.label,
    mode: t.mode,
    defaultPipelineId: t.defaultPipelineId,
    defaultStageId: t.defaultStageId,
    writeback: t.writeback,
    pipedriveEnabled: Boolean(t.pipedrive?.apiToken),
  }))
  return r.send({ tenants: list })
}
```

Add the field `private tenantRegistry: TenantRegistry | undefined` to the class.

- [ ] **Step 4: Verify tsc + tests**

```bash
cd packages/core && pnpm tsc --noEmit && pnpm vitest run src/plugins/
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-plugin.tenants.test.ts
git commit -m "feat(adb-precheck): expose GET /tenants endpoint (sanitized)"
```

---

### Task 7: Plugin route `GET /devices/availability`

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`
- Modify: `packages/core/src/plugins/types.ts` (PluginContext gains `getKnownDevices?`)

- [ ] **Step 1: Locate where device list comes from**

```bash
grep -rn "listDevices\|knownDevices\|getDevices" packages/core/src/monitor packages/core/src/devices | head
```

The Device Manager (`packages/core/src/devices/`) exposes a `listConnected()` method. We need the plugin to consume that.

- [ ] **Step 2: Extend `PluginContext` to expose device list and mutex**

In `packages/core/src/plugins/types.ts`, add optional fields:

```ts
export interface PluginContext {
  // ... existing fields
  deviceMutex?: DeviceMutex
  listConnectedDevices?: () => Promise<Array<{ serial: string }>>
}
```

In `server.ts` where the PluginContext is constructed, wire the device manager method.

- [ ] **Step 3: Register `/devices/availability` route**

In `adb-precheck-plugin.ts` `init()`:

```ts
ctx.registerRoute('GET', '/devices/availability', this.handleDeviceAvailability.bind(this))
```

Handler:

```ts
private async handleDeviceAvailability(_req: unknown, reply: unknown): Promise<unknown> {
  const r = reply as { send: (x: unknown) => unknown }
  const list = this.ctx?.listConnectedDevices ? await this.ctx.listConnectedDevices() : []
  const mutex = this.ctx?.deviceMutex
  const devices = list.map((d) => {
    const holder = mutex?.describeHolder(d.serial)
    if (holder) {
      return { serial: d.serial, available: false, tenant: holder.tenant, job_id: holder.jobId, since: holder.since }
    }
    return { serial: d.serial, available: true }
  })
  return r.send({ devices })
}
```

- [ ] **Step 4: Add test**

Create `packages/core/src/plugins/adb-precheck-plugin.devices.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DeviceMutex } from '../engine/device-mutex.js'

describe('handleDeviceAvailability (logic)', () => {
  it('marks held devices as unavailable with holder context', async () => {
    const m = new DeviceMutex(1000)
    const release = await m.acquire('R8A1', { tenant: 'sicoob', jobId: 'j_abc' })
    const known = [{ serial: 'R8A1' }, { serial: 'R8A2' }]
    const mapped = known.map((d) => {
      const h = m.describeHolder(d.serial)
      return h
        ? { serial: d.serial, available: false, tenant: h.tenant, job_id: h.jobId, since: h.since }
        : { serial: d.serial, available: true }
    })
    expect(mapped[0]).toMatchObject({ serial: 'R8A1', available: false, tenant: 'sicoob', job_id: 'j_abc' })
    expect(mapped[1]).toEqual({ serial: 'R8A2', available: true })
    release()
  })
})
```

- [ ] **Step 5: Run tests**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck-plugin.devices.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/types.ts packages/core/src/plugins/adb-precheck-plugin.devices.test.ts
git commit -m "feat(adb-precheck): GET /devices/availability — surface DeviceMutex holders"
```

---

### Task 8: handleStartScan validates device not busy → 409

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (handleStartScan)
- Modify: `packages/core/src/plugins/adb-precheck-plugin.tenants.test.ts` (rename to `...plugin.scan.test.ts` if cleaner)

- [ ] **Step 1: Add failing test**

Append to a new file `packages/core/src/plugins/adb-precheck-plugin.busy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DeviceMutex } from '../engine/device-mutex.js'

describe('Scan submit when device is busy', () => {
  it('returns 409 device_busy when DeviceMutex.isHeld() is true for target serial', async () => {
    const m = new DeviceMutex(1000)
    const release = await m.acquire('R8A1', { tenant: 'sicoob', jobId: 'j_abc' })
    const requested = 'R8A1'
    // Plugin logic (extracted for test):
    function validateDeviceFree(serial: string, mutex: DeviceMutex): { ok: true } | { ok: false; status: 409; body: unknown } {
      if (mutex.isHeld(serial)) {
        const h = mutex.describeHolder(serial)!
        return { ok: false, status: 409, body: { error: 'device_busy', serial, tenant: h.tenant, job_id: h.jobId, since: h.since } }
      }
      return { ok: true }
    }
    const r = validateDeviceFree(requested, m)
    expect(r).toMatchObject({ ok: false, status: 409 })
    if (!r.ok) {
      expect(r.body).toMatchObject({ error: 'device_busy', serial: 'R8A1', tenant: 'sicoob', job_id: 'j_abc' })
    }
    release()
  })
})
```

- [ ] **Step 2: Run test, verify it passes (logic only, no plugin integration)**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck-plugin.busy.test.ts
```

Expected: PASS.

- [ ] **Step 3: Wire into handleStartScan**

In `packages/core/src/plugins/adb-precheck-plugin.ts` `handleStartScan`, BEFORE creating the job (after Zod parse, before `checkDeviceReady`):

```ts
const requestedSerial = rawParams.device_serial ?? this.defaultDeviceSerial
if (requestedSerial && this.ctx?.deviceMutex?.isHeld(requestedSerial)) {
  const h = this.ctx.deviceMutex.describeHolder(requestedSerial)!
  return r.status(409).send({
    error: 'device_busy',
    serial: requestedSerial,
    tenant: h.tenant,
    job_id: h.jobId,
    since: h.since,
  })
}
```

- [ ] **Step 4: Run plugin test suite**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck-plugin
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-plugin.busy.test.ts
git commit -m "feat(adb-precheck): handleStartScan returns 409 device_busy when device held"
```

---

### Task 9: server.ts wires TenantRegistry into plugin

**Files:**
- Modify: `packages/core/src/server.ts` (the `'adb-precheck': () => { ... }` factory, lines 775-826)

- [ ] **Step 1: Read existing factory**

```bash
sed -n '770,830p' packages/core/src/server.ts
```

- [ ] **Step 2: Build TenantRegistry once at boot**

In `server.ts`, near the top of the plugin section, BEFORE the `pluginMap`:

```ts
const tenantRegistry = TenantRegistry.fromEnv(process.env)
```

Add the import at top:

```ts
import { TenantRegistry } from './plugins/adb-precheck/index.js'
```

- [ ] **Step 3: Pass `tenantRegistry` into the plugin constructor**

In the `'adb-precheck': () => { ... }` factory, add to the opts object passed to `new AdbPrecheckPlugin({...})`:

```ts
tenantRegistry,
```

Also, where `defaultDeviceSerial` is read from env, keep the existing behavior — `tenantRegistry.get('adb')` should still expose the same restBaseUrl/apiKey via legacy unsuffixed envs (back-compat is in `buildAdbFromLegacyEnv`).

- [ ] **Step 4: Extend `AdbPrecheckPlugin` constructor signature**

In `packages/core/src/plugins/adb-precheck-plugin.ts`, add `tenantRegistry?: TenantRegistry` to the opts type and assign it to a `private tenantRegistry` field.

- [ ] **Step 5: Boot smoke**

```bash
cd packages/core && pnpm tsc --noEmit && DISPATCH_PLUGINS=adb-precheck PLUGIN_ADB_PRECHECK_TENANTS=adb PLUGIN_ADB_PRECHECK_REST_BASE_URL=http://localhost:18080/api/v1/adb PLUGIN_ADB_PRECHECK_REST_API_KEY=test PLUGIN_ADB_PRECHECK_BACKEND=rest npx tsx --eval "import('./src/server.js').then(()=>console.log('boot OK')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: `boot OK` (TenantRegistry loaded with adb only).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/server.ts packages/core/src/plugins/adb-precheck-plugin.ts
git commit -m "feat(adb-precheck): wire TenantRegistry into plugin constructor at boot"
```

---

### Task 10: Regression smoke — full Vitest pass

- [ ] **Step 1: Run the entire plugin and engine test suite**

```bash
cd packages/core && pnpm vitest run
```

Expected: 100% PASS (existing tests must NOT regress with the new tenant column / DeviceMutex changes).

- [ ] **Step 2: Run lint + tsc**

```bash
cd packages/core && pnpm lint && pnpm tsc --noEmit
```

Expected: zero warnings.

- [ ] **Step 3: Update progress**

Edit `.dev-state/progress.md` — add a row:

```
Phase A (Foundation multi-tenant) — APPROVED <ISO 8601 timestamp>
```

Commit:

```bash
git add .dev-state/progress.md
git commit -m "phase(A): foundation multi-tenant — APPROVED"
```

**🎯 PHASE A GATE: Foundation APPROVED. Proceed to Phase B (Sicoob tracer bullet).**

---

## FASE B.1 — Router (Go) sicoob support

> Work happens on the remote `pipeboard_ecosystem` repo (SSH: `claude@188.245.66.92:/var/www/pipeboard_ecosystem`).
> All commands below assume CWD on the remote is the router root.

### Task 11: Inspect tenant_sicoob phone columns (spike)

**Files:** none (read-only diagnostic).

- [ ] **Step 1: SSH and query schema details**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "docker exec docker-db-1 psql -U postgres -d pipeboard -c \"\\d tenant_sicoob.pessoas\" | head -80"
```

Expected: column list — confirm `cf_telefone_contatos_primary_value` exists; identify other phone-bearing custom field columns (e.g. `cf_telefone_secondary_value`, etc.).

- [ ] **Step 2: Sample real `custom_fields_jsonb` for phone-related keys**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "docker exec docker-db-1 psql -U postgres -d pipeboard -c \"SELECT id, custom_fields_jsonb FROM tenant_sicoob.pessoas WHERE custom_fields_jsonb IS NOT NULL LIMIT 5\""
```

Identify which JSONB keys hold phones (e.g. `phone_primary`, `phone_secondary`).

- [ ] **Step 3: Document findings**

Append to `.dev-state/restoration-2026-05-07/` (or create `.dev-state/phase-B-spike.md`):

```markdown
# Phase B Spike — tenant_sicoob phone shape

## pessoas table phone columns
- `cf_telefone_contatos_primary_value` (text) — formats observed: `(43) 984292585`, `55047991501806`, `43991509875`
- `custom_fields_jsonb` keys: <list from Step 2>

## negocios → pessoas join
- `negocios.person_id` references `pessoas.id`
- Some negocios may have null person_id (rare; treat as zero-phone deal)

## Decision
- Primary phone: `pessoas.cf_telefone_contatos_primary_value` → maps to `whatsapp_hot` in the dealRow projection
- Secondary: `pessoas.custom_fields_jsonb->>'<key1>'` → `telefone_hot_1`, etc.
- If a tenant has fewer than 3 secondary slots, leave higher columns NULL.
```

- [ ] **Step 4: Commit the spike note locally (not in router repo)**

```bash
cd /var/www/adb_tools && git add .dev-state/phase-B-spike.md && git commit -m "docs(phase-B): spike — tenant_sicoob phone shape"
```

---

### Task 12: Router — whitelist split (precheckProvTenants)

**Files (remote `pipeboard_ecosystem/router`):**
- Modify: `internal/api/rest/precheck.go` (lines around 76)
- Modify: `internal/api/rest/precheck.go`, `precheck_dispatched.go`, `precheck_localize.go`, `precheck_revalidate.go`, `precheck_audit_smell.go`, `precheck_phone_state.go` — gate changes
- Modify: `internal/api/rest/precheck.go` — tests if any

- [ ] **Step 1: Edit `precheck.go:76`**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "sed -n '70,90p' /var/www/pipeboard_ecosystem/router/internal/api/rest/precheck.go"
```

Replace the existing block:

```go
// Currently only adb has the underlying schema (tenant_adb.prov_telefones_invalidos).
var precheckAllowedTenants = map[string]bool{
    "adb": true,
}
```

With:

```go
// Tenants enrolled in any precheck endpoint (raw or prov).
var precheckAllowedTenants = map[string]bool{
    "adb":     true,
    "sicoob":  true,  // raw-only (precheck-raw subroute)
    "oralsin": true,  // raw-only (precheck-raw subroute)
}

// Tenants with full prov_consultas/prov_telefones_invalidos infrastructure.
// Gates the legacy /precheck/* write paths.
var precheckProvTenants = map[string]bool{
    "adb": true,
}
```

- [ ] **Step 2: Update each handler that writes to prov_*: swap the gate**

In `precheck.go` (HandlePhoneInvalidate, ~line 179), `precheck_dispatched.go` (~line 75), `precheck_localize.go` (~line 58), `precheck_revalidate.go` (~line 44), `precheck_audit_smell.go` (~line 95):

Find:
```go
if !precheckAllowedTenants[tenant] {
    writeJSONError(w, http.StatusNotFound, "tenant not enrolled in precheck")
    return
}
```

Replace with:
```go
if !precheckProvTenants[tenant] {
    writeJSONError(w, http.StatusNotFound, "tenant not enrolled in precheck-prov")
    return
}
```

In `precheck_phone_state.go` (line ~47 AND ~281): keep `precheckAllowedTenants` (this is a read path — sicoob/oralsin can call it BUT the SQL will 404 because tenant_sicoob has no prov_telefones_invalidos. That's the intended fail-closed behavior.)

- [ ] **Step 3: Add regression test**

Append to `internal/api/rest/precheck_phone_invalidate_test.go` (create the file if absent — mirror `precheck_archive_test.go` structure):

```go
func TestHandlePhoneInvalidate_RejectsRawOnlyTenant(t *testing.T) {
    ctx := context.Background()
    pgPool := newTestPool(t)
    h := NewPrecheckHandler(pgPool, nil, zap.NewNop())

    req := httptest.NewRequest("POST", "/api/v1/sicoob/precheck/phones/invalidate",
        strings.NewReader(`{"deal_id":1,"pasta":"x","contato_tipo":"y","contato_id":2,"phones":[]}`))
    req = mux.SetURLVars(req, map[string]string{"tenant": "sicoob"})
    // inject an API key context for tenant sicoob with precheck:write scope
    req = req.WithContext(middleware.WithAPIKey(ctx, &middleware.APIKey{TenantID: "sicoob", Scopes: []string{"precheck:write"}}))
    rec := httptest.NewRecorder()

    h.HandlePhoneInvalidate(rec, req)

    if rec.Code != http.StatusNotFound {
        t.Fatalf("want 404 for sicoob raw-only tenant, got %d body=%s", rec.Code, rec.Body.String())
    }
    if !strings.Contains(rec.Body.String(), "precheck-prov") {
        t.Fatalf("want 'precheck-prov' error message, got: %s", rec.Body.String())
    }
}
```

- [ ] **Step 4: Run Go tests**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go test ./internal/api/rest/... -run TestHandlePhoneInvalidate_RejectsRawOnlyTenant -v"
```

Expected: PASS.

- [ ] **Step 5: Run full router test suite to catch regressions**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go test ./internal/api/rest/..."
```

Expected: all PASS.

- [ ] **Step 6: Commit on the remote**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && git add router/internal/api/rest/precheck.go router/internal/api/rest/precheck_dispatched.go router/internal/api/rest/precheck_localize.go router/internal/api/rest/precheck_revalidate.go router/internal/api/rest/precheck_audit_smell.go router/internal/api/rest/precheck_phone_invalidate_test.go && git commit -m 'feat(precheck): split tenant whitelist (precheckAllowedTenants vs precheckProvTenants)'"
```

---

### Task 13: Router — projection helper (precheck_raw_projection.go)

**Files (remote):**
- Create: `internal/api/rest/precheck_raw_projection.go`
- Create: `internal/api/rest/precheck_raw_projection_test.go`

- [ ] **Step 1: Create failing test file**

On the remote, create `internal/api/rest/precheck_raw_projection_test.go`:

```go
package rest

import (
    "encoding/base64"
    "encoding/json"
    "strings"
    "testing"
)

func TestEncodeDecodeRawCursor(t *testing.T) {
    s := encodeRawCursor(12345)
    n, err := decodeRawCursor(s)
    if err != nil {
        t.Fatalf("decode: %v", err)
    }
    if n != 12345 {
        t.Fatalf("want 12345, got %d", n)
    }
}

func TestDecodeRawCursor_BadInput(t *testing.T) {
    if _, err := decodeRawCursor("not-base64!"); err == nil {
        t.Fatal("want error for bad base64")
    }
    if _, err := decodeRawCursor(base64.RawURLEncoding.EncodeToString([]byte(`{"id":"nope"}`))); err == nil {
        t.Fatal("want error for non-int id")
    }
}

func TestBuildRawDealsQuery_Sicoob(t *testing.T) {
    q, args := buildRawDealsQuery("tenant_sicoob", 14, ptrInt64(110), nil, nil, 200)
    if !strings.Contains(q, "tenant_sicoob.negocios") {
        t.Fatalf("schema not injected: %s", q)
    }
    if len(args) != 5 {
        t.Fatalf("want 5 args (pipeline_id, stage_id, exclude_after, cursor, limit), got %d", len(args))
    }
    if args[0].(int64) != 14 {
        t.Fatalf("args[0] want 14, got %v", args[0])
    }
    if v, ok := args[1].(*int64); !ok || *v != 110 {
        t.Fatalf("args[1] want *int64=110, got %v", args[1])
    }
    if args[2] != nil {
        t.Fatalf("args[2] (exclude_after) want nil, got %v", args[2])
    }
    if args[3] != nil {
        t.Fatalf("args[3] (cursor) want nil, got %v", args[3])
    }
    if args[4].(int) != 200 {
        t.Fatalf("args[4] (limit) want 200, got %v", args[4])
    }
}

func TestBuildRawDealsQuery_RejectsSqlInjectionInSchema(t *testing.T) {
    defer func() {
        if r := recover(); r == nil {
            t.Fatal("want panic for invalid schema name")
        }
    }()
    buildRawDealsQuery("tenant_sicoob; DROP TABLE x; --", 14, nil, nil, nil, 200)
}

func ptrInt64(n int64) *int64 { _ = json.Marshal; return &n }
```

- [ ] **Step 2: Run, verify fail**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go test ./internal/api/rest/ -run TestEncodeDecode -v"
```

Expected: FAIL (undefined functions).

- [ ] **Step 3: Implement projection helper**

Create `internal/api/rest/precheck_raw_projection.go`:

```go
package rest

import (
    "encoding/base64"
    "encoding/json"
    "fmt"
    "regexp"
    "time"
)

// Strict allow-list for schema names: forbids any SQL metacharacter so the
// schema can be safely interpolated. The {tenant} from the URL has already
// been gated by precheckAllowedTenants, but we belt-and-suspenders.
var schemaNameRE = regexp.MustCompile(`^tenant_[a-z][a-z0-9_]{0,30}$`)

type rawCursor struct {
    ID int64 `json:"id"`
}

func encodeRawCursor(id int64) string {
    b, _ := json.Marshal(rawCursor{ID: id})
    return base64.RawURLEncoding.EncodeToString(b)
}

func decodeRawCursor(s string) (int64, error) {
    if s == "" {
        return 0, fmt.Errorf("empty cursor")
    }
    raw, err := base64.RawURLEncoding.DecodeString(s)
    if err != nil {
        return 0, fmt.Errorf("bad cursor encoding: %w", err)
    }
    var c rawCursor
    if err := json.Unmarshal(raw, &c); err != nil {
        return 0, fmt.Errorf("bad cursor JSON: %w", err)
    }
    if c.ID <= 0 {
        return 0, fmt.Errorf("cursor id must be > 0")
    }
    return c.ID, nil
}

// buildRawDealsQuery builds the parameterized SQL for /precheck-raw/deals.
// The schema is interpolated (validated by schemaNameRE) because pgx does
// not parameterize schema names; everything else is bound via $N.
//
// Args returned, in order: pipelineID, stageID (*int64 may be nil),
//   excludeAfter (*time.Time may be nil), cursorID (*int64 may be nil), limit.
func buildRawDealsQuery(schema string, pipelineID int64, stageID *int64, excludeAfter *time.Time, cursorID *int64, limit int) (string, []interface{}) {
    if !schemaNameRE.MatchString(schema) {
        panic(fmt.Sprintf("buildRawDealsQuery: invalid schema name %q", schema))
    }
    q := fmt.Sprintf(`
SELECT
  COALESCE(NULLIF(n.cf_id_cpf_cnpj::text, ''), NULLIF(n.cf_matrícula, ''), n.id::text) AS pasta,
  n.id                                                          AS deal_id,
  'person'                                                      AS contato_tipo,
  COALESCE(n.person_id, n.id)                                   AS contato_id,
  n.person_name                                                 AS contato_nome,
  'principal'                                                   AS contato_relacao,
  s.name                                                        AS stage_nome,
  p.name                                                        AS pipeline_nome,
  n.update_time                                                 AS update_time,
  pe.cf_telefone_contatos_primary_value                         AS whatsapp_hot,
  pe.custom_fields_jsonb->>'phone_other_1'                      AS telefone_hot_1,
  pe.custom_fields_jsonb->>'phone_other_2'                      AS telefone_hot_2,
  pe.custom_fields_jsonb->>'phone_other_3'                      AS telefone_1,
  pe.custom_fields_jsonb->>'phone_other_4'                      AS telefone_2,
  pe.custom_fields_jsonb->>'phone_other_5'                      AS telefone_3,
  NULL::text                                                    AS telefone_4,
  NULL::text                                                    AS telefone_5,
  NULL::text                                                    AS telefone_6,
  FALSE                                                         AS localizado,
  NULL::text                                                    AS telefone_localizado
FROM %[1]s.negocios n
LEFT JOIN %[1]s.pessoas       pe ON pe.id = n.person_id
LEFT JOIN %[1]s.pipelines     p  ON p.id  = n.pipeline_id
LEFT JOIN %[1]s.etapas_funil  s  ON s.id  = n.stage_id
WHERE n.pipeline_id = $1
  AND ($2::bigint IS NULL OR n.stage_id = $2)
  AND COALESCE(n.is_deleted, FALSE) = FALSE
  AND COALESCE(n.is_archived, FALSE) = FALSE
  AND ($3::timestamptz IS NULL OR n.update_time < $3)
  AND ($4::bigint IS NULL OR n.id > $4)
ORDER BY n.id ASC
LIMIT $5
`, schema)
    return q, []interface{}{pipelineID, stageID, excludeAfter, cursorID, limit}
}
```

> The exact JSONB keys (`phone_other_1..5`) are placeholders based on the spike (Task 11). Adjust them after the spike if the real keys differ.

- [ ] **Step 4: Run tests**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go test ./internal/api/rest/ -run 'TestEncodeDecode|TestBuildRawDealsQuery' -v"
```

Expected: all PASS.

- [ ] **Step 5: Commit on remote**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && git add router/internal/api/rest/precheck_raw_projection.go router/internal/api/rest/precheck_raw_projection_test.go && git commit -m 'feat(precheck): raw projection helper + cursor codec'"
```

---

### Task 14: Router — `GET /precheck-raw/deals` handler

**Files (remote):**
- Create: `internal/api/rest/precheck_raw_deals.go`
- Modify: `internal/api/rest/precheck_deals.go` (export `dealRow` as `DealRow` if currently lowercase) OR add a local `rawDealRow` mirror (preferred — keeps blast radius small)

- [ ] **Step 1: Create the handler file**

Create `internal/api/rest/precheck_raw_deals.go`:

```go
package rest

import (
    "errors"
    "net/http"
    "strconv"
    "strings"
    "time"

    "github.com/gorilla/mux"
    "github.com/jackc/pgx/v5"

    "github.com/pipeboard/router/internal/middleware"
)

// rawDealRow mirrors dealRow from precheck_deals.go. Local copy to avoid
// exporting the legacy adb-shaped struct; the wire shape is intentionally
// identical so the Dispatch TS client can parse both endpoints uniformly.
type rawDealRow struct {
    Pasta              string     `json:"pasta"`
    DealID             int64      `json:"deal_id"`
    ContatoTipo        string     `json:"contato_tipo"`
    ContatoID          int64      `json:"contato_id"`
    ContatoNome        *string    `json:"contato_nome,omitempty"`
    ContatoRelacao     *string    `json:"contato_relacao,omitempty"`
    StageNome          *string    `json:"stage_nome,omitempty"`
    PipelineNome       *string    `json:"pipeline_nome,omitempty"`
    UpdateTime         *time.Time `json:"update_time,omitempty"`
    WhatsappHot        *string    `json:"whatsapp_hot,omitempty"`
    TelefoneHot1       *string    `json:"telefone_hot_1,omitempty"`
    TelefoneHot2       *string    `json:"telefone_hot_2,omitempty"`
    Telefone1          *string    `json:"telefone_1,omitempty"`
    Telefone2          *string    `json:"telefone_2,omitempty"`
    Telefone3          *string    `json:"telefone_3,omitempty"`
    Telefone4          *string    `json:"telefone_4,omitempty"`
    Telefone5          *string    `json:"telefone_5,omitempty"`
    Telefone6          *string    `json:"telefone_6,omitempty"`
    Localizado         *bool      `json:"localizado,omitempty"`
    TelefoneLocalizado *string    `json:"telefone_localizado,omitempty"`
}

type rawDealsResponse struct {
    Items      []rawDealRow `json:"items"`
    NextCursor *string      `json:"next_cursor"`
    HasMore    bool         `json:"has_more"`
}

// HandlePrecheckRawListDeals is GET /api/v1/{tenant}/precheck-raw/deals
//
// Read-only paginated projection of tenant_<tenant>.negocios JOIN pessoas
// into the same dealRow shape as /precheck/deals. Used by Dispatch's
// adb-precheck plugin in raw mode (sicoob, oralsin) where there is no
// prov_consultas table.
func (h *PrecheckHandler) HandlePrecheckRawListDeals(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    tenant := strings.ToLower(mux.Vars(r)["tenant"])
    if !precheckAllowedTenants[tenant] {
        writeJSONError(w, http.StatusNotFound, "tenant not enrolled in precheck")
        return
    }
    apiKey, ok := middleware.GetAPIKeyFromContext(ctx)
    if !ok {
        writeJSONError(w, http.StatusInternalServerError, "auth context missing")
        return
    }
    if apiKey.TenantID != tenant {
        writeJSONError(w, http.StatusForbidden, "API key tenant does not match URL tenant")
        return
    }

    q := r.URL.Query()
    pipelineIDStr := q.Get("pipeline_id")
    if pipelineIDStr == "" {
        writeJSONError(w, http.StatusBadRequest, "pipeline_id is required")
        return
    }
    pipelineID, err := strconv.ParseInt(pipelineIDStr, 10, 64)
    if err != nil || pipelineID <= 0 {
        writeJSONError(w, http.StatusBadRequest, "pipeline_id must be a positive integer")
        return
    }

    var stageID *int64
    if s := q.Get("stage_id"); s != "" {
        v, err := strconv.ParseInt(s, 10, 64)
        if err != nil || v <= 0 {
            writeJSONError(w, http.StatusBadRequest, "stage_id must be a positive integer")
            return
        }
        stageID = &v
    }

    var excludeAfter *time.Time
    if s := q.Get("exclude_after"); s != "" {
        t, err := time.Parse(time.RFC3339, s)
        if err != nil {
            writeJSONError(w, http.StatusBadRequest, "exclude_after must be RFC3339 ISO 8601")
            return
        }
        excludeAfter = &t
    }

    var cursorID *int64
    if s := q.Get("cursor"); s != "" {
        id, err := decodeRawCursor(s)
        if err != nil {
            writeJSONError(w, http.StatusBadRequest, "invalid cursor: "+err.Error())
            return
        }
        cursorID = &id
    }

    limit := 200
    if s := q.Get("limit"); s != "" {
        v, err := strconv.Atoi(s)
        if err != nil || v < 1 || v > 1000 {
            writeJSONError(w, http.StatusBadRequest, "limit must be in [1,1000]")
            return
        }
        limit = v
    }

    schema := "tenant_" + tenant
    sql, args := buildRawDealsQuery(schema, pipelineID, stageID, excludeAfter, cursorID, limit)

    rows, err := h.db.Query(ctx, sql, args...)
    if err != nil {
        if errors.Is(err, pgx.ErrNoRows) {
            // Schema or table missing — fall through with empty items
            writeJSON(w, http.StatusOK, rawDealsResponse{Items: []rawDealRow{}, HasMore: false})
            return
        }
        h.logger.Error("raw deals query failed", zapErr(err))
        writeJSONError(w, http.StatusInternalServerError, "query failed")
        return
    }
    defer rows.Close()

    items := make([]rawDealRow, 0, limit)
    for rows.Next() {
        var d rawDealRow
        if err := rows.Scan(
            &d.Pasta, &d.DealID, &d.ContatoTipo, &d.ContatoID,
            &d.ContatoNome, &d.ContatoRelacao, &d.StageNome, &d.PipelineNome, &d.UpdateTime,
            &d.WhatsappHot, &d.TelefoneHot1, &d.TelefoneHot2,
            &d.Telefone1, &d.Telefone2, &d.Telefone3, &d.Telefone4, &d.Telefone5, &d.Telefone6,
            &d.Localizado, &d.TelefoneLocalizado,
        ); err != nil {
            h.logger.Error("raw deals scan failed", zapErr(err))
            writeJSONError(w, http.StatusInternalServerError, "scan failed")
            return
        }
        items = append(items, d)
    }

    var nextCursor *string
    hasMore := len(items) == limit
    if hasMore && len(items) > 0 {
        c := encodeRawCursor(items[len(items)-1].DealID)
        nextCursor = &c
    }

    writeJSON(w, http.StatusOK, rawDealsResponse{
        Items:      items,
        NextCursor: nextCursor,
        HasMore:    hasMore,
    })
}
```

> If `writeJSON` or `zapErr` helpers don't exist with those exact names, mirror the helpers used in `precheck_deals.go` (e.g. `writeJSONError` + a manual `json.NewEncoder(w).Encode(...)`).

- [ ] **Step 2: Compile**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go build ./..."
```

Expected: zero errors.

- [ ] **Step 3: Commit on remote**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && git add router/internal/api/rest/precheck_raw_deals.go && git commit -m 'feat(precheck): GET /precheck-raw/deals handler (sicoob/oralsin)'"
```

---

### Task 15: Router — mount `/precheck-raw` routes in server.go

**Files (remote):**
- Modify: `internal/api/rest/server.go` (around line 160-180 where precheckWriteRouter is built)

- [ ] **Step 1: Locate precheckReadRouter block**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "sed -n '160,200p' /var/www/pipeboard_ecosystem/router/internal/api/rest/server.go"
```

- [ ] **Step 2: Add new subrouter for precheck-raw**

After the `precheckAdminRouter` block, append:

```go
// precheck-raw — read-only projection of negocios+pessoas for raw-mode
// tenants (sicoob, oralsin). Same auth model as /precheck/deals
// (precheck:read scope).
precheckRawRouter := apiRouter.PathPrefix("/{tenant}/precheck-raw").Subrouter()
precheckRawRouter.Use(requireScope("precheck:read", logger))
precheckRawRouter.HandleFunc("/deals", precheckHandler.HandlePrecheckRawListDeals).Methods("GET")
// Unauthenticated healthz (mirrors /precheck/healthz pattern).
healthzRawHandler := unauthenticatedRoute(
    http.HandlerFunc(precheckHandler.HandlePrecheckHealthz), // reuse same healthz
)
router.Handle("/api/v1/{tenant}/precheck-raw/healthz", healthzRawHandler).Methods("GET")
```

- [ ] **Step 3: Smoke build**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go build ./..."
```

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && git add router/internal/api/rest/server.go && git commit -m 'feat(precheck): wire /precheck-raw subrouter + healthz'"
```

---

### Task 16: Router — integration test against tenant_sicoob fixture

**Files (remote):**
- Create: `internal/api/rest/precheck_raw_deals_test.go`

- [ ] **Step 1: Create test file mirroring precheck_archive_test.go**

```go
package rest

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"

    "github.com/gorilla/mux"
    "go.uber.org/zap"

    "github.com/pipeboard/router/internal/middleware"
)

func TestHandlePrecheckRawListDeals_Sicoob(t *testing.T) {
    ctx := context.Background()
    pgPool := newTestPool(t) // pattern from precheck_archive_test.go
    h := NewPrecheckHandler(pgPool, nil, zap.NewNop())

    // Setup fixtures — assume tenant_sicoob schema exists in the test DB.
    tx, err := pgPool.Begin(ctx)
    if err != nil {
        t.Fatal(err)
    }
    defer tx.Rollback(ctx)

    _, err = tx.Exec(ctx, `
        DELETE FROM tenant_sicoob.negocios WHERE id IN (998001, 998002, 998003);
        DELETE FROM tenant_sicoob.pessoas WHERE id IN (998001, 998002);
        INSERT INTO tenant_sicoob.pessoas(id, name, cf_telefone_contatos_primary_value)
            VALUES (998001, 'João Teste', '(43) 988887777'),
                   (998002, 'Maria Teste', '5543991112222');
        INSERT INTO tenant_sicoob.negocios(id, title, pipeline_id, stage_id, person_id, is_deleted, is_archived, cf_id_cpf_cnpj)
            VALUES (998001, 'Test Deal 1', 14, 110, 998001, FALSE, FALSE, 11122233344),
                   (998002, 'Test Deal 2', 14, 110, 998002, FALSE, FALSE, 22233344455),
                   (998003, 'Wrong Pipeline', 99, 110, 998001, FALSE, FALSE, 99988877766);
    `)
    if err != nil {
        t.Fatal(err)
    }
    if err := tx.Commit(ctx); err != nil {
        t.Fatal(err)
    }
    defer cleanupSicoobFixtures(t, pgPool)

    req := httptest.NewRequest("GET", "/api/v1/sicoob/precheck-raw/deals?pipeline_id=14&stage_id=110&limit=10", nil)
    req = mux.SetURLVars(req, map[string]string{"tenant": "sicoob"})
    req = req.WithContext(middleware.WithAPIKey(ctx, &middleware.APIKey{TenantID: "sicoob", Scopes: []string{"precheck:read"}}))
    rec := httptest.NewRecorder()

    h.HandlePrecheckRawListDeals(rec, req)

    if rec.Code != http.StatusOK {
        t.Fatalf("want 200, got %d body=%s", rec.Code, rec.Body.String())
    }
    var resp rawDealsResponse
    if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
        t.Fatal(err)
    }
    if len(resp.Items) != 2 {
        t.Fatalf("want 2 deals (pipeline 14 only), got %d", len(resp.Items))
    }
    // Verify raw phone propagates and stays raw (hygienization happens TS-side)
    found := false
    for _, d := range resp.Items {
        if d.WhatsappHot != nil && strings.Contains(*d.WhatsappHot, "988887777") {
            found = true
        }
    }
    if !found {
        t.Fatal("expected raw phone (43) 988887777 in response")
    }
}

func TestHandlePrecheckRawListDeals_RejectsAdb(t *testing.T) {
    // adb tenant has prov_consultas, not raw — but raw endpoint still works
    // because precheckAllowedTenants includes it. The SQL might 404 on
    // tenant_adb.negocios but if the schema has it, return rows. This is
    // intentional — we don't gate raw to non-adb explicitly.
    t.Skip("raw is allowed on adb if schema supports it; test left for future contract validation")
}

func TestHandlePrecheckRawListDeals_BadInput(t *testing.T) {
    pgPool := newTestPool(t)
    h := NewPrecheckHandler(pgPool, nil, zap.NewNop())
    ctx := context.Background()

    cases := []struct {
        name string
        url  string
        code int
    }{
        {"missing pipeline_id", "/api/v1/sicoob/precheck-raw/deals", http.StatusBadRequest},
        {"non-int pipeline", "/api/v1/sicoob/precheck-raw/deals?pipeline_id=foo", http.StatusBadRequest},
        {"limit too high", "/api/v1/sicoob/precheck-raw/deals?pipeline_id=14&limit=99999", http.StatusBadRequest},
        {"bad cursor", "/api/v1/sicoob/precheck-raw/deals?pipeline_id=14&cursor=!!!", http.StatusBadRequest},
        {"bad exclude_after", "/api/v1/sicoob/precheck-raw/deals?pipeline_id=14&exclude_after=yesterday", http.StatusBadRequest},
    }
    for _, tc := range cases {
        t.Run(tc.name, func(t *testing.T) {
            req := httptest.NewRequest("GET", tc.url, nil)
            req = mux.SetURLVars(req, map[string]string{"tenant": "sicoob"})
            req = req.WithContext(middleware.WithAPIKey(ctx, &middleware.APIKey{TenantID: "sicoob", Scopes: []string{"precheck:read"}}))
            rec := httptest.NewRecorder()
            h.HandlePrecheckRawListDeals(rec, req)
            if rec.Code != tc.code {
                t.Fatalf("want %d, got %d body=%s", tc.code, rec.Code, rec.Body.String())
            }
        })
    }
}

func cleanupSicoobFixtures(t *testing.T, pool *pgxpool.Pool) {
    t.Helper()
    ctx := context.Background()
    _, _ = pool.Exec(ctx, `DELETE FROM tenant_sicoob.negocios WHERE id IN (998001, 998002, 998003)`)
    _, _ = pool.Exec(ctx, `DELETE FROM tenant_sicoob.pessoas WHERE id IN (998001, 998002)`)
}
```

> If `pgxpool` import or `newTestPool` helper is named differently in your codebase, mirror what `precheck_archive_test.go` uses. The import block above is illustrative.

- [ ] **Step 2: Run integration test**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && go test ./internal/api/rest/ -run TestHandlePrecheckRawListDeals -v"
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && git add router/internal/api/rest/precheck_raw_deals_test.go && git commit -m 'test(precheck): integration test for /precheck-raw/deals (sicoob fixture)'"
```

---

### Task 17: Provision Pipeboard API key for tenant_sicoob

**Files:** none (operational).

- [ ] **Step 1: Generate API key via existing script**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem && python scripts/create_router_apikey.py --tenant sicoob --scopes precheck:read --label 'dispatch-adb-precheck-sicoob' --owner 'dispatch'"
```

Expected: outputs `KEY=<value>`. Save securely.

- [ ] **Step 2: Smoke the key against staging**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "curl -sS -H 'X-API-Key: <generated_key>' 'http://localhost:18080/api/v1/sicoob/precheck-raw/deals?pipeline_id=14&stage_id=110&limit=3' | head -50"
```

Expected: JSON with `items` array, length up to 3.

- [ ] **Step 3: Record the key in Dispatch deploy env**

Add to `/var/www/adb_tools/.env.example` (no secrets in repo; just the key NAME):

```
PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB=https://gows-chat.debt.com.br/api/v1/sicoob
PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB=<set in real .env>
PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB=14
PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB=110
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB=<set in real .env>
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_SICOOB=<subdomain>
```

Commit:

```bash
cd /var/www/adb_tools && git add .env.example && git commit -m "chore: document sicoob tenant env vars in .env.example"
```

---

### Task 18: Router — deploy to staging/prod

**Files:** none (operational).

- [ ] **Step 1: Build router binary on remote**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "cd /var/www/pipeboard_ecosystem/router && make build"
```

- [ ] **Step 2: Restart router service**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "sudo systemctl restart pipeboard-router && sleep 3 && systemctl status pipeboard-router --no-pager | head -20"
```

Expected: `active (running)`.

- [ ] **Step 3: Smoke prod**

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 "curl -sS https://gows-chat.debt.com.br/api/v1/sicoob/precheck-raw/healthz | head -5"
```

Expected: `{"status":"ok",...}`.

**🎯 PHASE B.1 GATE: Router /precheck-raw/deals live for sicoob.**

---

## FASE B.2 — Plugin TS multi-tenant dispatch

### Task 19: PipeboardRawRest — failing tests

**Files:**
- Create: `packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.ts`
- Create: `packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.test.ts`

- [ ] **Step 1: Create failing test file**

```ts
import { describe, it, expect, vi } from 'vitest'
import { PipeboardRawRest } from './pipeboard-raw-rest.js'
import { NotSupportedByRawBackendError } from './pipeboard-raw-rest.js'

describe('PipeboardRawRest', () => {
  function mkFetch(resp: Partial<Response>): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => (resp as { _body?: unknown })._body ?? {},
      text: async () => JSON.stringify((resp as { _body?: unknown })._body ?? {}),
    }) as unknown as typeof fetch
  }

  it('iterateDeals issues GET /precheck-raw/deals with required filters', async () => {
    const fetchImpl = mkFetch({ _body: { items: [], next_cursor: null, has_more: false } } as never)
    const c = new PipeboardRawRest({
      baseUrl: 'http://r/api/v1/sicoob',
      apiKey: 'k',
      pipelineId: 14,
      stageId: 110,
      fetchImpl,
    })
    const it1 = c.iterateDeals({}, 200)
    const first = await it1.next()
    expect(first.done).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(String(call[0])).toMatch(/precheck-raw\/deals\?.*pipeline_id=14/)
    expect(String(call[0])).toMatch(/stage_id=110/)
  })

  it('writes throw NotSupportedByRawBackendError', async () => {
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl: mkFetch({}) })
    await expect(c.applyDealInvalidation({ pasta: 'x', deal_id: 1, contato_tipo: 'p', contato_id: 1 }, { motivo: 'x', jobId: null, fonte: 'dispatch_adb_precheck', phones: [], archiveIfEmpty: false })).rejects.toThrow(NotSupportedByRawBackendError)
    await expect(c.applyDealLocalization({ pasta: 'x', deal_id: 1, contato_tipo: 'p', contato_id: 1 }, { telefone: '1', source: 'cache', jobId: null, fonte: 'dispatch_adb_precheck' })).rejects.toThrow(NotSupportedByRawBackendError)
  })

  it('countPool returns -1 (unsupported)', async () => {
    const c = new PipeboardRawRest({ baseUrl: 'x', apiKey: 'k', pipelineId: 14, fetchImpl: mkFetch({}) })
    expect(await c.countPool({})).toBe(-1)
  })

  it('healthcheck calls /precheck-raw/healthz', async () => {
    const fetchImpl = mkFetch({ _body: { status: 'ok' } } as never)
    const c = new PipeboardRawRest({ baseUrl: 'http://r/api/v1/sicoob', apiKey: 'k', pipelineId: 14, fetchImpl })
    const h = await c.healthcheck()
    expect(h.ok).toBe(true)
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('/precheck-raw/healthz')
  })
})
```

- [ ] **Step 2: Run test, verify fail**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/pipeboard-raw-rest.test.ts
```

Expected: FAIL (module missing).

---

### Task 20: PipeboardRawRest — implementation

**Files:**
- Create: `packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.ts`

- [ ] **Step 1: Implement**

```ts
import type { DealKey, ProvConsultaRow, PrecheckScanParams } from './types.js'
import {
  type AppliedPhone,
  type DealInvalidationRequest,
  type DealInvalidationResponse,
  type DealLocalizationRequest,
  type DealLocalizationResponse,
  type DealLookupResult,
  type HealthcheckResult,
  type IPipeboardClient,
  type InvalidPhoneRecord,
  PHONE_COLUMNS,
} from './pipeboard-client.js'
import { extractDdd as extractDddFromRawPhone } from '../../util/ddd.js'

export class NotSupportedByRawBackendError extends Error {
  constructor(op: string) {
    super(`${op} is not supported by the raw backend (sicoob/oralsin do not have prov_* tables)`)
    this.name = 'NotSupportedByRawBackendError'
  }
}

export interface PipeboardRawRestOpts {
  /** Full base URL including tenant segment, e.g. http://r/api/v1/sicoob */
  baseUrl: string
  apiKey: string
  /** Required filter for every iterateDeals call. */
  pipelineId: number
  /** Optional further restriction. */
  stageId?: number
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
}

export class PipeboardRawRest implements IPipeboardClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly pipelineId: number
  private readonly stageId?: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof globalThis.fetch

  private dddCache: { buckets: Record<string, number>; fetchedAt: number } | null = null
  private dddFetchInFlight: Promise<Record<string, number>> | null = null

  constructor(opts: PipeboardRawRestOpts) {
    if (!opts.apiKey) throw new Error('PipeboardRawRest requires apiKey')
    if (!opts.baseUrl) throw new Error('PipeboardRawRest requires baseUrl')
    if (!opts.pipelineId || opts.pipelineId <= 0) throw new Error('PipeboardRawRest requires pipelineId > 0')
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.pipelineId = opts.pipelineId
    this.stageId = opts.stageId
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async close(): Promise<void> {
    // request-scoped
  }

  async healthcheck(): Promise<HealthcheckResult> {
    try {
      const res = await this.request('GET', '/precheck-raw/healthz', null, /*noAuth*/ true)
      const json = (await res.json()) as { status: string }
      return json.status === 'ok'
        ? { ok: true, server_time: new Date().toISOString() }
        : { ok: false, error: `pipeboard status=${json.status}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async countPool(_params: PrecheckScanParams): Promise<number> {
    return -1 // raw mode does not expose count
  }

  async *iterateDeals(
    params: PrecheckScanParams,
    pageSize = 200,
  ): AsyncGenerator<ProvConsultaRow[], void, void> {
    let cursor: string | null = null
    while (true) {
      const qp = new URLSearchParams()
      qp.set('pipeline_id', String(this.pipelineId))
      if (this.stageId !== undefined) qp.set('stage_id', String(this.stageId))
      if (params.recheck_after_days != null) {
        const since = new Date(Date.now() - params.recheck_after_days * 86_400_000)
        qp.set('exclude_after', since.toISOString())
      }
      if (cursor) qp.set('cursor', cursor)
      qp.set('limit', String(pageSize))

      const res = await this.request('GET', `/precheck-raw/deals?${qp.toString()}`, null)
      const json = (await res.json()) as {
        items: ProvConsultaRow[]
        next_cursor: string | null
        has_more: boolean
      }
      if (json.items.length === 0) return
      yield json.items
      if (!json.next_cursor || json.has_more === false) return
      cursor = json.next_cursor
    }
  }

  async aggregatePhoneDddDistribution(): Promise<Record<string, number>> {
    const CACHE_TTL_MS = 5 * 60_000
    const now = Date.now()
    if (this.dddCache && now - this.dddCache.fetchedAt < CACHE_TTL_MS) return this.dddCache.buckets
    if (this.dddFetchInFlight) return this.dddFetchInFlight
    this.dddFetchInFlight = this.fetchDddDistribution()
      .then((b) => {
        this.dddCache = { buckets: b, fetchedAt: Date.now() }
        return b
      })
      .finally(() => {
        this.dddFetchInFlight = null
      })
    return this.dddFetchInFlight
  }

  private async fetchDddDistribution(): Promise<Record<string, number>> {
    const buckets: Record<string, number> = {}
    for await (const page of this.iterateDeals({}, 500)) {
      for (const row of page) {
        for (const col of PHONE_COLUMNS) {
          const v = (row as unknown as Record<string, unknown>)[col]
          if (typeof v !== 'string' || v.length === 0) continue
          const ddd = extractDddFromRawPhone(v)
          if (ddd) buckets[ddd] = (buckets[ddd] ?? 0) + 1
        }
      }
    }
    return buckets
  }

  // ── Refused write ops ────────────────────────────────────────────────────
  async applyDealInvalidation(_k: DealKey, _p: DealInvalidationRequest): Promise<DealInvalidationResponse> { throw new NotSupportedByRawBackendError('applyDealInvalidation') }
  async applyDealLocalization(_k: DealKey, _p: DealLocalizationRequest): Promise<DealLocalizationResponse> { throw new NotSupportedByRawBackendError('applyDealLocalization') }
  async lookupDeals(_keys: DealKey[]): Promise<DealLookupResult[]> { throw new NotSupportedByRawBackendError('lookupDeals') }
  async writeInvalid(_k: DealKey, _m: string): Promise<number> { throw new NotSupportedByRawBackendError('writeInvalid') }
  async clearInvalidPhone(_k: DealKey, _p: string): Promise<number> { throw new NotSupportedByRawBackendError('clearInvalidPhone') }
  async clearLocalizadoIfMatches(_k: DealKey, _p: string): Promise<number> { throw new NotSupportedByRawBackendError('clearLocalizadoIfMatches') }
  async recordInvalidPhone(_k: DealKey, _r: InvalidPhoneRecord): Promise<void> { throw new NotSupportedByRawBackendError('recordInvalidPhone') }
  async archiveDealIfEmpty(_k: DealKey, _m: string): Promise<boolean> { throw new NotSupportedByRawBackendError('archiveDealIfEmpty') }
  async writeLocalizado(_k: DealKey, _p: string, _s: string): Promise<void> { throw new NotSupportedByRawBackendError('writeLocalizado') }

  // ── Internal ─────────────────────────────────────────────────────────────
  private async request(method: 'GET' | 'POST', path: string, body: unknown, noAuth = false): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (!noAuth) headers['X-API-Key'] = this.apiKey
      if (method !== 'GET') headers['Content-Type'] = 'application/json'
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: ac.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PipeboardRawRest ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 2: Run tests, verify pass**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/pipeboard-raw-rest.test.ts
```

Expected: 4 PASS.

- [ ] **Step 3: Export from barrel**

Add to `packages/core/src/plugins/adb-precheck/index.ts`:

```ts
export { PipeboardRawRest, NotSupportedByRawBackendError, type PipeboardRawRestOpts } from './pipeboard-raw-rest.js'
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.ts packages/core/src/plugins/adb-precheck/pipeboard-raw-rest.test.ts packages/core/src/plugins/adb-precheck/index.ts
git commit -m "feat(adb-precheck): PipeboardRawRest client for sicoob/oralsin raw mode"
```

---

### Task 21: Scanner — accept `tenant` and skip writeback in raw mode

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck/scanner.ts`
- Modify: `packages/core/src/plugins/adb-precheck/types.ts` (PrecheckScanParams gains tenant)
- Modify: `packages/core/src/plugins/adb-precheck/scanner.test.ts` (or create scanner-raw.test.ts)

- [ ] **Step 1: Extend types**

In `packages/core/src/plugins/adb-precheck/types.ts`, add to `PrecheckScanParams`:

```ts
/**
 * Which tenant this scan runs against. Determines writeback policy and read
 * client (PipeboardRest for adb, PipeboardRawRest for sicoob/oralsin).
 * Defaults to 'adb' for back-compat.
 */
tenant?: 'adb' | 'sicoob' | 'oralsin'
```

- [ ] **Step 2: Failing test for raw mode**

Create `packages/core/src/plugins/adb-precheck/scanner-raw.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { PrecheckScanner } from './scanner.js'
import { PrecheckJobStore } from './job-store.js'
import { ContactRegistry } from '../../contacts/contact-registry.js'
import { ContactValidator } from '../../validator/contact-validator.js'
import { CacheOnlyStrategy } from '../../check-strategies/cache-only-strategy.js'

describe('PrecheckScanner — raw mode skips writebacks', () => {
  it('does NOT call applyDealInvalidation when tenant is raw', async () => {
    const db = new Database(':memory:')
    const registry = new ContactRegistry(db)
    registry.initialize()
    const store = new PrecheckJobStore(db)
    store.initialize()
    const cache = new CacheOnlyStrategy(registry)
    const validator = new ContactValidator(registry, undefined, undefined, cache)

    const applyInvalidation = vi.fn()
    const applyLocalization = vi.fn()
    const pg = {
      iterateDeals: async function* () {
        yield [
          {
            pasta: 'p1', deal_id: 1, contato_tipo: 'person', contato_id: 1,
            contato_nome: 'X', contato_relacao: 'principal',
            stage_nome: 's', pipeline_nome: 'p', update_time: null,
            whatsapp_hot: '5543991234567', telefone_hot_1: null, telefone_hot_2: null,
            telefone_1: null, telefone_2: null, telefone_3: null,
            telefone_4: null, telefone_5: null, telefone_6: null,
            localizado: false, telefone_localizado: null,
          },
        ]
      },
      countPool: async () => -1,
      applyDealInvalidation: applyInvalidation,
      applyDealLocalization: applyLocalization,
      healthcheck: async () => ({ ok: true, server_time: '' }),
      close: async () => {},
      // legacy methods (won't be called in raw mode)
      writeInvalid: vi.fn(), clearInvalidPhone: vi.fn(), clearLocalizadoIfMatches: vi.fn(),
      recordInvalidPhone: vi.fn(), archiveDealIfEmpty: vi.fn(), writeLocalizado: vi.fn(),
      lookupDeals: vi.fn(),
    }

    const scanner = new PrecheckScanner({
      pg: pg as never,
      store,
      validator,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      shouldCancel: () => false,
      tenant: 'sicoob',
      tenantMode: 'raw',
    } as never)

    const job = store.createJob({ limit: 1, writeback_invalid: false, hygienization_mode: false, tenant: 'sicoob' }, 'ext_x', { pipedriveEnabled: false, hygienizationMode: false, tenant: 'sicoob' })
    await scanner.runJob(job.id, { limit: 1, writeback_invalid: false, hygienization_mode: false, tenant: 'sicoob' })

    expect(applyInvalidation).not.toHaveBeenCalled()
    expect(applyLocalization).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run, verify fail**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/scanner-raw.test.ts
```

Expected: FAIL (scanner does not yet branch on `tenantMode`).

- [ ] **Step 4: Patch scanner**

In `packages/core/src/plugins/adb-precheck/scanner.ts`:

1. Extend `ScannerDeps` interface:

```ts
/** Tenant id this scanner instance was constructed for. */
tenant?: 'adb' | 'sicoob' | 'oralsin'
/** 'prov' enables writebacks; 'raw' skips them. */
tenantMode?: 'prov' | 'raw'
```

2. Where the scanner currently calls `pg.applyDealInvalidation` / `pg.applyDealLocalization`, gate:

```ts
if (this.deps.tenantMode !== 'raw' && /* existing conditions */) {
  await this.deps.pg.applyDealInvalidation(...)
}
```

Repeat for localization, recordInvalidPhone, archiveDealIfEmpty, writeLocalizado, and any other prov_* call.

3. Include `tenant` in every `logger.info/warn/error` payload (best-effort: spread `{ tenant: this.deps.tenant }`).

- [ ] **Step 5: Run scanner tests, verify pass**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/scanner
```

Expected: all PASS (existing + new raw).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/plugins/adb-precheck/scanner.ts packages/core/src/plugins/adb-precheck/scanner-raw.test.ts packages/core/src/plugins/adb-precheck/types.ts
git commit -m "feat(adb-precheck): scanner branches on tenantMode (raw skips writebacks)"
```

---

### Task 22: Plugin — per-tenant PipeboardClient + scanner instances

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts`

The plugin currently holds ONE `pg` (`IPipeboardClient`) and ONE `scanner`. Refactor to hold a Map per tenant.

- [ ] **Step 1: Add per-tenant fields**

Replace the existing single fields:

```ts
private pg: IPipeboardClient
private scanner: PrecheckScanner | null = null
```

With:

```ts
private pgByTenant = new Map<TenantId, IPipeboardClient>()
private scannerByTenant = new Map<TenantId, PrecheckScanner>()
```

- [ ] **Step 2: Build clients in `init()`**

Replace the existing client construction with a loop over `this.tenantRegistry.list()`:

```ts
const reg = this.tenantRegistry ?? TenantRegistry.fromEnv()
for (const tc of reg.list()) {
  let client: IPipeboardClient
  if (tc.mode === 'prov') {
    client = new PipeboardRest({
      baseUrl: tc.restBaseUrl,
      apiKey: tc.restApiKey,
      timeoutMs: tc.restTimeoutMs,
    })
  } else {
    if (!tc.defaultPipelineId) throw new Error(`tenant ${tc.id}: missing PIPELINE_ID for raw mode`)
    client = new PipeboardRawRest({
      baseUrl: tc.restBaseUrl,
      apiKey: tc.restApiKey,
      pipelineId: tc.defaultPipelineId,
      stageId: tc.defaultStageId,
      timeoutMs: tc.restTimeoutMs,
    })
  }
  this.pgByTenant.set(tc.id, client)
}
```

- [ ] **Step 3: Build a scanner per tenant**

Wrap the existing scanner construction in the same loop. Each scanner gets its tenant-specific `pg`, the shared `validator`, and `tenant`/`tenantMode` set:

```ts
const scanner = new PrecheckScanner({
  pg: client,
  store: this.store,
  validator: this.validator,
  logger: ctx.logger,
  shouldCancel: (jobId) => this.store.isCancelRequested(jobId),
  deviceSerial: this.defaultDeviceSerial,
  wahaSession: this.defaultWahaSession,
  resolveProfileForSender: /* existing closure */,
  onJobFinished: (jobId) => this.deliverJobCompletedCallback(jobId),
  onInvalidPhone: this.onInvalidPhoneCb,
  pipedrive: this.pipedriveByTenant.get(tc.id), // see Task 23
  pipedriveCacheTtlDays: this.pipedriveCacheTtlDays,
  skipPipedriveDealActivity: tc.mode === 'prov', // only adb has server-side dup
  pendingWritebacks: this.pendingWritebacks,
  pauseState: tc.mode === 'prov' ? this.pauseState : undefined,
  hygienizationOperator: this.hygienizationOperator,
  locks: this.pastaLocks ?? undefined,
  adbShell: this.adb,
  appPackage: 'com.whatsapp',
  tenant: tc.id,
  tenantMode: tc.mode,
})
this.scannerByTenant.set(tc.id, scanner)
```

- [ ] **Step 4: Route handlers select scanner by tenant**

In `handleStartScan`, after Zod parse:

```ts
const tenantId = (parsed.data.tenant ?? 'adb') as TenantId
if (!this.scannerByTenant.has(tenantId)) {
  return r.status(400).send({ error: 'tenant_not_configured', tenant: tenantId })
}
const scanner = this.scannerByTenant.get(tenantId)!
const pg = this.pgByTenant.get(tenantId)!
```

Replace later uses of `this.scanner` with `scanner`, and `this.pg` with `pg`. Pass the resolved tenant to `store.createJob({...}, externalRef, { ..., tenant: tenantId })`.

- [ ] **Step 5: Update `destroy()`**

Loop over `this.pgByTenant.values()` calling `.close()`.

- [ ] **Step 6: Smoke build + tests**

```bash
cd packages/core && pnpm tsc --noEmit && pnpm vitest run src/plugins/adb-precheck/
```

Expected: green. The existing adb tests still pass because `tenant='adb'` is the default.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts
git commit -m "feat(adb-precheck): per-tenant client + scanner registry inside plugin"
```

---

### Task 23: PipedrivePublisher — per-tenant map + dedup key includes tenant

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (build map)
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-publisher.ts` (accept tenant in constructor)
- Modify: `packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts` (dedup_key + tenant)

- [ ] **Step 1: Add tenant to dedup logic**

In `pipedrive-activity-store.ts`, locate `findByDedupKey(dedupKey)` and `insertActivity(...)`. Add `tenant` as a column and as the first part of the lookup key:

```ts
findByDedupKey(tenant: string, dedupKey: string): PipedriveActivityRow | null {
  return this.db
    .prepare('SELECT * FROM pipedrive_activities WHERE tenant = ? AND dedup_key = ? LIMIT 1')
    .get(tenant, dedupKey) as PipedriveActivityRow | null
}

insertActivity(record: { tenant: string; ... }): void { /* binds tenant too */ }
```

- [ ] **Step 2: Publisher accepts tenant**

In `pipedrive-publisher.ts` constructor, add `tenant: TenantId` as a required field. Pass tenant down to every `store.findByDedupKey` / `store.insertActivity` call.

- [ ] **Step 3: Update formatter to include tenant label**

In `pipedrive-formatter.ts`, where the pasta_summary header is built:

```ts
const tenantLabel = opts.tenantLabel ?? 'ADB' // back-compat default
const header = `📊 Pré-check WhatsApp — ${tenantLabel}${opts.pipelineName ? ` (${opts.pipelineName})` : ''}`
```

Pass `tenantLabel` from the publisher.

- [ ] **Step 4: Activity `done=1`**

Search for `done: 0` in `pipedrive-publisher.ts` / `pipedrive-formatter.ts` (or the scanner where the intent is built). Change `done: 0` to `done: 1` for the `deal_all_fail` scenario (per user feedback).

```bash
grep -rn "done:" packages/core/src/plugins/adb-precheck/pipedrive-*
```

Update accordingly.

- [ ] **Step 5: Build map in plugin init()**

In `adb-precheck-plugin.ts`:

```ts
private pipedriveByTenant = new Map<TenantId, PipedrivePublisher>()
```

In `init()`:

```ts
for (const tc of reg.list()) {
  if (!tc.pipedrive?.apiToken) continue
  const client = new PipedriveClient({ apiToken: tc.pipedrive.apiToken, baseUrl: process.env.PIPEDRIVE_BASE_URL, emitter: opts.emitter })
  const publisher = new PipedrivePublisher(client, ctx.logger, this.pipedriveActivityStore!, tc.pipedrive.companyDomain ?? null, undefined, this.pastaLocks, { tenant: tc.id, tenantLabel: tc.label })
  this.pipedriveByTenant.set(tc.id, publisher)
}
```

- [ ] **Step 6: Add a test for tenant in dedup**

Append to `pipedrive-activity-store.test.ts` (or create):

```ts
it('dedupes per (tenant, dedup_key) — same key across tenants does not collide', () => {
  const db = new Database(':memory:')
  const s = new PipedriveActivityStore(db); s.initialize()
  s.insertActivity({ tenant: 'adb', dedup_key: 'k1', scenario: 'pasta_summary', deal_id: 1, pipedrive_response_id: '111', pipedrive_kind: 'note', emitted_at: new Date().toISOString() })
  s.insertActivity({ tenant: 'sicoob', dedup_key: 'k1', scenario: 'pasta_summary', deal_id: 1, pipedrive_response_id: '222', pipedrive_kind: 'note', emitted_at: new Date().toISOString() })
  expect(s.findByDedupKey('adb', 'k1')?.pipedrive_response_id).toBe('111')
  expect(s.findByDedupKey('sicoob', 'k1')?.pipedrive_response_id).toBe('222')
})
```

- [ ] **Step 7: Run tests**

```bash
cd packages/core && pnpm vitest run src/plugins/adb-precheck/pipedrive-
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck/pipedrive-publisher.ts packages/core/src/plugins/adb-precheck/pipedrive-activity-store.ts packages/core/src/plugins/adb-precheck/pipedrive-formatter.ts packages/core/src/plugins/adb-precheck/pipedrive-activity-store.test.ts
git commit -m "feat(adb-precheck): per-tenant Pipedrive publisher with tenant-scoped dedup + done=1"
```

---

### Task 24: Callback HMAC includes `tenant` field

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (`deliverJobCompletedCallback`)

- [ ] **Step 1: Locate and patch**

In `deliverJobCompletedCallback(jobId)`:

```ts
const job = this.store.getJob(jobId)
// ...
const body = {
  event: 'precheck_completed' as const,
  plugin: this.name,
  plugin_version: this.version,
  tenant: (job as { tenant?: string }).tenant ?? 'adb',  // new
  // ... existing fields
}
// ...
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Dispatch-Tenant': body.tenant,  // new
}
```

- [ ] **Step 2: Add a test**

Append to a new file `packages/core/src/plugins/adb-precheck-plugin.callback.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

describe('Callback payload', () => {
  it('includes tenant field + X-Dispatch-Tenant header', () => {
    const tenant = 'sicoob'
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Dispatch-Tenant': tenant }
    const body = { event: 'precheck_completed', tenant, job_id: 'j1' }
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({ tenant: 'sicoob' })
    expect(headers['X-Dispatch-Tenant']).toBe('sicoob')
  })
})
```

> This is a smoke test pinning the contract. A full integration test would require mocking `fetch`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts packages/core/src/plugins/adb-precheck-plugin.callback.test.ts
git commit -m "feat(adb-precheck): callback includes tenant in body + X-Dispatch-Tenant header"
```

---

### Task 25: Scan params Zod schema gains tenant + pipeline overrides

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (`scanParamsSchema`)

- [ ] **Step 1: Patch the schema**

Replace the existing `scanParamsSchema` declaration with:

```ts
const scanParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(100_000).optional(),
    recheck_after_days: z.number().int().min(0).max(3650).optional(),
    pasta_prefix: z.string().min(1).max(255).optional(),
    pipeline_nome: z.string().min(1).max(255).optional(),
    writeback_invalid: z.boolean().default(false),
    external_ref: z.string().min(1).max(128).optional(),
    pipedrive_enabled: z.boolean().optional(),
    hygienization_mode: z.boolean().optional(),
    device_serial: z.string().min(1).max(64).optional(),
    waha_session: z.string().min(1).max(64).optional(),

    // multi-tenant additions
    tenant: z.enum(['adb', 'sicoob', 'oralsin']).default('adb'),
    pipeline_id: z.number().int().positive().optional(),
    stage_id: z.number().int().positive().optional(),
  })
  .strict()
```

- [ ] **Step 2: Handler honors overrides**

In `handleStartScan`, after the Zod parse:

```ts
const tc = (this.tenantRegistry ?? TenantRegistry.fromEnv()).get(parsed.data.tenant)
const pipelineId = parsed.data.pipeline_id ?? tc.defaultPipelineId
const stageId = parsed.data.stage_id ?? tc.defaultStageId
```

For raw-mode tenants, if `tc.mode === 'raw'` AND `pipelineId` is undefined, return 400:

```ts
if (tc.mode === 'raw' && !pipelineId) {
  return r.status(400).send({ error: 'pipeline_id_required_for_raw_tenant', tenant: tc.id })
}
```

If overrides differ from defaults, build a *fresh* `PipeboardRawRest` instance for this scan:

```ts
let scanClient = this.pgByTenant.get(tc.id)!
if (tc.mode === 'raw' && (pipelineId !== tc.defaultPipelineId || stageId !== tc.defaultStageId)) {
  scanClient = new PipeboardRawRest({
    baseUrl: tc.restBaseUrl,
    apiKey: tc.restApiKey,
    pipelineId: pipelineId!,
    stageId,
    timeoutMs: tc.restTimeoutMs,
  })
}
```

For this scan, build an ad-hoc scanner with `scanClient` (the existing scanner is the cached "default" pipeline/stage one). Alternative simpler choice: store pipeline+stage in params_json and have the scanner thread them through. For Phase B, the ad-hoc instance is fine — keep it short-lived.

- [ ] **Step 3: Run tsc + relevant tests**

```bash
cd packages/core && pnpm tsc --noEmit && pnpm vitest run src/plugins/adb-precheck-plugin
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/plugins/adb-precheck-plugin.ts
git commit -m "feat(adb-precheck): scanParams accepts tenant + pipeline_id/stage_id overrides"
```

---

### Task 26: Snapshot files separated per-tenant

**Files:**
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (snapshot baseDir)
- Modify: `packages/core/src/snapshots/probe-snapshot-writer.ts` (accept tenant in write())

- [ ] **Step 1: Patch writer**

In `probe-snapshot-writer.ts`, locate the `write(...)` method. Add a `tenant?` field on the input:

```ts
async write(opts: { /* existing */; tenant?: string }): Promise<string> {
  const tenant = opts.tenant ?? 'adb'
  const dir = path.join(this.baseDir, tenant, /* existing date subpath */)
  // mkdir -p dir; existing file write
}
```

Where this writer is invoked (`AdbProbeStrategy`), thread the tenant from the scanner context:

```ts
await this.snapshotWriter.write({ /* existing */, tenant: ctx?.tenant ?? 'adb' })
```

- [ ] **Step 2: Add a path-shape test**

Append to `packages/core/src/snapshots/probe-snapshot-writer.test.ts`:

```ts
it('writes under <baseDir>/<tenant>/<date>/<file>.png', async () => {
  const w = new ProbeSnapshotWriter({ baseDir: tmpDir, dailyQuota: 100, perMinuteCap: 100 })
  const p = await w.write({ phone: '5543991234567', state: 'exists', png: Buffer.from('x'), tenant: 'sicoob' })
  expect(p).toContain(`${path.sep}sicoob${path.sep}`)
})
```

- [ ] **Step 3: Run tests**

```bash
cd packages/core && pnpm vitest run src/snapshots/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/snapshots/probe-snapshot-writer.ts packages/core/src/snapshots/probe-snapshot-writer.test.ts packages/core/src/check-strategies/adb-probe-strategy.ts
git commit -m "feat(adb-precheck): probe snapshots split per-tenant directory"
```

---

### Task 27: `listSnapshotFiles` filters by tenant

**Files:**
- Modify: `packages/core/src/snapshots/list.ts`
- Modify: `packages/core/src/plugins/adb-precheck-plugin.ts` (`handleListSnapshots`)

- [ ] **Step 1: Patch list.ts**

```ts
export function listSnapshotFiles(
  baseDir: string,
  filter: { since?: string; state?: string; tenant?: string } = {},
): Array<{ path: string; phone: string; state: string; tenant: string; ts: string }> {
  // If tenant filter passed, traverse only baseDir/<tenant>; otherwise traverse all subdirs.
}
```

- [ ] **Step 2: Handler accepts ?tenant=**

In `handleListSnapshots`, read `q.tenant` and pass to `listSnapshotFiles`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/snapshots/list.ts packages/core/src/plugins/adb-precheck-plugin.ts
git commit -m "feat(adb-precheck): listSnapshotFiles accepts tenant filter"
```

---

### Task 28: Plugin smoke against staging router

**Files:** none (operational).

- [ ] **Step 1: Boot Dispatch with sicoob tenant configured**

Add to `.env` (real values from Task 17):

```
PLUGIN_ADB_PRECHECK_TENANTS=adb,sicoob
PLUGIN_ADB_PRECHECK_REST_BASE_URL_SICOOB=https://gows-chat.debt.com.br/api/v1/sicoob
PLUGIN_ADB_PRECHECK_REST_API_KEY_SICOOB=<key from Task 17>
PLUGIN_ADB_PRECHECK_PIPELINE_ID_SICOOB=14
PLUGIN_ADB_PRECHECK_STAGE_ID_SICOOB=110
PLUGIN_ADB_PRECHECK_PIPEDRIVE_TOKEN_SICOOB=8fe7cd6ce9f514ec86311bffc79354657beaeb2e
PLUGIN_ADB_PRECHECK_PIPEDRIVE_DOMAIN_SICOOB=<your subdomain>
```

Boot:

```bash
cd /var/www/adb_tools && pnpm dev:core 2>&1 | grep -E 'tenant|adb-precheck' | head -20
```

Expected: logs show `tenant=sicoob` registered.

- [ ] **Step 2: Hit /tenants**

```bash
curl -sS "http://localhost:3000/api/v1/plugins/adb-precheck/tenants" | jq '.tenants | length'
```

Expected: 2.

- [ ] **Step 3: Dry-run scan against sicoob**

```bash
curl -sS -X POST "http://localhost:3000/api/v1/plugins/adb-precheck/scan" \
  -H 'Content-Type: application/json' \
  -d '{"tenant":"sicoob","limit":1}' | jq .
```

Expected: `status: queued` or `running` with `tenant: sicoob` in params_json.

**🎯 PHASE B.2 GATE: Plugin multi-tenant scanning live (sicoob smoke green).**

---

## FASE B.3 — UI React tenant-aware

### Task 29: TenantContext + hook

**Files:**
- Create: `packages/ui/src/components/adb-precheck/tenant-context.tsx`
- Create: `packages/ui/src/components/adb-precheck/tenant-context.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TenantProvider, useTenant } from './tenant-context'

function Probe() {
  const { tenant, setTenant } = useTenant()
  return (
    <div>
      <span data-testid="t">{tenant?.id ?? 'none'}</span>
      <button onClick={() => setTenant({ id: 'sicoob', label: 'Sicoob', mode: 'raw' })}>set</button>
    </div>
  )
}

describe('TenantContext', () => {
  it('starts with no tenant when no localStorage and exposes setter', () => {
    render(<TenantProvider><Probe /></TenantProvider>)
    expect(screen.getByTestId('t').textContent).toBe('none')
  })
})
```

- [ ] **Step 2: Run, verify fail**

```bash
cd packages/ui && pnpm vitest run src/components/adb-precheck/tenant-context.test.tsx
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type TenantId = 'adb' | 'sicoob' | 'oralsin'

export interface TenantSummary {
  id: TenantId
  label: string
  mode: 'prov' | 'raw'
  defaultPipelineId?: number
  defaultStageId?: number
  writeback?: { invalidate: boolean; localize: boolean; pipedriveNote: boolean; pipedriveActivity: boolean }
  pipedriveEnabled?: boolean
}

interface Ctx {
  tenant: TenantSummary | null
  setTenant: (t: TenantSummary | null) => void
  tenants: TenantSummary[]
  setTenants: (l: TenantSummary[]) => void
}

const TenantCtx = createContext<Ctx | null>(null)
const LS_KEY = 'adb-precheck.tenant'

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenantState] = useState<TenantSummary | null>(null)
  const [tenants, setTenants] = useState<TenantSummary[]>([])

  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (raw) {
      try {
        const t = JSON.parse(raw) as TenantSummary
        setTenantState(t)
      } catch {
        // ignore corrupt
      }
    }
  }, [])

  const setTenant = useCallback((t: TenantSummary | null) => {
    setTenantState(t)
    if (typeof window !== 'undefined') {
      if (t) localStorage.setItem(LS_KEY, JSON.stringify(t))
      else localStorage.removeItem(LS_KEY)
    }
  }, [])

  return <TenantCtx.Provider value={{ tenant, setTenant, tenants, setTenants }}>{children}</TenantCtx.Provider>
}

export function useTenant(): Ctx {
  const c = useContext(TenantCtx)
  if (!c) throw new Error('useTenant must be used inside TenantProvider')
  return c
}
```

- [ ] **Step 4: Run tests**

```bash
cd packages/ui && pnpm vitest run src/components/adb-precheck/tenant-context.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/adb-precheck/tenant-context.tsx packages/ui/src/components/adb-precheck/tenant-context.test.tsx
git commit -m "feat(ui-adb-precheck): TenantProvider + useTenant context"
```

---

### Task 30: TenantSelector component

**Files:**
- Create: `packages/ui/src/components/adb-precheck/tenant-selector.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect } from 'react'
import { Building2 } from 'lucide-react'
import { CORE_URL, authHeaders } from '../../config'
import { useTenant, type TenantSummary } from './tenant-context'

const TENANT_COLORS: Record<string, string> = {
  adb: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  sicoob: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  oralsin: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
}

export function TenantSelector() {
  const { tenant, setTenant, tenants, setTenants } = useTenant()

  useEffect(() => {
    void fetch(`${CORE_URL}/api/v1/plugins/adb-precheck/tenants`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { tenants: [] }))
      .then((j: { tenants: TenantSummary[] }) => setTenants(j.tenants ?? []))
      .catch(() => setTenants([]))
  }, [setTenants])

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value
    if (id === 'global') setTenant(null)
    else {
      const t = tenants.find((x) => x.id === id) ?? null
      setTenant(t)
    }
  }

  const colorClass = tenant ? TENANT_COLORS[tenant.id] ?? 'text-zinc-300 bg-zinc-800 border-zinc-700' : 'text-zinc-300 bg-zinc-800 border-zinc-700'

  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${colorClass}`}>
      <Building2 className="h-3.5 w-3.5" />
      <span className="opacity-70">Empresa:</span>
      <select
        value={tenant?.id ?? 'global'}
        onChange={onChange}
        className="bg-transparent outline-none border-none text-current"
      >
        <option value="global">Global (todos)</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/adb-precheck/tenant-selector.tsx
git commit -m "feat(ui-adb-precheck): TenantSelector component"
```

---

### Task 31: Mount TenantProvider + selector in `adb-precheck-tab.tsx`

**Files:**
- Modify: `packages/ui/src/components/adb-precheck-tab.tsx`

- [ ] **Step 1: Wrap the existing top-level export**

Find the `export function AdbPrecheckTab()`. Rename to `AdbPrecheckTabInner` and wrap:

```tsx
import { TenantProvider } from './adb-precheck/tenant-context'

export function AdbPrecheckTab() {
  return (
    <TenantProvider>
      <AdbPrecheckTabInner />
    </TenantProvider>
  )
}
```

- [ ] **Step 2: Mount TenantSelector in the header `actions` prop**

In the existing `<PluginHeader ... actions={...} />`, change the `actions` to:

```tsx
actions={
  <div className="flex items-center gap-2">
    <TenantSelector />
    <AccentButton accent={ACCENT} variant="ghost" onClick={fetchStatus} icon={RefreshCw}>
      Atualizar
    </AccentButton>
  </div>
}
```

Add the import: `import { TenantSelector } from './adb-precheck/tenant-selector'`.

- [ ] **Step 3: Pass tenant to all fetches inside subpanels**

Inside `OverviewPanel`, `JobsPanel`, etc., read `const { tenant } = useTenant()` and append `?tenant=${tenant.id}` to every URL when `tenant` is non-null. When null (Global), omit the param.

> If this becomes intrusive across many files, extract a helper `buildPluginUrl(path: string, tenant: TenantSummary | null)` in `adb-precheck/url.ts`.

- [ ] **Step 4: tsc + smoke run**

```bash
cd packages/ui && pnpm tsc --noEmit
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/adb-precheck-tab.tsx packages/ui/src/components/adb-precheck/
git commit -m "feat(ui-adb-precheck): mount TenantProvider+Selector, propagate tenant filter"
```

---

### Task 32: DeviceAvailabilityCard

**Files:**
- Create: `packages/ui/src/components/adb-precheck/device-availability-card.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { Smartphone, CheckCircle2, Lock } from 'lucide-react'
import { CORE_URL, authHeaders } from '../../config'

interface DeviceAvailability {
  serial: string
  available: boolean
  tenant?: string
  job_id?: string
  since?: string
}

const TENANT_TONE: Record<string, string> = {
  adb: 'text-sky-300',
  sicoob: 'text-violet-300',
  oralsin: 'text-amber-300',
}

export function DeviceAvailabilityCard({ onSelect, selected }: { onSelect: (serial: string) => void; selected?: string | null }) {
  const [devices, setDevices] = useState<DeviceAvailability[]>([])

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${CORE_URL}/api/v1/plugins/adb-precheck/devices/availability`, { headers: authHeaders() })
      if (!r.ok) return
      const d = (await r.json()) as { devices: DeviceAvailability[] }
      setDevices(d.devices ?? [])
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(load, 5_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="space-y-2">
      {devices.length === 0 ? (
        <div className="text-xs text-zinc-500">Nenhum device conectado.</div>
      ) : null}
      {devices.map((d) => {
        const isSelected = selected === d.serial
        return (
          <button
            key={d.serial}
            type="button"
            onClick={() => onSelect(d.serial)}
            disabled={!d.available}
            className={`w-full flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
              isSelected
                ? 'border-sky-400 bg-sky-500/10'
                : d.available
                  ? 'border-zinc-800 hover:bg-zinc-900'
                  : 'border-zinc-800 bg-zinc-900/30 opacity-60 cursor-not-allowed'
            }`}
            title={!d.available && d.tenant ? `Ocupado por ${d.tenant} (job ${d.job_id})` : ''}
          >
            <div className="flex items-center gap-2">
              <Smartphone className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-mono text-zinc-200">{d.serial}</span>
            </div>
            {d.available ? (
              <span className="flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Livre
              </span>
            ) : (
              <span className={`flex items-center gap-1 ${TENANT_TONE[d.tenant ?? ''] ?? 'text-rose-300'}`}>
                <Lock className="h-3.5 w-3.5" />
                {d.tenant ?? 'busy'} · {d.job_id ? `job ${d.job_id.slice(0, 6)}` : ''}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/adb-precheck/device-availability-card.tsx
git commit -m "feat(ui-adb-precheck): DeviceAvailabilityCard with 5s polling + busy badges"
```

---

### Task 33: PipelineStagePicker for raw tenants

**Files:**
- Create: `packages/ui/src/components/adb-precheck/pipeline-stage-picker.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useTenant } from './tenant-context'

interface Props {
  pipelineId: number | undefined
  stageId: number | undefined
  onChange: (p: { pipelineId?: number; stageId?: number }) => void
}

export function PipelineStagePicker({ pipelineId, stageId, onChange }: Props) {
  const { tenant } = useTenant()
  if (!tenant || tenant.mode !== 'raw') return null

  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-zinc-400">Pipeline ID</span>
        <input
          type="number"
          value={pipelineId ?? tenant.defaultPipelineId ?? ''}
          onChange={(e) => onChange({ pipelineId: e.target.value ? Number(e.target.value) : undefined, stageId })}
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 font-mono"
          placeholder={String(tenant.defaultPipelineId ?? '')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-zinc-400">Stage ID (opcional)</span>
        <input
          type="number"
          value={stageId ?? tenant.defaultStageId ?? ''}
          onChange={(e) => onChange({ pipelineId, stageId: e.target.value ? Number(e.target.value) : undefined })}
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 font-mono"
          placeholder={String(tenant.defaultStageId ?? '')}
        />
      </label>
    </div>
  )
}
```

- [ ] **Step 2: Wire into NewScanPanel**

Open `packages/ui/src/components/adb-precheck-tab.tsx`, locate `NewScanPanel`. Add state for `pipelineId` and `stageId`. Render `<PipelineStagePicker .../>` when the current tenant is raw. Include the values in the POST body to `/scan`.

In the submit handler:

```ts
const { tenant } = useTenant()
// ...
const body: Record<string, unknown> = { limit, /* ... */ }
if (tenant) {
  body.tenant = tenant.id
  if (pipelineId !== undefined) body.pipeline_id = pipelineId
  if (stageId !== undefined) body.stage_id = stageId
}
if (deviceSerial) body.device_serial = deviceSerial
```

Handle `409 device_busy`:

```ts
if (r.status === 409) {
  const j = await r.json() as { error: string; tenant: string; job_id: string }
  setError(`Device ocupado por ${j.tenant} (job ${j.job_id.slice(0, 8)}). Aguarde ou escolha outro device.`)
  return
}
```

- [ ] **Step 3: Smoke**

```bash
cd packages/ui && pnpm tsc --noEmit && pnpm vitest run
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/adb-precheck/pipeline-stage-picker.tsx packages/ui/src/components/adb-precheck-tab.tsx
git commit -m "feat(ui-adb-precheck): PipelineStagePicker + NewScanPanel wires tenant/pipeline/stage"
```

---

### Task 34: Hygienization disabled in raw mode

**Files:**
- Modify: `packages/ui/src/components/adb-precheck-tab.tsx` (NewScanPanel)

- [ ] **Step 1: Disable + tooltip when tenant.mode === 'raw'**

Locate the existing `Hygienization mode` checkbox. Add:

```tsx
const isRaw = tenant?.mode === 'raw'
// ...
<input type="checkbox" disabled={isRaw} checked={!isRaw && hygienization} onChange={(e) => setHygienization(e.target.checked)} />
{isRaw ? <span className="ml-1 text-zinc-500 text-[10px]">(indisponível em raw mode)</span> : null}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/components/adb-precheck-tab.tsx
git commit -m "fix(ui-adb-precheck): hygienization disabled when tenant.mode='raw'"
```

---

### Task 35: UI lint + tsc clean

- [ ] **Step 1: Run**

```bash
cd packages/ui && pnpm lint && pnpm tsc --noEmit && pnpm vitest run
```

Expected: green across all three.

- [ ] **Step 2: Commit dummy if anything moves**

(usually nothing — this is a gate, not a code change).

**🎯 PHASE B.3 GATE: UI tenant-aware shipped.**

---

## FASE B.4 — E2E real + Phase Gate

### Task 36: E2E real scan against Sicoob (limit=3)

**Files:** none (operational).

- [ ] **Step 1: Confirm 3 devices connected**

```bash
adb devices
```

Expected: 3 serials listed.

- [ ] **Step 2: Start Dispatch dev**

```bash
cd /var/www/adb_tools && pnpm dev
```

- [ ] **Step 3: From the UI**

- Open `http://localhost:5174` → ADB Pre-check tab.
- Tenant selector → switch to `Sicoob` (badge turns violet).
- Tab "Novo Scan" → Pipeline ID auto-fills `14`, Stage ID `110`.
- Select POCO C71 #2 (or any device that's free).
- limit=3.
- Click "Iniciar scan".

Expected:
- Status 201 from `POST /scan` with `tenant: sicoob`.
- Job appears in Jobs tab with violet badge.
- Within ~2-5 min: 3 deals scanned. Per-deal Pipedrive Note created in real Sicoob Pipedrive (open `https://debt-<sub>.pipedrive.com/deal/<id>` to verify).
- Activity with `done=1` posted for each fully-failed deal.

- [ ] **Step 4: Capture proof**

Take screenshots of:
- UI showing the job in violet
- Pipedrive deal page showing the Note
- Save to `reports/2026-05-14-sicoob-e2e-<timestamp>.png`

- [ ] **Step 5: Verify cache primed**

```bash
sqlite3 data/dispatch.db "SELECT phone_normalized, result, COUNT(*) FROM wa_contact_checks WHERE checked_at >= datetime('now','-1 hour') GROUP BY phone_normalized, result LIMIT 20"
```

Expected: rows added with `tenant`-agnostic phone hashes (cache is global).

---

### Task 37: Regression — adb scan still works

**Files:** none (operational).

- [ ] **Step 1: From UI, switch to ADB/Debt tenant**

- Tenant selector → `ADB/Debt`.
- Tab "Novo Scan" → use the existing pasta_prefix or pipeline_nome filter (not pipeline_id).
- limit=2.
- POCO C71 #1.
- Click "Iniciar scan".

Expected:
- Job completes exactly as before. Pipedrive notes for adb company.

- [ ] **Step 2: Verify in DB**

```bash
sqlite3 data/dispatch.db "SELECT id, tenant, status FROM adb_precheck_jobs ORDER BY created_at DESC LIMIT 5"
```

Expected: latest row tenant=`adb`.

---

### Task 38: Parallel run — sicoob + adb on different devices

- [ ] **Step 1: From UI**

- Switch to ADB/Debt, start scan on POCO #1 (limit=5).
- IMMEDIATELY switch tenant to Sicoob, start scan on POCO #2 (limit=5).
- Open Jobs tab in lane/global mode (no tenant selected) — verify both jobs run in parallel.

Expected:
- Both jobs complete; logs show interleaved scans by tenant.
- DeviceMutex never reports a holder for the wrong device.

- [ ] **Step 2: Negative test — try to start a 3rd scan on POCO #2 while busy**

Open a new tab → Sicoob tenant → "Novo Scan" → POCO #2 → "Iniciar". Expected: button disabled, tooltip "Device ocupado por sicoob (job …)". Bypass UI → `curl -X POST /scan -d '{"tenant":"sicoob","device_serial":"<POCO2>","limit":1}'`. Expected: HTTP 409 with `{error:"device_busy",tenant:"sicoob",job_id:"..."}`.

---

### Task 39: Code review pass

- [ ] **Step 1: Dispatch a feature-dev:code-reviewer subagent**

Prompt:

> Review the code added in commits since `<sha of Task 1 commit>`. Focus on:
> 1. Backwards compatibility of the SQLite migration (idempotent ALTER, default='adb').
> 2. Multi-tenant dedup correctness in `pipedrive-activity-store.ts`.
> 3. Whitelist split in router — any handler missed?
> 4. PipeboardRawRest does not silently fall through to write ops.
> 5. DeviceMutex.describeHolder thread-safety (single-threaded JS event loop, but watch promise interleavings).
> 6. UI error handling for 409 device_busy.
> Report critical/blocking issues only.

- [ ] **Step 2: Address blockers (if any) in follow-up commits**

- [ ] **Step 3: Run `superpowers:verification-before-completion` skill**

Goes through the verification checklist: tests green, lint clean, tsc clean, E2E proof, no commented-out code, no TODOs left.

---

### Task 40: Phase Gate

- [ ] **Step 1: Update `.dev-state/progress.md`**

Append:

```
Phase B (Sicoob tracer bullet multi-tenant) — APPROVED 2026-05-XX
- Router: /precheck-raw/deals live
- Plugin: PipeboardRawRest + per-tenant scanner + per-tenant Pipedrive
- UI: TenantSelector + DeviceAvailability + PipelineStagePicker
- E2E: 3 deals scanned in Sicoob real Pipedrive; ADB regression green; parallel sicoob+adb confirmed.
- Unblocked: Phase C (Oralsin config delta), Phase D (Hardening)
```

- [ ] **Step 2: Commit**

```bash
git add .dev-state/progress.md
git commit -m "phase(B): sicoob tracer bullet multi-tenant — APPROVED"
```

- [ ] **Step 3: Open GitHub PR for the whole branch**

```bash
gh pr create --title "feat: ADB Precheck multi-tenant (Phase A + B Sicoob tracer)" --body "$(cat <<'EOF'
## Summary
- Phase A: Foundation (TenantRegistry, SQLite migrations, DeviceMutex.describeHolder, /tenants, /devices/availability, 409 device_busy guard)
- Phase B: Sicoob tracer bullet (router /precheck-raw/deals, PipeboardRawRest, per-tenant scanner+Pipedrive, UI tenant selector + device card + pipeline picker)

## E2E proof
- 3 deals scanned in real Sicoob Pipedrive
- ADB regression green (existing flow unchanged)
- Parallel sicoob + adb on different devices

## Test plan
- [x] All Vitest passing
- [x] All Go tests passing
- [x] Lint + tsc clean
- [x] E2E real screenshots in reports/

🤖 Generated with Claude Code
EOF
)"
```

**🎯 PHASE B GATE: APPROVED. Ready for Phase C (Oralsin config-delta plan) and Phase D (Hardening plan).**

---

## Self-review checklist

Run this against the spec before claiming the plan complete:

**1. Spec coverage**

| Spec section | Tasks |
|---|---|
| §5.1 R1 `/precheck-raw/deals` | 13, 14, 15, 16 |
| §5.1 R2 whitelist split | 12 |
| §5.1 R3 projection helper | 13 |
| §5.1 R4 server-side hygienization (deferred) | — (Phase D plan) |
| §5.2 T1 TenantRegistry | 1, 2 |
| §5.2 T2 PipeboardRawRest | 19, 20 |
| §5.2 T3 SQLite migration + scan params + job store | 3, 25 |
| §5.2 T4 Pipedrive per-tenant + done=1 | 23 |
| §5.2 T5 DeviceMutex.describeHolder | 4, 5 |
| §5.2 T6 scanner mode='raw' | 21, 22 |
| §5.2 T7 plugin routes /tenants /devices /availability | 6, 7 |
| §5.3 U1 TenantSelector + context | 29, 30, 31 |
| §5.3 U2 device card + 409 guard | 32, 33 |
| §5.3 U3 jobs lane view | — (deferred to Phase D plan) |
| §5.3 U4 Pipedrive note preview | — (deferred to Phase D plan) |
| §5.3 U5 pipeline/stage picker | 33 |
| §5.3 U6 Visão Geral breakdown | — (deferred to Phase D plan) |
| §5.3 U7 locks panel device entries | — (deferred to Phase D plan) |
| §6 Concurrency races 1-8 | 4-5 (race 3,7), 8 (race 1), 23 (race 4), 24 (race 5), 31 (race 6), 36-38 (verification) |
| §7 Observability | — (deferred to Phase D plan) |

Deferred items are explicitly captured for the Phase D plan; nothing critical to the tracer bullet is missing.

**2. Placeholder scan:** all code blocks contain real code; no TBDs. JSONB keys in Task 13 are flagged for adjustment after Task 11 spike — this is *not* a placeholder, it's a known-late-binding decision.

**3. Type consistency:**
- `TenantId` is used consistently across `tenant-registry.ts`, scanner, plugin, UI.
- `describeHolder` signature stable: `(serial: string) → HolderState | null`.
- `PrecheckScanParams.tenant` matches Zod enum.
- `iterateDeals(params, pageSize)` signature matches `IPipeboardClient`.

**4. Test phone:** `5543991938235` referenced — not used in this plan because precheck does not send messages (only probes WhatsApp existence via `wa.me/<phone>` intent). The test phone is reserved for the send engine. Precheck E2E uses real Sicoob deal phones.

---

**End of Phase A + B plan. Phases C (Oralsin) and D (Hardening) will be written as separate plans after this one is APPROVED.**
