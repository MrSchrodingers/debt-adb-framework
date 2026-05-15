# debt-sdr Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `debt-sdr` plugin — multi-tenant SDR outbound for Oralsin and Sicoob using POCO C71 #2 and Samsung A03 — with hard tenant partition, identity gate, hybrid classifier (regex+LLM), Pipedrive pull/writeback, and 3-step sequence (day 0/2/5).

**Architecture:** Plugin-first. 5 minimal core changes (sender_mapping.tenant, device_tenant_assignment, messages.tenant_hint, PluginContext extension, response tightening) + greenfield plugin in `packages/plugins/debt-sdr/`. Each tenant has dedicated device, sticky sender per lead, fail-loud on race conditions. 10 adversarial scenarios covered by dedicated tests.

**Tech Stack:** TypeScript, Fastify, Vitest, better-sqlite3, Zod, Anthropic SDK (Claude Haiku 4.5), pino, ulid. Existing core primitives reused: PluginContext, GeoViewRegistry (precedent), DeviceMutex, AccountMutex, MessageHistory, CallbackDelivery.

**Spec:** `docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md`

**Phases:**
- **A. Core changes** — Tasks 1–10 (G1-G5 + wiring + smoke)
- **B. Plugin scaffold** — Tasks 11–17 (config + claim + migrations)
- **C. Classifier + identity gate** — Tasks 18–26
- **D. Sequencer + Pipedrive** — Tasks 27–38
- **E. Routes, tests, deploy, gates** — Tasks 39–50

Each task: TDD red→green→commit. ~50 commits expected.

**Test phone:** `5543991938235` (per CLAUDE.md — only for E2E sends).

---

## FASE A — Backend core changes

### Task 1: G1 — Add `tenant` column to `sender_mapping`

**Files:**
- Modify: `packages/core/src/engine/sender-mapping.ts`
- Modify: `packages/core/src/engine/sender-mapping.test.ts` (add tests)

- [ ] **Step 1: Read existing schema setup**

Open `packages/core/src/engine/sender-mapping.ts` and locate the `CREATE TABLE sender_mapping` block and the `SenderMappingRecord` interface. Note that the file uses an inline migration pattern (constructor runs `db.prepare(CREATE_TABLE).run()` followed by idempotent `ALTER TABLE` for added columns).

- [ ] **Step 2: Write failing tests**

Append to `packages/core/src/engine/sender-mapping.test.ts`:

```ts
describe('SenderMapping.setSenderTenant', () => {
  it('upserts tenant for a phone with no tenant', () => {
    sm.upsert({ phoneNumber: '554399000001', deviceSerial: 'devX' })
    const r = sm.setSenderTenant('554399000001', 'oralsin-sdr')
    expect(r.ok).toBe(true)
    expect(sm.getByPhone('554399000001')!.tenant).toBe('oralsin-sdr')
  })

  it('is idempotent for the same tenant', () => {
    sm.upsert({ phoneNumber: '554399000002', deviceSerial: 'devX' })
    sm.setSenderTenant('554399000002', 'oralsin-sdr')
    const r = sm.setSenderTenant('554399000002', 'oralsin-sdr')
    expect(r.ok).toBe(true)
  })

  it('rejects a different tenant for the same phone', () => {
    sm.upsert({ phoneNumber: '554399000003', deviceSerial: 'devX' })
    sm.setSenderTenant('554399000003', 'oralsin-sdr')
    const r = sm.setSenderTenant('554399000003', 'sicoob-sdr')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('conflicting_tenant')
  })

  it('listByTenant returns only matching senders', () => {
    sm.upsert({ phoneNumber: '554399000010', deviceSerial: 'd1' })
    sm.upsert({ phoneNumber: '554399000011', deviceSerial: 'd2' })
    sm.setSenderTenant('554399000010', 'oralsin-sdr')
    const list = sm.listByTenant('oralsin-sdr')
    expect(list.map(s => s.phone_number)).toEqual(['554399000010'])
  })

  it('returns the new tenant in getByPhone result', () => {
    sm.upsert({ phoneNumber: '554399000020', deviceSerial: 'devX' })
    sm.setSenderTenant('554399000020', 'sicoob-sdr')
    const rec = sm.getByPhone('554399000020')
    expect(rec).not.toBeNull()
    expect(rec!.tenant).toBe('sicoob-sdr')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /var/www/adb_tools && pnpm --filter @dispatch/core test src/engine/sender-mapping.test.ts -t "setSenderTenant"`
Expected: FAIL — `setSenderTenant is not a function` / `tenant` is undefined.

- [ ] **Step 4: Add column + idempotent migration in constructor**

In `packages/core/src/engine/sender-mapping.ts`, find the constructor where the table is created. After `CREATE TABLE sender_mapping (...)`, add:

```ts
// G1 (debt-sdr): tenant ownership column. Nullable for legacy senders (no tenant).
// Idempotent migration.
const cols = this.db.prepare("PRAGMA table_info('sender_mapping')").all() as Array<{ name: string }>
if (!cols.some(c => c.name === 'tenant')) {
  this.db.prepare('ALTER TABLE sender_mapping ADD COLUMN tenant TEXT').run()
}
this.db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_sender_mapping_tenant
    ON sender_mapping(tenant) WHERE tenant IS NOT NULL
`).run()
```

In the `SenderMappingRecord` interface, add `tenant: string | null`.

- [ ] **Step 5: Implement `setSenderTenant` and `listByTenant`**

Add these methods to the class:

```ts
setSenderTenant(phone: string, tenant: string):
  | { ok: true }
  | { ok: false; reason: 'phone_not_found' }
  | { ok: false; reason: 'conflicting_tenant'; current_tenant: string }
{
  const row = this.db.prepare('SELECT tenant FROM sender_mapping WHERE phone_number = ?').get(phone) as
    { tenant: string | null } | undefined
  if (!row) return { ok: false, reason: 'phone_not_found' }
  if (row.tenant !== null && row.tenant !== tenant) {
    return { ok: false, reason: 'conflicting_tenant', current_tenant: row.tenant }
  }
  if (row.tenant === tenant) return { ok: true }  // idempotent
  this.db.prepare(`
    UPDATE sender_mapping SET tenant = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE phone_number = ?
  `).run(tenant, phone)
  return { ok: true }
}

listByTenant(tenant: string): SenderMappingRecord[] {
  return this.db.prepare('SELECT * FROM sender_mapping WHERE tenant = ?').all(tenant) as SenderMappingRecord[]
}
```

Update `getByPhone` SELECT statement to include `tenant` in the projection (or `SELECT *` if it already does — verify).

- [ ] **Step 6: Run tests, commit**

```bash
pnpm --filter @dispatch/core test src/engine/sender-mapping.test.ts
git add packages/core/src/engine/sender-mapping.ts packages/core/src/engine/sender-mapping.test.ts
git commit -m "feat(sdr-G1): sender_mapping.tenant column + setSenderTenant/listByTenant"
```

Expected: 5 new tests pass.

---

### Task 2: G2.1 — `DeviceTenantAssignment` service + table

**Files:**
- Create: `packages/core/src/engine/device-tenant-assignment.ts`
- Create: `packages/core/src/engine/device-tenant-assignment.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { DeviceTenantAssignment } from './device-tenant-assignment.js'

describe('DeviceTenantAssignment', () => {
  let db: Database.Database
  let dta: DeviceTenantAssignment

  beforeEach(() => {
    db = new Database(':memory:')
    dta = new DeviceTenantAssignment(db)
  })

  it('claim succeeds for a free device', () => {
    const r = dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('claim is idempotent for same tenant+plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('claim fails when device already claimed by other tenant', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.claim('dev1', 'sicoob-sdr', 'debt-sdr')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('already_claimed')
      expect(r.current_tenant).toBe('oralsin-sdr')
      expect(r.current_plugin).toBe('debt-sdr')
    }
  })

  it('release returns ok=false for non-owner plugin (I2)', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.release('dev1', 'malicious-plugin')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_owner')
    // Assignment still active
    expect(dta.getAssignment('dev1')).not.toBeNull()
  })

  it('release succeeds for the owner plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    const r = dta.release('dev1', 'debt-sdr')
    expect(r.ok).toBe(true)
    expect(dta.getAssignment('dev1')).toBeNull()
  })

  it('release on unknown device is no-op (ok: true)', () => {
    const r = dta.release('devX', 'debt-sdr')
    expect(r.ok).toBe(true)
  })

  it('list returns all assignments', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    dta.claim('dev2', 'sicoob-sdr', 'debt-sdr')
    expect(dta.list()).toHaveLength(2)
  })

  it('releaseByPlugin removes all assignments owned by a plugin', () => {
    dta.claim('dev1', 'oralsin-sdr', 'debt-sdr')
    dta.claim('dev2', 'sicoob-sdr', 'debt-sdr')
    dta.claim('dev3', 'other', 'other-plugin')
    dta.releaseByPlugin('debt-sdr')
    expect(dta.list()).toHaveLength(1)
    expect(dta.getAssignment('dev3')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @dispatch/core test src/engine/device-tenant-assignment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `packages/core/src/engine/device-tenant-assignment.ts`:

```ts
import type Database from 'better-sqlite3'

export interface DeviceAssignment {
  device_serial: string
  tenant_name: string
  claimed_by_plugin: string
  claimed_at: string
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'already_claimed'; current_tenant: string; current_plugin: string }

export type ReleaseResult =
  | { ok: true }
  | { ok: false; reason: 'not_owner' }

export class DeviceTenantAssignment {
  constructor(private readonly db: Database.Database) {
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS device_tenant_assignment (
        device_serial TEXT PRIMARY KEY,
        tenant_name TEXT NOT NULL,
        claimed_by_plugin TEXT NOT NULL,
        claimed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `).run()
  }

  /**
   * Claim a device for a (tenant, plugin) pair. Idempotent if the same
   * (tenant, plugin) already owns it. Fails if any other tenant/plugin
   * holds it. Atomic via SQLite single-writer.
   */
  claim(deviceSerial: string, tenantName: string, pluginName: string): ClaimResult {
    const existing = this.db.prepare(
      'SELECT tenant_name, claimed_by_plugin FROM device_tenant_assignment WHERE device_serial = ?'
    ).get(deviceSerial) as { tenant_name: string; claimed_by_plugin: string } | undefined

    if (existing) {
      if (existing.tenant_name === tenantName && existing.claimed_by_plugin === pluginName) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: 'already_claimed',
        current_tenant: existing.tenant_name,
        current_plugin: existing.claimed_by_plugin,
      }
    }

    this.db.prepare(`
      INSERT INTO device_tenant_assignment (device_serial, tenant_name, claimed_by_plugin)
      VALUES (?, ?, ?)
    `).run(deviceSerial, tenantName, pluginName)
    return { ok: true }
  }

  release(deviceSerial: string, pluginName: string): ReleaseResult {
    const existing = this.db.prepare(
      'SELECT claimed_by_plugin FROM device_tenant_assignment WHERE device_serial = ?'
    ).get(deviceSerial) as { claimed_by_plugin: string } | undefined

    if (!existing) return { ok: true }  // already absent — no-op
    if (existing.claimed_by_plugin !== pluginName) {
      return { ok: false, reason: 'not_owner' }
    }
    this.db.prepare('DELETE FROM device_tenant_assignment WHERE device_serial = ?').run(deviceSerial)
    return { ok: true }
  }

  releaseByPlugin(pluginName: string): number {
    const r = this.db.prepare(
      'DELETE FROM device_tenant_assignment WHERE claimed_by_plugin = ?'
    ).run(pluginName)
    return r.changes
  }

  getAssignment(deviceSerial: string): DeviceAssignment | null {
    return (this.db.prepare(
      'SELECT * FROM device_tenant_assignment WHERE device_serial = ?'
    ).get(deviceSerial) as DeviceAssignment | undefined) ?? null
  }

  list(): DeviceAssignment[] {
    return this.db.prepare('SELECT * FROM device_tenant_assignment').all() as DeviceAssignment[]
  }
}
```

- [ ] **Step 4: Run tests, commit**

```bash
pnpm --filter @dispatch/core test src/engine/device-tenant-assignment.test.ts
git add packages/core/src/engine/device-tenant-assignment.ts packages/core/src/engine/device-tenant-assignment.test.ts
git commit -m "feat(sdr-G2.1): DeviceTenantAssignment service — claim/release/list"
```

Expected: 8 tests pass.

---

### Task 3: G2.2 — `messages.tenant_hint` column + setter

**Files:**
- Modify: `packages/core/src/queue/message-queue.ts`
- Modify: `packages/core/src/queue/types.ts` (EnqueueParams + Message)
- Modify: `packages/core/src/queue/message-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/core/src/queue/message-queue.test.ts`:

```ts
describe('messages.tenant_hint', () => {
  it('stores null tenant_hint by default (legacy enqueue)', () => {
    const msg = queue.enqueue({ to: '554399000001', body: 'x', idempotencyKey: 'k1' })
    expect(msg.tenantHint).toBeNull()
  })

  it('stores tenant_hint when provided', () => {
    const msg = queue.enqueue({ to: '554399000002', body: 'x', idempotencyKey: 'k2', tenantHint: 'oralsin-sdr' })
    expect(msg.tenantHint).toBe('oralsin-sdr')
  })

  it('returns tenant_hint in getById', () => {
    queue.enqueue({ to: '554399000003', body: 'x', idempotencyKey: 'k3', tenantHint: 'sicoob-sdr' })
    const found = queue.getByIdempotency('k3')
    expect(found!.tenantHint).toBe('sicoob-sdr')
  })
})
```

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @dispatch/core test src/queue/message-queue.test.ts -t "tenant_hint"`
Expected: FAIL — `tenantHint` undefined.

- [ ] **Step 3: Add migration in MessageQueue constructor**

In `packages/core/src/queue/message-queue.ts`, find the constructor's migration block (look for the existing `ALTER TABLE messages ADD COLUMN screenshot_path TEXT` pattern). Add a parallel block:

```ts
const msgCols = this.db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>
if (!msgCols.some(c => c.name === 'tenant_hint')) {
  this.db.prepare('ALTER TABLE messages ADD COLUMN tenant_hint TEXT').run()
}
this.db.prepare(`
  CREATE INDEX IF NOT EXISTS idx_messages_tenant_hint
    ON messages(tenant_hint, status, created_at)
    WHERE tenant_hint IS NOT NULL
`).run()
```

- [ ] **Step 4: Wire tenant_hint through enqueue + read paths**

In `packages/core/src/queue/types.ts`:
- Add `tenantHint?: string` to `EnqueueParams`.
- Add `tenantHint: string | null` to `Message`.

In `message-queue.ts` `enqueue`:
```ts
// In the INSERT INTO messages statement, add column 'tenant_hint' to the
// column list and bind params.tenantHint ?? null to the corresponding position.
```

In all SELECT statements that build `Message` from row (search for `rowToMessage` or inline projections — typically `getById`, `getByIdempotency`, `dequeueBySender`), add `tenantHint: row.tenant_hint ?? null`.

For `enqueueBatch`, also add per-item tenantHint.

- [ ] **Step 5: Run tests, commit**

```bash
pnpm --filter @dispatch/core test src/queue/message-queue.test.ts
git add packages/core/src/queue/ 
git commit -m "feat(sdr-G2.2): messages.tenant_hint column + EnqueueParams.tenantHint"
```

Expected: 3 new tests pass + existing queue tests still pass.

---

### Task 4: G2.3 — Queue dequeue filter by tenant assignment

**Files:**
- Modify: `packages/core/src/queue/message-queue.ts` (dequeueBySender)
- Modify: `packages/core/src/queue/message-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('MessageQueue.dequeueBySender — tenant filter (G2)', () => {
  let dta: DeviceTenantAssignment
  beforeEach(() => {
    dta = new DeviceTenantAssignment(db)
    queue = new MessageQueue(db, { dta })
    senderMap.upsert({ phoneNumber: '554399000100', deviceSerial: 'devA' })
  })

  it('returns legacy messages when device is unclaimed', () => {
    queue.enqueue({ to: '554399999991', body: 'x', idempotencyKey: 'kA', senderNumber: '554399000100' })
    const batch = queue.dequeueBySender('devA')
    expect(batch).toHaveLength(1)
    expect(batch[0]!.tenantHint).toBeNull()
  })

  it('rejects legacy messages when device is claimed', () => {
    dta.claim('devA', 'oralsin-sdr', 'debt-sdr')
    queue.enqueue({ to: '554399999992', body: 'x', idempotencyKey: 'kB', senderNumber: '554399000100' })
    expect(queue.dequeueBySender('devA')).toHaveLength(0)
  })

  it('returns same-tenant messages on claimed device', () => {
    dta.claim('devA', 'oralsin-sdr', 'debt-sdr')
    queue.enqueue({ to: '554399999993', body: 'x', idempotencyKey: 'kC', senderNumber: '554399000100', tenantHint: 'oralsin-sdr' })
    const batch = queue.dequeueBySender('devA')
    expect(batch).toHaveLength(1)
    expect(batch[0]!.tenantHint).toBe('oralsin-sdr')
  })

  it('rejects cross-tenant messages on claimed device', () => {
    dta.claim('devA', 'oralsin-sdr', 'debt-sdr')
    queue.enqueue({ to: '554399999994', body: 'x', idempotencyKey: 'kD', senderNumber: '554399000100', tenantHint: 'sicoob-sdr' })
    expect(queue.dequeueBySender('devA')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests, verify fail**

Run: `pnpm --filter @dispatch/core test src/queue/message-queue.test.ts -t "tenant filter"`
Expected: FAIL — filter logic absent; "rejects legacy" returns 1.

- [ ] **Step 3: Modify MessageQueue to accept and use DTA**

In `message-queue.ts` constructor signature, add an options object:

```ts
constructor(db: Database.Database, opts?: { dta?: DeviceTenantAssignment }) {
  this.db = db
  this.dta = opts?.dta
  // ... existing schema/migration code
}

private dta?: DeviceTenantAssignment
```

In `dequeueBySender(deviceSerial: string)`, before the SELECT, compute the filter:

```ts
const assignment = this.dta?.getAssignment(deviceSerial) ?? null
// If feature flag disabled, ignore tenant filter entirely
const tenantFilterDisabled = process.env.DISPATCH_QUEUE_TENANT_FILTER === 'false'
let tenantClause = ''
let tenantBinds: string[] = []
if (!tenantFilterDisabled) {
  if (assignment) {
    tenantClause = 'AND tenant_hint = ?'
    tenantBinds = [assignment.tenant_name]
  } else {
    tenantClause = 'AND tenant_hint IS NULL'
  }
}
```

Splice `${tenantClause}` into the existing SELECT WHERE clause and prepend `tenantBinds` to the .all() call binds. Verify the existing tests in this file still pass.

- [ ] **Step 4: Run tests, commit**

```bash
pnpm --filter @dispatch/core test src/queue/message-queue.test.ts
git add packages/core/src/queue/message-queue.ts packages/core/src/queue/message-queue.test.ts
git commit -m "feat(sdr-G2.3): dequeueBySender filters by device_tenant_assignment (rejects cross-tenant)"
```

Expected: 4 new tests pass + existing dequeue tests pass.

---

### Task 5: G3 — PluginContext extension (`requestDeviceAssignment`, `assertSenderInTenant`, `releaseDeviceAssignment`)

**Files:**
- Modify: `packages/core/src/plugins/types.ts`
- Modify: `packages/core/src/plugins/plugin-loader.ts`

- [ ] **Step 1: Add types**

In `packages/core/src/plugins/types.ts`, append:

```ts
export type AssignmentResult =
  | { ok: true }
  | { ok: false; reason: 'already_claimed'; current_tenant: string; current_plugin: string }

export type AssertTenantResult =
  | { ok: true }
  | { ok: false; reason: 'phone_not_found' }
  | { ok: false; reason: 'conflicting_tenant'; current_tenant: string }
```

In the `PluginContext` interface (find it in the same file), after `registerGeoView`, add:

```ts
  /**
   * Claim exclusive ownership of a device for a tenant. Returns ok:false
   * if device already claimed by another (tenant, plugin) pair. Idempotent
   * for the same caller. Plugin should fail init if claim fails — no split
   * mode allowed.
   */
  requestDeviceAssignment(deviceSerial: string, tenantName: string): AssignmentResult

  /**
   * Upsert tenant on a sender. Fails if the sender already has a different
   * tenant. Caller decides what to do on conflict (typically: fail init).
   */
  assertSenderInTenant(senderPhone: string, tenantName: string): AssertTenantResult

  /**
   * Release a device assignment. Loader injects the plugin name from the
   * calling plugin context — plugins can only release what they claimed.
   */
  releaseDeviceAssignment(deviceSerial: string): { ok: boolean }
```

- [ ] **Step 2: Wire into plugin-loader.ts**

In `packages/core/src/plugins/plugin-loader.ts`:
1. Add import: `import type { DeviceTenantAssignment } from '../engine/device-tenant-assignment.js'`
2. Add import: `import type { SenderMapping } from '../engine/sender-mapping.js'`
3. Constructor: add optional param `private dta?: DeviceTenantAssignment` at the end of the signature (after `geoRegistry?: GeoViewRegistry`).
4. In `createContext(pluginName)`, append these methods to the returned object:

```ts
requestDeviceAssignment: (deviceSerial, tenantName) => {
  if (!this.dta) {
    logger.warn('requestDeviceAssignment called but DeviceTenantAssignment not provided', { deviceSerial })
    return { ok: false, reason: 'already_claimed', current_tenant: '__unconfigured__', current_plugin: '__none__' }
  }
  return this.dta.claim(deviceSerial, tenantName, pluginName)
},
assertSenderInTenant: (senderPhone, tenantName) => {
  if (!this.senderMapping) {
    return { ok: false, reason: 'phone_not_found' }
  }
  const r = this.senderMapping.setSenderTenant(senderPhone, tenantName)
  return r
},
releaseDeviceAssignment: (deviceSerial) => {
  if (!this.dta) return { ok: false }
  return this.dta.release(deviceSerial, pluginName)
},
```

5. In `unloadPlugin(name)` and `destroyAll()`, after the existing `geoRegistry?.unregisterPlugin(name)`, add:

```ts
const released = this.dta?.releaseByPlugin(name) ?? 0
if (released > 0) {
  this.loggerFactory.child({ plugin: name }).info('Released device assignments on destroy', { count: released })
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @dispatch/core build`
Expected: TypeScript clean. No new tests yet — those come in Task 6.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/plugins/types.ts packages/core/src/plugins/plugin-loader.ts
git commit -m "feat(sdr-G3): PluginContext requestDeviceAssignment + assertSenderInTenant + releaseDeviceAssignment"
```

---

### Task 6: G3 tests — wiring + auto-release

**Files:**
- Modify: `packages/core/src/plugins/plugin-loader.test.ts`

- [ ] **Step 1: Write failing tests**

In `plugin-loader.test.ts`, append a new describe at end (before final closing brace):

```ts
import { DeviceTenantAssignment } from '../engine/device-tenant-assignment.js'

describe('PluginContext device + tenant APIs', () => {
  it('requestDeviceAssignment routes through DTA with caller pluginName', async () => {
    const dta = new DeviceTenantAssignment(db)
    const loader = makeLoaderWithDTA(dta)
    let capturedCtx: PluginContext | null = null
    ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx) => { capturedCtx = ctx })
    await loader.load(plugin)
    const r = capturedCtx!.requestDeviceAssignment('devA', 'oralsin-sdr')
    expect(r.ok).toBe(true)
    expect(dta.getAssignment('devA')).toMatchObject({ tenant_name: 'oralsin-sdr', claimed_by_plugin: plugin.name })
  })

  it('releaseDeviceAssignment rejects non-owner', async () => {
    const dta = new DeviceTenantAssignment(db)
    dta.claim('devB', 'oralsin-sdr', 'other-plugin')
    const loader = makeLoaderWithDTA(dta)
    let capturedCtx: PluginContext | null = null
    ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx) => { capturedCtx = ctx })
    await loader.load(plugin)
    const r = capturedCtx!.releaseDeviceAssignment('devB')
    expect(r.ok).toBe(false)
    expect(dta.getAssignment('devB')).not.toBeNull()
  })

  it('plugin.destroy releases all devices claimed by that plugin', async () => {
    const dta = new DeviceTenantAssignment(db)
    const loader = makeLoaderWithDTA(dta)
    ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx) => {
      ctx.requestDeviceAssignment('devC', 'oralsin-sdr')
      ctx.requestDeviceAssignment('devD', 'oralsin-sdr')
    })
    await loader.load(plugin)
    expect(dta.list()).toHaveLength(2)
    await loader.unload(plugin.name)
    expect(dta.list()).toHaveLength(0)
  })

  it('assertSenderInTenant rejects conflicting tenant', async () => {
    senderMap.upsert({ phoneNumber: '554399000200', deviceSerial: 'devX' })
    senderMap.setSenderTenant('554399000200', 'sicoob-sdr')
    const dta = new DeviceTenantAssignment(db)
    const loader = makeLoaderWithDTA(dta)
    let capturedCtx: PluginContext | null = null
    ;(plugin.init as ReturnType<typeof vi.fn>).mockImplementation(async (ctx) => { capturedCtx = ctx })
    await loader.load(plugin)
    const r = capturedCtx!.assertSenderInTenant('554399000200', 'oralsin-sdr')
    expect(r.ok).toBe(false)
    if (!r.ok && r.reason === 'conflicting_tenant') expect(r.current_tenant).toBe('sicoob-sdr')
  })
})
```

Add a `makeLoaderWithDTA(dta)` helper at the top of the file that constructs a `PluginLoader` with the existing test args plus the new `dta` and `senderMap` injected. Pattern: same as how the existing tests construct the loader, with the extra arg appended.

- [ ] **Step 2: Run tests, verify fail / pass**

Run: `pnpm --filter @dispatch/core test src/plugins/plugin-loader.test.ts -t "device \\+ tenant APIs"`
Expected: PASS (G3 implementation already there from Task 5; this task is the validation).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/plugins/plugin-loader.test.ts
git commit -m "test(sdr-G3): plugin-loader wires DTA + auto-releases on destroy"
```

---

### Task 7: G5 — Response webhook tightening (cross-tenant drop)

**Files:**
- Modify: `packages/core/src/server.ts` (around lines 1115-1145, the response callback dispatcher)
- Create: `packages/core/src/api/response-routing.test.ts` (new integration test)

- [ ] **Step 1: Read the existing routing code**

Open `packages/core/src/server.ts` and locate the block starting at `// Find the most recent outgoing message to this patient` (around line 1115). Note that it currently:
1. Queries `messageHistory.query` for the last outgoing matching `(from=sender, to=lead)`.
2. Gets the queue msg by `messageId`.
3. If `msg.pluginName` exists, calls `sendResponseCallback(pluginName, msgId, payload)`.

- [ ] **Step 2: Add tightening logic**

Replace the block with:

```ts
// Find the most recent outgoing message to this patient
const history = messageHistory.query({
  fromNumber: data.toNumber,
  toNumber: data.fromNumber,
  direction: 'outgoing',
  limit: 1,
})
if (history.length === 0 || !history[0].messageId) return

const dispatchMsgId = history[0].messageId
const msg = queue.getById(dispatchMsgId)
if (!msg?.pluginName) return

// G5 — tenant tightening: if sender has a tenant AND msg has tenant_hint,
// they MUST match. Drops cross-tenant routing (I4 in spec §8).
// Reversible via env DISPATCH_RESPONSE_STRICT_TENANT=false.
const strictTenant = process.env.DISPATCH_RESPONSE_STRICT_TENANT !== 'false'
if (strictTenant) {
  const senderRec = senderMapping.getByPhone(data.toNumber)
  const senderTenant = senderRec?.tenant ?? null
  const msgTenant = msg.tenantHint ?? null
  if (senderTenant !== null && msgTenant !== null && senderTenant !== msgTenant) {
    server.log.warn({
      msg_id: msg.id,
      sender_tenant: senderTenant,
      msg_tenant: msgTenant,
      from: data.fromNumber,
      via: data.toNumber,
    }, 'response routing dropped — sender/msg tenant mismatch')
    return  // do NOT deliver callback
  }
}

const incomingHistory = messageHistory.query({ fromNumber: data.fromNumber, limit: 1 })
const replyText = incomingHistory.length > 0 ? (incomingHistory[0].text ?? '') : ''

void callbackDelivery.sendResponseCallback(msg.pluginName, msg.id, {
  idempotency_key: msg.idempotencyKey,
  message_id: msg.id,
  event: 'patient_response',
  response: {
    body: replyText,
    received_at: new Date().toISOString(),
    from_number: data.fromNumber,
    has_media: false,
  },
})
```

- [ ] **Step 3: Write integration test**

Create `packages/core/src/api/response-routing.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { MessageHistory } from '../waha/message-history.js'
import { SenderMapping } from '../engine/sender-mapping.js'
import { CallbackDelivery } from '../plugins/callback-delivery.js'
// import the response-routing hook installer or expose it via a small fn
// ... full setup details depend on current server.ts factoring

describe('G5 response tightening', () => {
  // ... mock senderMapping, messageHistory, queue, callbackDelivery
  // ... 4 scenarios: legacy/legacy (delivers), same-tenant/same-tenant (delivers),
  //     legacy-sender/tenant-msg (delivers — null on sender side), mismatch (drops)

  it('delivers when both sender and msg are legacy (no tenant)', () => { /* ... */ })
  it('delivers when sender tenant matches msg tenantHint', () => { /* ... */ })
  it('delivers when sender has tenant but msg.tenantHint is null', () => { /* ... */ })
  it('drops when sender tenant ≠ msg tenantHint', () => { /* ... */ })
})
```

(Full test code: if server.ts factoring makes integration awkward, extract the routing logic into `packages/core/src/api/response-router.ts` as a pure function `routeResponse({ senderMapping, queue, ... })` and test that. Keep server.ts call site thin.)

- [ ] **Step 4: Run tests, commit**

```bash
pnpm --filter @dispatch/core test src/api/response-routing.test.ts
git add packages/core/src/server.ts packages/core/src/api/response-routing.test.ts
git commit -m "feat(sdr-G5): response tightening — drop cross-tenant responses"
```

---

### Task 8: Wire DeviceTenantAssignment into server.ts boot

**Files:**
- Modify: `packages/core/src/server.ts`

- [ ] **Step 1: Read current PluginLoader instantiation**

Locate `const pluginLoader = new PluginLoader(...)` in `server.ts` (around line 745). Currently the call is:
```ts
new PluginLoader(pluginRegistry, pluginEventBus, queue, db, pinoLogger, senderMapping, engine, idempotencyCache, deviceMutex, undefined, geoRegistry)
```

- [ ] **Step 2: Add DTA instantiation + pass to loader + pass to queue**

Add before the loader:
```ts
import { DeviceTenantAssignment } from './engine/device-tenant-assignment.js'

// G2 — device-tenant assignment service. Plugins claim via ctx.requestDeviceAssignment.
const deviceTenantAssignment = new DeviceTenantAssignment(db)
```

Note: queue is instantiated earlier in server.ts. Find that line and add the DTA option:
```ts
// Find existing: const queue = new MessageQueue(db)
// Replace with:
const queue = new MessageQueue(db, { dta: deviceTenantAssignment })
```

Add `deviceTenantAssignment` as the last arg of `new PluginLoader(...)`:
```ts
const pluginLoader = new PluginLoader(
  pluginRegistry, pluginEventBus, queue, db, pinoLogger,
  senderMapping, engine, idempotencyCache, deviceMutex,
  undefined, geoRegistry, deviceTenantAssignment,
)
```

- [ ] **Step 3: Build, smoke**

```bash
pnpm --filter @dispatch/core build
pnpm --filter @dispatch/core test
```

Expected: all tests still pass (1893+ existing + new from Tasks 1-7).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/server.ts
git commit -m "feat(sdr): wire DeviceTenantAssignment in server boot + queue + loader"
```

---

### Task 9: Full backend test pass + smoke

- [ ] **Step 1: Full suite**

```bash
pnpm --filter @dispatch/core test
```

Expected: all green (target: 1893+ tests including ~25 new from Tasks 1-7).

- [ ] **Step 2: Manual smoke — DTA via SQL**

```bash
cd /var/www/adb_tools/packages/core
pnpm dev  # boots core
```

In another shell:
```bash
sqlite3 dispatch.db ".schema device_tenant_assignment"
# Expected: shows the CREATE TABLE
sqlite3 dispatch.db "PRAGMA table_info('sender_mapping')" | grep tenant
# Expected: 1 row with column 'tenant'
sqlite3 dispatch.db "PRAGMA table_info('messages')" | grep tenant_hint
# Expected: 1 row
```

Kill core (Ctrl+C).

- [ ] **Step 3: No commit (smoke only)**

---

### Task 10: Document feature flags + rollback procedure

**Files:**
- Modify: `docs/operations/dispatch-runbook.md` (or create if absent — check first)

- [ ] **Step 1: Check if runbook exists**

Run: `ls docs/operations/dispatch-runbook.md 2>/dev/null`
If exists, append. If not, create.

- [ ] **Step 2: Add a feature-flags section**

```markdown
## SDR-related feature flags

### `DISPATCH_QUEUE_TENANT_FILTER`
- Default: `true` (filter enabled — G2 active)
- Set `false` to disable the tenant-aware dequeue filter; queue reverts to legacy behavior (any msg to any device).
- Use ONLY for emergency rollback after deploying the SDR plugin.

### `DISPATCH_RESPONSE_STRICT_TENANT`
- Default: `true` (G5 tightening on)
- Set `false` to revert response routing to legacy behavior (matches by phone alone, no tenant check).
- Use for emergency rollback.

### Rollback order
If SDR is misbehaving in prod:
1. Disable SDR plugin via admin: `POST /api/v1/admin/plugins/debt-sdr/disable`
2. If still issues: set `DISPATCH_QUEUE_TENANT_FILTER=false`, restart core
3. If still issues: set `DISPATCH_RESPONSE_STRICT_TENANT=false`, restart core
4. Investigate; once fixed, re-enable in reverse order.
```

- [ ] **Step 3: Commit**

```bash
git add docs/operations/dispatch-runbook.md
git commit -m "docs(sdr): feature flags + rollback procedure for G2/G5"
```

---

## FASE B — Plugin scaffold

### Task 11: Plugin package scaffold

**Files:**
- Create: `packages/plugins/debt-sdr/package.json`
- Create: `packages/plugins/debt-sdr/tsconfig.json`
- Create: `packages/plugins/debt-sdr/src/index.ts`
- Create: `packages/plugins/debt-sdr/src/sdr-plugin.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@dispatch/plugin-debt-sdr",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "better-sqlite3": "*",
    "ulid": "^2.3.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "*",
    "@types/node": "*",
    "typescript": "*",
    "vitest": "*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "composite": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Empty plugin entry**

`packages/plugins/debt-sdr/src/index.ts`:
```ts
export { DebtSdrPlugin } from './sdr-plugin.js'
```

`packages/plugins/debt-sdr/src/sdr-plugin.ts`:
```ts
import type { DispatchPlugin, PluginContext } from '@dispatch/core/plugins/types.js'
import type { DispatchEventName } from '@dispatch/core/events/index.js'

export class DebtSdrPlugin implements DispatchPlugin {
  name = 'debt-sdr' as const
  version = '0.1.0'
  manifest = {
    name: 'debt-sdr',
    version: '0.1.0',
    sdkVersion: '^1.0.0',
    description: 'Sales Development Representative outbound — multi-tenant Pipedrive-driven cold outreach with identity gate, hybrid classifier (regex+LLM), and Pipedrive writeback',
    author: 'DEBT',
  }
  events: DispatchEventName[] = ['message:sent', 'message:failed']
  webhookUrl: string

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl
  }

  async init(_ctx: PluginContext): Promise<void> {
    // Filled in Task 14
  }

  async destroy(): Promise<void> {
    // Filled in Task 15
  }
}
```

- [ ] **Step 4: pnpm install + build**

```bash
cd /var/www/adb_tools
pnpm install
pnpm --filter @dispatch/plugin-debt-sdr build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/debt-sdr/ pnpm-lock.yaml
git commit -m "feat(sdr-B11): plugin package scaffold (empty init/destroy)"
```

---

### Task 12: Tenant config Zod schema + cross-field validation

**Files:**
- Create: `packages/plugins/debt-sdr/src/config/tenant-config.ts`
- Create: `packages/plugins/debt-sdr/src/config/tenant-config.test.ts`

(Full Zod schema with strict validation: phone regex, app enum, time HH:MM format, operating_hours start<end refinement, identity_gate abort_after>nudge_after, and **cross-tenant superRefine** rejecting duplicate tenant names, duplicate device serials across tenants, duplicate (phone,app) pairs across tenants.)

- [ ] **Step 1-4**: see spec §5.1 for schema shape. Write the file with full Zod schema mirroring the JSON example in spec, plus the test file with the 9 cases listed in section 7 (test pyramid: 9 test cases on validator). Run tests; expect all 9 to pass after impl.

- [ ] **Commit**

```bash
git commit -am "feat(sdr-B12): tenant config Zod schema + 9 validation tests"
```

---

### Task 13: SDR database migrations

**Files:**
- Create: `packages/plugins/debt-sdr/src/db/migrations.ts`
- Create: `packages/plugins/debt-sdr/src/db/migrations.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initSdrSchema } from './migrations.js'

describe('SDR migrations', () => {
  it('creates all required tables', () => {
    const db = new Database(':memory:')
    initSdrSchema(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    expect(tables).toEqual(expect.arrayContaining([
      'sdr_lead_queue', 'sdr_sequence_state', 'sdr_contact_identity',
      'sdr_classifier_log', 'sdr_pending_writebacks',
    ]))
  })

  it('is idempotent (safe to re-run)', () => {
    const db = new Database(':memory:')
    initSdrSchema(db)
    expect(() => initSdrSchema(db)).not.toThrow()
  })

  it('enforces UNIQUE(tenant, pipedrive_deal_id) on sdr_lead_queue', () => {
    const db = new Database(':memory:')
    initSdrSchema(db)
    db.prepare('INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('id1', 'oralsin-sdr', 100, '554399999991', 'X', 'now', 'pulled', 'now', 'now')
    expect(() =>
      db.prepare('INSERT INTO sdr_lead_queue (id, tenant, pipedrive_deal_id, contact_phone, contact_name, pulled_at, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('id2', 'oralsin-sdr', 100, '554399999991', 'X', 'now', 'pulled', 'now', 'now')
    ).toThrow(/UNIQUE/)
  })
})
```

- [ ] **Step 2: Implement migrations**

`packages/plugins/debt-sdr/src/db/migrations.ts`:

```ts
import type Database from 'better-sqlite3'

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sdr_lead_queue (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    pipedrive_deal_id INTEGER NOT NULL,
    contact_phone TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    pipedrive_context_json TEXT,
    pulled_at TEXT NOT NULL,
    state TEXT NOT NULL,
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant, pipedrive_deal_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_lead_state ON sdr_lead_queue(state, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_lead_tenant ON sdr_lead_queue(tenant, state)`,

  `CREATE TABLE IF NOT EXISTS sdr_sequence_state (
    lead_id TEXT PRIMARY KEY REFERENCES sdr_lead_queue(id) ON DELETE CASCADE,
    sequence_id TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    next_action_at TEXT NOT NULL,
    last_message_id TEXT,
    last_message_sent_at TEXT,
    last_response_at TEXT,
    last_response_classification TEXT,
    attempts_total INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    processing_lock TEXT,
    processing_lock_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_seq_ready ON sdr_sequence_state(status, next_action_at)`,

  `CREATE TABLE IF NOT EXISTS sdr_contact_identity (
    tenant TEXT NOT NULL,
    sender_phone TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    state TEXT NOT NULL,
    intro_message_id TEXT,
    nudge_message_id TEXT,
    classification TEXT,
    classifier_confidence REAL,
    raw_response TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant, sender_phone, contact_phone)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sdr_identity_pending ON sdr_contact_identity(state, updated_at) WHERE state IN ('pending')`,

  `CREATE TABLE IF NOT EXISTS sdr_classifier_log (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    response_text TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL NOT NULL,
    source TEXT NOT NULL,
    llm_reason TEXT,
    latency_ms INTEGER NOT NULL,
    classified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_classifier_lead ON sdr_classifier_log(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_classifier_source ON sdr_classifier_log(source, classified_at)`,

  `CREATE TABLE IF NOT EXISTS sdr_pending_writebacks (
    id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT NOT NULL,
    abandoned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_writeback_pending ON sdr_pending_writebacks(next_attempt_at, abandoned_at) WHERE abandoned_at IS NULL`,
]

export function initSdrSchema(db: Database.Database): void {
  for (const stmt of STATEMENTS) {
    db.prepare(stmt).run()
  }
}
```

- [ ] **Step 3: Run, commit**

```bash
pnpm --filter @dispatch/plugin-debt-sdr test
git add packages/plugins/debt-sdr/src/db/
git commit -m "feat(sdr-B13): plugin SQLite migrations (5 tables, idempotent via prepare/run)"
```

Expected: 3 tests pass.

---

### Task 14: Plugin `init()` — claim devices + assert senders + run migrations

**Files:**
- Modify: `packages/plugins/debt-sdr/src/sdr-plugin.ts`
- Create: `packages/plugins/debt-sdr/src/sdr-plugin.test.ts`

Implement full init flow per spec §3 + §5:
1. Parse config via Zod; throw on invalid
2. Run migrations (`initSdrSchema(db)`)
3. **Preflight**: for each device in each tenant, query `sender_mapping WHERE device_serial=? AND tenant IS NOT NULL AND tenant != tenant_name` — fail loud listing conflicts (A9 defense).
4. Claim each device via `ctx.requestDeviceAssignment`; throw on conflict.
5. Assert each sender via `ctx.assertSenderInTenant`; throw on conflict.
6. Store parsed config on instance for later use.

Tests (write first, fail, implement, pass):
- claims all devices and asserts senders successfully
- throws if any device claim fails (mock ctx returns `already_claimed`)
- throws if any sender assert fails (mock ctx returns `conflicting_tenant`)
- preflight rejects cross-tenant senders on target devices (insert into sender_mapping then init)
- runs migrations on init

Constructor signature: `constructor(webhookUrl: string, rawConfig: unknown, db: Database.Database)`.

Commit: `"feat(sdr-B14): init flow — preflight, claim devices, assert senders, run migrations"`

---

### Task 15: Plugin `destroy()` — release devices + stop crons

**Files:**
- Modify: `packages/plugins/debt-sdr/src/sdr-plugin.ts`

Implementation:

```ts
async destroy(): Promise<void> {
  if (!this.ctx) return
  if (this.pullCronTimer) clearInterval(this.pullCronTimer)
  if (this.sequencerCronTimer) clearInterval(this.sequencerCronTimer)
  for (const { serial } of this.claimedDevices) {
    this.ctx.releaseDeviceAssignment(serial)
  }
  this.claimedDevices = []
  this.ctx.logger.info('debt-sdr destroyed')
  this.ctx = null
}
```

Tests:
- releases all claimed devices on destroy
- destroy without prior init is no-op
- destroy is idempotent (call twice = no throw)

Commit: `"feat(sdr-B15): destroy — release devices, stop crons, idempotent"`

---

### Task 16: Register debt-sdr in server boot

**Files:**
- Modify: `packages/core/src/server.ts`
- Create: `packages/plugins/debt-sdr/config.example.json`

- [ ] **Step 1: Example config**

Mirror the JSON in spec §5.1 with placeholder values `554399XXXXXXX` and tenant IDs from the real Pipedrive accounts (operator fills these before going live).

- [ ] **Step 2: Wire in server.ts pluginMap**

Find `const pluginMap` (around line 754) and add:

```ts
'debt-sdr': () => {
  const configPath = process.env.PLUGIN_DEBT_SDR_CONFIG_PATH ?? '/var/www/debt-adb-framework/packages/plugins/debt-sdr/config.json'
  if (!fs.existsSync(configPath)) {
    throw new Error(`debt-sdr requires config at ${configPath} (set PLUGIN_DEBT_SDR_CONFIG_PATH)`)
  }
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const webhookUrl = process.env.PLUGIN_DEBT_SDR_WEBHOOK_URL ?? 'http://localhost:7890/api/v1/plugins/debt-sdr/_loopback'
  return new DebtSdrPlugin(webhookUrl, rawConfig, db)
},
```

Add import: `import { DebtSdrPlugin } from '@dispatch/plugin-debt-sdr'`.

- [ ] **Step 3: Build root**

```bash
cd /var/www/adb_tools && pnpm -r build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/server.ts packages/plugins/debt-sdr/config.example.json
git commit -m "feat(sdr-B16): register debt-sdr plugin in server boot + example config"
```

---

### Task 17: Plugin smoke (load + init + destroy roundtrip)

- [ ] Set env vars locally (test config), boot core: `pnpm dev` 
- [ ] Check logs for "debt-sdr initialized" with both tenants
- [ ] `sqlite3 dispatch.db ".tables" | tr ' ' '\n' | grep -E "sdr_|device_tenant"` — confirm all 6 tables present
- [ ] `sqlite3 dispatch.db "SELECT * FROM device_tenant_assignment"` — confirm 2 rows (the 2 devices claimed)
- [ ] curl `/api/v1/admin/plugins` — confirm `debt-sdr` is in active list
- [ ] Kill core; restart — confirm assignment table persists
- [ ] No commit (smoke only)

---

## FASE C — Classifier + Identity Gate

### Task 18: Regex patterns (data file)

**Files:**
- Create: `packages/plugins/debt-sdr/src/classifier/regex-patterns.ts`

```ts
export type ClassificationCategory =
  | 'identity_confirm' | 'identity_deny'
  | 'interested' | 'not_interested' | 'question'
  | 'opted_out' | 'ambiguous'

export const PATTERNS: Record<Exclude<ClassificationCategory, 'ambiguous'>, RegExp[]> = {
  opted_out: [
    /\bpar[ae] de mandar\b/i,
    /\bcancela\b/i,
    /\bn[aã]o me (envie|mande|chame) mais\b/i,
    /\bdescadastr/i,
    /\bsa(i|ir) (dess?a|do) (lista|grupo)\b/i,
    /\bn[aã]o tenho interesse.*n[aã]o (envie|mande)/i,
    /\bbloqu(ei|eando)/i,
    /\bstop\b/i,
    /\bunsubscribe/i,
  ],
  identity_deny: [
    /\bn[aã]o sou (eu|esse|esta|aquele|o|a)\b/i,
    /\b(n[uú]mero|telefone) errado\b/i,
    /\bn[aã]o conhe[çc]o\b/i,
    /\bengano\b/i,
    /\bvoc[eê] est[aá] enganad/i,
    /\bnunca ouvi\b/i,
  ],
  identity_confirm: [
    /^\s*sim\s*[\.,!]*\s*$/i,
    /^\s*sou\s*(eu)?\s*[\.,!]*\s*$/i,
    /\bsim,?\s*sou (eu|o|a)\b/i,
    /\bsou (o|a)\b/i,
    /^\s*(oi|ol[aá]|opa|fala|e[ai]\s*a[ií])\s*[\.,!?]*\s*$/i,
    /\bbom dia\s*[\.,!]*\s*$/i,
    /\bboa (tarde|noite)\s*[\.,!]*\s*$/i,
  ],
  not_interested: [
    /\bn[aã]o (tenho|estou) interess/i,
    /\b(agora )?n[aã]o (quero|preciso|posso)\b/i,
    /\bn[aã]o obrigad[oa]\b/i,
    /\bdispenso\b/i,
    /\bj[aá] resolvi\b/i,
  ],
  interested: [
    /\b(tenho|fiquei) interess/i,
    /\b(me )?(conta|explica|fala) mais\b/i,
    /\bquero saber\b/i,
    /\bqual (a|é) (proposta|oferta|condi[çc][aã]o)\b/i,
    /\bbora\b/i,
    /\baceito\b/i,
  ],
  question: [
    /\?\s*$/,
    /\bcomo (funciona|assim|seria)\b/i,
    /\bo que (é|seria)\b/i,
    /\bn[aã]o entendi\b/i,
  ],
}

// Priority order: opt-out > identity_deny > identity_confirm > rest
export const PRIORITY: Array<keyof typeof PATTERNS> = [
  'opted_out', 'identity_deny', 'identity_confirm',
  'interested', 'not_interested', 'question',
]
```

Commit: `"feat(sdr-C18): classifier regex patterns + priority ordering"`

---

### Task 19: Regex classifier function + tests

**Files:**
- Create: `packages/plugins/debt-sdr/src/classifier/regex-classifier.ts`
- Create: `packages/plugins/debt-sdr/src/classifier/regex-classifier.test.ts`

```ts
// regex-classifier.ts
import { PATTERNS, PRIORITY, type ClassificationCategory } from './regex-patterns.js'

export function regexClassify(text: string): { category: ClassificationCategory; confidence: 1.0 } | null {
  const normalized = text.trim()
  for (const cat of PRIORITY) {
    for (const pattern of PATTERNS[cat]) {
      if (pattern.test(normalized)) return { category: cat, confidence: 1.0 }
    }
  }
  return null
}
```

Tests (`regex-classifier.test.ts`): use the `RESPONSE_SAMPLES` fixture from spec §7. ~25 tests covering each category's positive matches + priority (opt-out beats identity_deny in "não sou eu, para de mandar").

Commit: `"feat(sdr-C19): regex classifier with priority order + 25 pattern tests"`

---

### Task 20: LLM classifier (Anthropic SDK + mock)

**Files:**
- Create: `packages/plugins/debt-sdr/src/classifier/llm-classifier.ts`
- Create: `packages/plugins/debt-sdr/src/classifier/llm-classifier.test.ts`

Use `claude-haiku-4-5-20251001` per memory (Anthropic SDK Claude 4.X family). System prompt enforces JSON output `{category, confidence, reason}`. On parse failure or unknown category → returns `{category: 'ambiguous', confidence: 0, reason: 'llm_parse_failed'}`.

LLM client wrapped in interface for testability:

```ts
export interface LlmClient {
  classify(text: string, ctx: ClassifierContext): Promise<LlmClassification>
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private client: Anthropic, private model = 'claude-haiku-4-5-20251001') {}
  async classify(text, ctx): Promise<LlmClassification> { /* impl per spec §7.2 */ }
}
```

Tests use a `MockLlmClient` returning canned responses. 6 tests: valid response, low confidence → ambiguous, JSON parse error → ambiguous, unknown category → ambiguous, timeout, network error.

Commit: `"feat(sdr-C20): LLM classifier (Anthropic Haiku 4.5) + injectable interface"`

---

### Task 21: Classifier orchestrator (cascade)

**Files:**
- Create: `packages/plugins/debt-sdr/src/classifier/classifier.ts`
- Create: `packages/plugins/debt-sdr/src/classifier/classifier.test.ts`

```ts
export class ResponseClassifier {
  constructor(
    private llm: LlmClient,
    private llmConfidenceThreshold = 0.7,
    private metricsRegistry?: PluginMetricsRegistry,
  ) {}

  async classify(text: string, ctx: ClassifierContext): Promise<Classification> {
    const t0 = Date.now()
    const regexResult = regexClassify(text)
    if (regexResult) {
      this.metricsRegistry?.observeClassification('regex', regexResult.category, Date.now() - t0)
      // Phase gating
      if (ctx.phase === 'identity' && !IDENTITY_ALLOWED.has(regexResult.category)) {
        return { category: 'ambiguous', confidence: 0, source: 'phase_gate', original: regexResult }
      }
      return { ...regexResult, source: 'regex' }
    }
    try {
      const llmResult = await this.llm.classify(text, ctx)
      this.metricsRegistry?.observeClassification('llm', llmResult.category, Date.now() - t0)
      if (llmResult.confidence < this.llmConfidenceThreshold) {
        return { category: 'ambiguous', confidence: llmResult.confidence, source: 'llm_low_conf', original: llmResult }
      }
      if (ctx.phase === 'identity' && !IDENTITY_ALLOWED.has(llmResult.category)) {
        return { category: 'ambiguous', confidence: llmResult.confidence, source: 'phase_gate', original: llmResult }
      }
      return { ...llmResult, source: 'llm' }
    } catch (err) {
      this.metricsRegistry?.observeClassification('llm_error', 'ambiguous', Date.now() - t0)
      return { category: 'ambiguous', confidence: 0, source: 'llm_error', error: String(err) }
    }
  }
}

const IDENTITY_ALLOWED = new Set(['identity_confirm', 'identity_deny', 'opted_out'])
```

Tests: 10 cases — regex hit returns immediately, regex miss → LLM, LLM low conf → ambiguous, LLM error → ambiguous, phase gating drops non-identity in identity phase (regex AND LLM paths).

Commit: `"feat(sdr-C21): classifier orchestrator (cascade regex→LLM + phase gating)"`

---

### Task 22: Classifier audit log

**Files:**
- Create: `packages/plugins/debt-sdr/src/classifier/classifier-log.ts`
- Create: `packages/plugins/debt-sdr/src/classifier/classifier-log.test.ts`

Persist every classification (regex hit, LLM call, errors) to `sdr_classifier_log` for periodic regex training.

```ts
export class ClassifierLog {
  constructor(private db: Database.Database) {}

  record(entry: {
    lead_id: string; message_id: string; response_text: string;
    category: ClassificationCategory; confidence: number;
    source: string; llm_reason?: string; latency_ms: number;
  }): void {
    this.db.prepare(`
      INSERT INTO sdr_classifier_log (id, lead_id, message_id, response_text, category, confidence, source, llm_reason, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ulid(), entry.lead_id, entry.message_id, entry.response_text, entry.category, entry.confidence, entry.source, entry.llm_reason ?? null, entry.latency_ms)
  }

  // Helper for periodic analysis — extract patterns from LLM hits to add as regex
  topLlmCategories(sinceIso: string, limit = 50): Array<{ category: string; count: number; sample_texts: string[] }> {
    // Aggregation query
  }
}
```

Tests: 3 cases — record persists, topLlmCategories groups correctly, latency_ms is int.

Commit: `"feat(sdr-C22): classifier audit log + topLlmCategories helper for regex training"`

---

### Task 23: Identity gate templates + selector

**Files:**
- Create: `packages/plugins/debt-sdr/src/identity-gate/templates.ts`
- Create: `packages/plugins/debt-sdr/src/identity-gate/template-selector.ts`
- Create: `packages/plugins/debt-sdr/src/identity-gate/template-selector.test.ts`

`templates.ts`: 25 INTRO_TEMPLATES + 12 NUDGE_TEMPLATES (pt-BR, varied tone, casual). Per spec §4.4.

`template-selector.ts`: deterministic selector via `sha256(contact_phone)`:

```ts
import { createHash } from 'node:crypto'

export function selectTemplate(pool: string[], contactPhone: string, salt = ''): string {
  const hash = createHash('sha256').update(salt + contactPhone).digest('hex').slice(0, 8)
  const idx = parseInt(hash, 16) % pool.length
  return pool[idx]
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`)
}
```

Tests:
- same phone → same template (deterministic)
- different phones → different templates (statistical: 100 phones, expect spread across pool)
- renderTemplate substitutes vars
- renderTemplate leaves unknown placeholders intact

Commit: `"feat(sdr-C23): identity-gate template pool (25 intro + 12 nudge) + hash-based selector"`

---

### Task 24: Identity gate state machine

**Files:**
- Create: `packages/plugins/debt-sdr/src/identity-gate/identity-gate.ts`
- Create: `packages/plugins/debt-sdr/src/identity-gate/identity-gate.test.ts`

State machine per spec §4.3. API:

```ts
export class IdentityGate {
  constructor(
    private db: Database.Database,
    private enqueue: (params: PluginEnqueueParams) => PluginMessage[],
    private templatePools: { intro: string[]; nudge: string[] },
  ) {}

  /**
   * Check current state. Returns 'no_history' if zero outgoing exists yet
   * (caller initiates handshake). Otherwise returns the existing state.
   */
  check(tenant: string, sender: string, contactPhone: string, hasOutgoingHistory: boolean):
    | { state: 'no_history' }      // never sent → handshake first
    | { state: 'has_history' }     // existing thread → skip gate
    | { state: 'pending' | 'verified' | 'wrong_number' | 'opted_out' | 'no_response' }
  
  /**
   * Initiate handshake. Enqueues intro template + creates pending row.
   */
  kickoff(tenant: string, sender: string, contact: ContactRef): { ok: true; messageId: string }
  
  /**
   * Process classifier result for an identity message.
   */
  handleClassification(tenant: string, sender: string, contactPhone: string, result: Classification): void
  
  /**
   * Called by cron when nudge_after_hours elapsed without response.
   */
  triggerNudge(tenant: string, sender: string, contact: ContactRef): { ok: true; messageId: string }
  
  /**
   * Called by cron when abort_after_hours elapsed → state=no_response.
   */
  markNoResponse(tenant: string, sender: string, contactPhone: string): void
}
```

Tests (per spec §11): 20 tests covering each state transition, gating rule (has outgoing → skip), template selection, idempotent kickoff, etc.

Commit: `"feat(sdr-C24): identity-gate state machine — kickoff/check/handleClassification/triggerNudge/markNoResponse"`

---

### Task 25: Identity gate integration with classifier

**Files:**
- Modify: `packages/plugins/debt-sdr/src/identity-gate/identity-gate.ts`
- Create: `packages/plugins/debt-sdr/src/identity-gate/identity-gate.integration.test.ts`

`handleClassification` consumes `Classification` from ResponseClassifier (Task 21). For each category in identity phase:

| Classifier category | IdentityGate state | Side effect |
|---|---|---|
| `identity_confirm` | `verified` | None (sequencer kicks off cold-1 next tick) |
| `identity_deny` | `wrong_number` | Add to temporary blacklist 30d (call core `queue.blacklist(phone, 'sdr_wrong_number_30d')`) |
| `opted_out` | `opted_out` | Permanent blacklist (`queue.blacklist(phone, 'sdr_opt_out')`) |
| `ambiguous` | unchanged | Emit operator alert event |

Integration test: full roundtrip — handshake enqueued → mock response → classifier → handleClassification → state transition verified in DB.

Commit: `"feat(sdr-C25): identity-gate + classifier integration tests (4 outcome branches)"`

---

### Task 26: Operator alert event emitter

**Files:**
- Create: `packages/plugins/debt-sdr/src/operator-alerts.ts`

Plugin-internal event-like channel for ambiguous classifications. Persists to a small `sdr_operator_alerts` table (add to migrations.ts) + exposes a route `GET /api/v1/plugins/debt-sdr/alerts?since=...&unresolved=true` (route impl in Task 39).

Schema:
```sql
CREATE TABLE IF NOT EXISTS sdr_operator_alerts (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, lead_id TEXT NOT NULL,
  message_id TEXT NOT NULL, response_text TEXT NOT NULL, reason TEXT NOT NULL,
  llm_reason TEXT, raised_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON sdr_operator_alerts(raised_at) WHERE resolved_at IS NULL;
```

(Add this CREATE statement to `STATEMENTS` array in `migrations.ts`.)

API:
```ts
export class OperatorAlerts {
  raise(...): void                       // insert row
  resolve(alertId, resolution): void     // mark resolved
  listUnresolved(tenant?): Alert[]
}
```

Tests: 4 — raise, resolve, listUnresolved by tenant, idempotent resolve.

Commit: `"feat(sdr-C26): operator alerts table + raise/resolve/listUnresolved"`

---

## FASE D — Sequencer + Pipedrive integration

### Task 27: TenantPipedriveClient (per-tenant HTTP client)

**Files:**
- Create: `packages/plugins/debt-sdr/src/pipedrive/tenant-pipedrive-client.ts`
- Create: `packages/plugins/debt-sdr/src/pipedrive/tenant-pipedrive-client.test.ts`

Self-contained HTTP client (no dep on adb-precheck — clean import boundary). 

```ts
export interface PipedriveDeal {
  id: number; title: string; stage_id: number;
  person_name?: string; phone?: Array<{ value: string; primary: boolean }>;
  custom_fields?: Record<string, unknown>;
}

export interface TenantPipedriveClientOpts {
  companyDomain: string; apiToken: string; fetcher?: typeof fetch; timeoutMs?: number;
}

export class TenantPipedriveClient {
  constructor(private opts: TenantPipedriveClientOpts) {}

  async getDealsByStage(stageId: number, opts: { limit: number; cursor?: string }):
    Promise<{ deals: PipedriveDeal[]; nextCursor?: string }> { /* GET /v2/deals?stage_id=...&limit=... */ }

  async updateDealStage(dealId: number, stageId: number): Promise<void> { /* PATCH /v2/deals/:id */ }

  async createActivity(dealId: number, payload: { type: string; subject: string; note: string }):
    Promise<{ id: number }> { /* POST /v2/activities */ }

  async addNote(dealId: number, content: string): Promise<{ id: number }> { /* POST /v2/notes */ }

  // Token bucket: 35 req/s soft limit (cap 80/2s)
  private async request(method: string, path: string, body?: unknown): Promise<Response> { /* with rate limiting + retry */ }
}
```

Tests with mocked `fetch`:
- getDealsByStage parses array, handles pagination
- updateDealStage sends correct payload
- createActivity sends correct shape
- 429 Retry-After respected
- 5xx retries 3x with exponential backoff
- 4xx (non-429) returns error without retry
- Token bucket throttles concurrent requests (10 tests)

Commit: `"feat(sdr-D27): TenantPipedriveClient with rate limiting + retry + 10 tests"`

---

### Task 28: Lead extractor

**Files:**
- Create: `packages/plugins/debt-sdr/src/pipedrive/lead-extractor.ts`
- Create: `packages/plugins/debt-sdr/src/pipedrive/lead-extractor.test.ts`

Extract phone + name from a `PipedriveDeal`. Uses Dispatch's `extractDdd` from core to validate phone is BR.

```ts
import { extractDdd } from '@dispatch/core/util/ddd.js'

export function extractLeadFromDeal(
  deal: PipedriveDeal,
  phoneFieldKey: string,
): { phone: string; name: string } | null {
  // phoneFieldKey: usually 'phone' (Pipedrive default) or a custom_fields key
  let rawPhone: string | undefined
  if (phoneFieldKey === 'phone' && deal.phone && deal.phone.length > 0) {
    const primary = deal.phone.find(p => p.primary) ?? deal.phone[0]
    rawPhone = primary?.value
  } else if (deal.custom_fields && phoneFieldKey in deal.custom_fields) {
    rawPhone = String(deal.custom_fields[phoneFieldKey])
  }
  if (!rawPhone) return null
  const ddd = extractDdd(rawPhone)
  if (!ddd) return null  // invalid BR phone
  // Normalize: digits-only, with leading 55 for storage consistency
  const digits = rawPhone.replace(/\D/g, '')
  const normalized = digits.startsWith('55') ? digits : `55${digits}`
  const name = deal.person_name ?? deal.title ?? `Lead ${deal.id}`
  return { phone: normalized, name: name.trim().slice(0, 200) }
}
```

Tests: 7 — primary phone, no phone returns null, invalid BR phone returns null, custom field path, name fallback to title, name truncation at 200, handles `+` and spaces.

Commit: `"feat(sdr-D28): lead extractor with BR phone validation + fallbacks"`

---

### Task 29: Lead puller (cron polling)

**Files:**
- Create: `packages/plugins/debt-sdr/src/pull/lead-puller.ts`
- Create: `packages/plugins/debt-sdr/src/pull/lead-puller.test.ts`

```ts
export class LeadPuller {
  constructor(
    private db: Database.Database,
    private clients: Map<string, TenantPipedriveClient>,
    private tenants: TenantConfig[],
    private blacklistCheck: (phone: string) => boolean,
    private logger: PluginLogger,
  ) {}

  /**
   * One pull cycle: for each tenant, fetch deals at config stage, dedup,
   * blacklist filter, insert new rows into sdr_lead_queue.
   */
  async pullAll(): Promise<{ pulled: number; skipped: number; per_tenant: Record<string, { pulled: number; skipped: number }> }> {
    /* per spec §5.4 */
  }
  
  private alreadyPulled(tenant: string, dealId: number): boolean {
    return this.db.prepare('SELECT 1 FROM sdr_lead_queue WHERE tenant = ? AND pipedrive_deal_id = ?').get(tenant, dealId) !== undefined
  }
}
```

Tests with mocked client:
- Inserts new leads (1)
- Idempotent: same deal pulled twice → 1 row (1)
- Blacklist check filters phone (1)
- Multi-tenant: pulls Oralsin AND Sicoob, isolated (1)
- Invalid phone (extractor returns null) → skipped (1)
- Pipedrive client error → logged, skips tenant, continues with next tenant (1)
- Idempotent across plugin restart (insert after restart, query reflects prior state) (1)

Commit: `"feat(sdr-D29): lead puller — multi-tenant, idempotent, blacklist-aware, error-tolerant"`

---

### Task 30: Sequence definitions + template pools

**Files:**
- Create: `packages/plugins/debt-sdr/src/sequences/sequence-definition.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/oralsin-cold-v1.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/sicoob-cold-v1.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/template-pools/oralsin-cold-1-pt-br.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/template-pools/oralsin-cold-2-pt-br.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/template-pools/oralsin-cold-3-pt-br.ts`
- (Same 3 for sicoob)

`sequence-definition.ts`:
```ts
export interface SequenceStep {
  step: number; name: string;
  delay_from_previous_hours: number; ttl_hours: number;
  template_pool_id: string;
}
export interface SequenceDefinition {
  id: string; max_attempts: number; steps: SequenceStep[];
}
```

`oralsin-cold-v1.ts`:
```ts
export const oralsinColdV1: SequenceDefinition = {
  id: 'oralsin-cold-v1', max_attempts: 3,
  steps: [
    { step: 1, name: 'cold-1', delay_from_previous_hours: 0,  ttl_hours: 48, template_pool_id: 'oralsin-cold-1-pt-br' },
    { step: 2, name: 'cold-2', delay_from_previous_hours: 48, ttl_hours: 72, template_pool_id: 'oralsin-cold-2-pt-br' },
    { step: 3, name: 'cold-3', delay_from_previous_hours: 72, ttl_hours: 96, template_pool_id: 'oralsin-cold-3-pt-br' },
  ],
}
```

(`sicoob-cold-v1.ts` analogous — adjust template pool IDs.)

Template pools — 7-10 variations per step, pt-BR, tone escalating cold-1 (most casual) → cold-3 (more direct). Per tenant brand voice.

`packages/plugins/debt-sdr/src/sequences/template-pools/oralsin-cold-1-pt-br.ts`:
```ts
export const ORALSIN_COLD_1 = [
  "Oi {nome}, tudo bem? Aqui é da Oralsin. Vi seu cadastro recente, posso te falar sobre uma proposta exclusiva?",
  "Olá {nome}! Sou da Oralsin. Tenho uma oferta especial pra te apresentar, tem 1min?",
  "Bom dia {nome}, aqui é da Oralsin. Conseguimos uma condição diferenciada pra você. Posso explicar?",
  "Oi {nome}! Da Oralsin aqui. Liberaram um benefício pra você essa semana, quer saber qual?",
  "Olá {nome}, tudo bem? Oralsin falando. Posso passar uns detalhes de uma oferta especial?",
  "Oi {nome}, aqui é da Oralsin. Tenho um benefício liberado pra você. Te interessa?",
  "Bom dia {nome}! Sou da Oralsin. Posso te chamar pra falar de uma proposta? Sem compromisso.",
]
```

(Same shape for cold-2/cold-3 with progressively more direct tone, and sicoob equivalents focused on credit/loan offers per the company.)

Tests: simple — load each pool, count entries (>=5), all templates have `{nome}` placeholder.

Commit: `"feat(sdr-D30): sequence definitions + template pools (oralsin + sicoob, 3 steps each)"`

---

### Task 31: Throttle gate (operating hours + daily max + min interval)

**Files:**
- Create: `packages/plugins/debt-sdr/src/throttle/throttle-gate.ts`
- Create: `packages/plugins/debt-sdr/src/throttle/throttle-gate.test.ts`

```ts
export class ThrottleGate {
  constructor(private db: Database.Database, private tenants: TenantConfig[]) {}

  /**
   * Check if a send is allowed for (tenant, sender) right now.
   * Returns ok:true or { ok:false, retry_at: ISO, reason: string }
   */
  check(tenantName: string, senderPhone: string): { ok: true } | { ok: false; retry_at: string; reason: string } {
    const tenant = this.tenants.find(t => t.name === tenantName)
    if (!tenant) return { ok: false, retry_at: '', reason: 'tenant_not_found' }

    // 1. Operating hours
    const inHours = this.isWithinOperatingHours(tenant)
    if (!inHours.ok) return { ok: false, retry_at: inHours.next_window_start, reason: 'outside_operating_hours' }

    // 2. Per-sender daily max — count sends today in messages table
    const startOfDay = this.tzAwareStartOfDay(tenant.throttle.tz)
    const sentToday = this.db.prepare(`
      SELECT COUNT(*) as c FROM messages
      WHERE sender_number = ? AND tenant_hint = ? AND status IN ('sent','sending','queued','locked')
      AND created_at >= ?
    `).get(senderPhone, tenantName, startOfDay) as { c: number }
    if (sentToday.c >= tenant.throttle.per_sender_daily_max) {
      return { ok: false, retry_at: this.nextDayStart(tenant.throttle.tz), reason: 'daily_max_reached' }
    }

    // 3. Min interval since last send
    const lastSent = this.db.prepare(`
      SELECT created_at FROM messages
      WHERE sender_number = ? AND tenant_hint = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(senderPhone, tenantName) as { created_at: string } | undefined
    if (lastSent) {
      const minIntervalMs = tenant.throttle.min_interval_minutes * 60_000
      const elapsedMs = Date.now() - new Date(lastSent.created_at).getTime()
      if (elapsedMs < minIntervalMs) {
        return { ok: false, retry_at: new Date(Date.now() + minIntervalMs - elapsedMs).toISOString(), reason: 'min_interval_not_elapsed' }
      }
    }
    return { ok: true }
  }
}
```

Tests: 8 — within hours OK, outside hours blocked, daily max enforced, min interval enforced, TZ math correct (São Paulo offset), retry_at calculated correctly.

Commit: `"feat(sdr-D31): ThrottleGate — operating hours + daily max + min interval per tenant"`

---

### Task 32: Sequencer — state machine core

**Files:**
- Create: `packages/plugins/debt-sdr/src/sequences/sequencer.ts`
- Create: `packages/plugins/debt-sdr/src/sequences/sequencer.test.ts`

```ts
export class Sequencer {
  constructor(
    private db: Database.Database,
    private ctx: PluginContext,
    private config: Config,
    private identityGate: IdentityGate,
    private throttle: ThrottleGate,
    private templatePools: Map<string, string[]>,  // pool_id -> templates
    private sequences: Map<string, SequenceDefinition>,
  ) {}

  /**
   * One tick: process up to 50 ready leads.
   * Acquires processing_lock atomically (A5 backstop).
   */
  async tick(): Promise<{ advanced: number; deferred: number; completed: number }> { /* ... */ }
  
  /**
   * Insert a new sequence state for a freshly-pulled lead.
   * Picks sticky sender (round-robin among healthy senders of tenant).
   * Sets initial status based on contact history.
   */
  async startForLead(lead: SdrLead): Promise<void> { /* ... */ }
  
  private async processOne(row: SequenceWithLead): Promise<ProcessResult> { /* per spec §6.3 */ }
  private async enqueueNextStep(row: SequenceWithLead, tenant: TenantConfig): Promise<ProcessResult> { /* ... */ }
  private async kickoffIdentityGate(row: SequenceWithLead, tenant: TenantConfig): Promise<ProcessResult> { /* ... */ }
  private async identityTimeout(row: SequenceWithLead, tenant: TenantConfig): Promise<ProcessResult> { /* nudge or markNoResponse */ }
  private async responseTtlHit(row: SequenceWithLead, tenant: TenantConfig): Promise<ProcessResult> { /* advance or markNoResponse */ }
  private pickSticky(tenant: TenantConfig): { phone: string; app: string } { /* round-robin */ }
}
```

Tests (15+):
- startForLead inserts pending_gate when no outgoing history
- startForLead inserts running step=0 when has outgoing history
- tick acquires processing_lock atomically
- tick releases lock on completion
- processOne dispatches to right method per status
- enqueueNextStep calls ctx.enqueue with correct idempotencyKey + tenant_hint
- enqueueNextStep increments current_step
- enqueueNextStep deferred if throttle blocks
- max_attempts reached → markComplete with no_response + Pipedrive stage update
- responseTtlHit advances to next step
- identityTimeout sends nudge first time, marks no_response second time
- Sticky sender: same sender across all steps (verify by inserting state + checking next enqueue uses same sender)
- Multiple ticks don't double-process (A5 backstop)
- ctx.enqueue called with `tenant_hint = tenant.name` (G2)
- Sender quarantined → defer + try next sender on next tick

Commit: `"feat(sdr-D32): Sequencer state machine — tick, startForLead, sticky sender, A5 backstop"`

---

### Task 33: Response handler (Pipedrive writeback + sequence advance)

**Files:**
- Create: `packages/plugins/debt-sdr/src/responses/response-handler.ts`
- Create: `packages/plugins/debt-sdr/src/responses/response-handler.test.ts`

Plugin-level handler invoked when core delivers `patient_response` callback. Routes by phase + classification:

```ts
export class ResponseHandler {
  constructor(
    private db: Database.Database,
    private classifier: ResponseClassifier,
    private classifierLog: ClassifierLog,
    private identityGate: IdentityGate,
    private clients: Map<string, TenantPipedriveClient>,
    private writebacks: PendingWritebacks,
    private alerts: OperatorAlerts,
    private blacklist: (phone: string, reason: string) => void,
    private config: Config,
  ) {}

  async handle(payload: ResponseCallback): Promise<void> {
    // 1. Find lead via message_id → sdr_sequence_state.last_message_id
    const lead = this.findLeadByMessageId(payload.message_id)
    if (!lead) return  // not our lead; ignore

    // 2. Determine phase
    const identity = this.identityGate.check(lead.tenant, lead.sender_phone, lead.contact_phone, true)
    const phase: 'identity' | 'sequence' = identity.state === 'pending' ? 'identity' : 'sequence'

    // 3. Classify
    const t0 = Date.now()
    const result = await this.classifier.classify(payload.response.body, {
      lead_name: lead.contact_name, step: lead.current_step, phase,
    })
    this.classifierLog.record({
      lead_id: lead.lead_id, message_id: payload.message_id,
      response_text: payload.response.body, category: result.category, confidence: result.confidence,
      source: result.source, llm_reason: 'reason' in result ? String(result.reason ?? '') : undefined,
      latency_ms: Date.now() - t0,
    })

    // 4. Phase-specific dispatch
    if (phase === 'identity') {
      this.identityGate.handleClassification(lead.tenant, lead.sender_phone, lead.contact_phone, result)
      return
    }

    // 5. Sequence phase — branch on category
    const tenant = this.config.tenants.find(t => t.name === lead.tenant)!
    switch (result.category) {
      case 'interested':       return this.qualifyLead(lead, tenant, result, payload.response.body)
      case 'not_interested':   return this.disqualifyLead(lead, tenant, payload.response.body)
      case 'opted_out':        return this.optOutLead(lead, tenant, payload.response.body)
      case 'question':         return this.needsHumanLead(lead, tenant, payload.response.body)
      case 'ambiguous':        return this.alerts.raise({ /* ... */ })
      // identity_* in sequence phase = unexpected — alert
      default:                 return this.alerts.raise({ /* unexpected category in sequence phase */ })
    }
  }
  
  // qualifyLead / disqualifyLead / optOutLead / needsHumanLead:
  //   - Call tenant client.updateDealStage + client.createActivity
  //   - On fail: this.writebacks.enqueue(...) for retry
  //   - Update sdr_lead_queue.state to 'completed' with stop_reason
  //   - Update sdr_sequence_state.status = 'completed'
}
```

Tests (10): one per category branch + writeback fail enqueues retry + lead not found returns silently.

Commit: `"feat(sdr-D33): response handler — classify + writeback + sequence completion"`

---

### Task 34: Pending writebacks retry queue

**Files:**
- Create: `packages/plugins/debt-sdr/src/responses/pending-writebacks.ts`
- Create: `packages/plugins/debt-sdr/src/responses/pending-writebacks.test.ts`

```ts
export class PendingWritebacks {
  constructor(private db: Database.Database, private clients: Map<string, TenantPipedriveClient>) {}

  enqueue(tenant: string, leadId: string, action: 'update_stage' | 'create_activity', payload: object): void { /* ... */ }
  
  /**
   * Cron tick: try abandoned writebacks. Exponential backoff.
   * Abandons after 10 failed attempts.
   */
  async retryReady(): Promise<{ retried: number; succeeded: number; abandoned: number }> { /* ... */ }
}
```

Tests (5): enqueue persists, retry succeeds removes row, retry fails increments + reschedules, abandon after max attempts, idempotent re-enqueue of same (lead, action).

Commit: `"feat(sdr-D34): pending writebacks retry queue with exponential backoff + abandonment"`

---

### Task 35: Pull cron + sequencer cron wiring

**Files:**
- Modify: `packages/plugins/debt-sdr/src/sdr-plugin.ts`

Add to `init()` after config parsing + claim:

```ts
// Instantiate components
const llmClient = new AnthropicLlmClient(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' }))
const classifier = new ResponseClassifier(llmClient)
const classifierLog = new ClassifierLog(this.db)
const templatePools = new Map<string, string[]>([
  ['oralsin-cold-1-pt-br', ORALSIN_COLD_1],
  ['oralsin-cold-2-pt-br', ORALSIN_COLD_2],
  ['oralsin-cold-3-pt-br', ORALSIN_COLD_3],
  ['sicoob-cold-1-pt-br', SICOOB_COLD_1],
  // ...
])
const sequences = new Map<string, SequenceDefinition>([
  ['oralsin-cold-v1', oralsinColdV1],
  ['sicoob-cold-v1', sicoobColdV1],
])
const identityGate = new IdentityGate(this.db, ctx.enqueue.bind(ctx), { intro: INTRO_TEMPLATES, nudge: NUDGE_TEMPLATES })
const throttle = new ThrottleGate(this.db, config.tenants)
const sequencer = new Sequencer(this.db, ctx, config, identityGate, throttle, templatePools, sequences)

// Build per-tenant Pipedrive clients
const clients = new Map<string, TenantPipedriveClient>()
for (const tenant of config.tenants) {
  const token = process.env[tenant.pipedrive.api_token_env]
  if (!token) {
    ctx.logger.warn(`Missing env ${tenant.pipedrive.api_token_env} — tenant ${tenant.name} pull disabled`)
    continue
  }
  clients.set(tenant.name, new TenantPipedriveClient({
    companyDomain: tenant.pipedrive.domain, apiToken: token,
  }))
}

const puller = new LeadPuller(this.db, clients, config.tenants, ctx.isBlacklisted, ctx.logger)
const writebacks = new PendingWritebacks(this.db, clients)
const alerts = new OperatorAlerts(this.db)
const responseHandler = new ResponseHandler(this.db, classifier, classifierLog, identityGate, clients, writebacks, alerts, /* blacklist */ () => {}, config)

// Store handles for destroy/test access
this.runtimeHandles = { sequencer, puller, writebacks, responseHandler, alerts, classifier, identityGate, throttle }

// Register the inbound response webhook (so core's HTTP callback delivers here)
// In MVP we'll use the plugin's own webhook route — see Task 39 for the route impl.
// For now just subscribe to message:sent for sequence advance (cold-N enqueued → state updated).
// Actual response handling comes via /webhooks/response in Task 39.

// Crons
this.pullCronTimer = setInterval(() => {
  puller.pullAll().catch(err => ctx.logger.warn('pull cycle failed', { error: String(err) }))
  // For each newly-pulled lead, start a sequence row
  // (this can also be a separate tick — for MVP do here)
}, 15 * 60_000)

this.sequencerCronTimer = setInterval(() => {
  sequencer.tick().catch(err => ctx.logger.warn('sequencer tick failed', { error: String(err) }))
}, 5 * 60_000)

this.writebackRetryTimer = setInterval(() => {
  writebacks.retryReady().catch(err => ctx.logger.warn('writeback retry failed', { error: String(err) }))
}, 2 * 60_000)
```

Integration smoke test: instantiate plugin with config, mock ctx, init() runs without throwing, all crons set up.

Commit: `"feat(sdr-D35): wire crons in plugin init (pull 15min, sequencer 5min, writeback retry 2min)"`

---

### Task 36: Lead → Sequencer kickoff

**Files:**
- Modify: `packages/plugins/debt-sdr/src/pull/lead-puller.ts`

After insert into `sdr_lead_queue` succeeds, trigger sequencer to start sequence state for new lead (instead of waiting for next tick).

Add `onLeadPulled` callback param to LeadPuller constructor:
```ts
constructor(..., private onLeadPulled?: (leadId: string) => Promise<void>) {}
```

In `pullAll`, after each successful insert: `await this.onLeadPulled?.(insertedLeadId)`.

In `sdr-plugin.ts` `init`, wire:
```ts
const puller = new LeadPuller(..., async (leadId) => {
  const lead = this.db.prepare('SELECT * FROM sdr_lead_queue WHERE id = ?').get(leadId) as SdrLead
  await sequencer.startForLead(lead)
})
```

Test: pull cycle with mock client → assert sequence_state row created for each lead.

Commit: `"feat(sdr-D36): wire pull → sequencer.startForLead callback"`

---

### Task 37: ResponseHandler subscribes to core callback

**Files:**
- Create: `packages/plugins/debt-sdr/src/routes/response-webhook.ts`

Plugin exposes a route at `POST /api/v1/plugins/debt-sdr/_loopback` (matches webhookUrl in Task 16). Core's CallbackDelivery POSTs `ResponseCallback` payloads here.

```ts
// response-webhook.ts
export function registerResponseWebhook(ctx: PluginContext, handler: ResponseHandler): void {
  ctx.registerRoute('POST', '/_loopback', async (req, reply) => {
    // Validate HMAC signature (CallbackDelivery sends X-Signature)
    const body = req.body as { event?: string }
    if (body.event === 'patient_response') {
      void handler.handle(body as ResponseCallback).catch(err => ctx.logger.error('response handler failed', { err }))
    }
    return reply.code(202).send({ ok: true })
  })
}
```

Wire in `sdr-plugin.ts` init: `registerResponseWebhook(ctx, responseHandler)`.

Test: inject POST to `/api/v1/plugins/debt-sdr/_loopback` with `patient_response` payload → verify ResponseHandler.handle is called.

Commit: `"feat(sdr-D37): response webhook route receives core callbacks → ResponseHandler"`

---

### Task 38: Backend smoke (full plugin stack)

- [ ] **Step 1: Set test env vars locally**

```bash
export ANTHROPIC_API_KEY=... # for LLM tests
export PIPEDRIVE_TOKEN_ORALSIN_SDR=...
export PIPEDRIVE_TOKEN_SICOOB_SDR=...
export PLUGIN_DEBT_SDR_CONFIG_PATH=/var/www/adb_tools/packages/plugins/debt-sdr/config.local.json
```

- [ ] **Step 2: Build + test full**

```bash
cd /var/www/adb_tools
pnpm -r build
pnpm -r test
```

Expected: all green (~140+ new tests passing).

- [ ] **Step 3: Manual smoke**

Boot core; check logs for:
- "debt-sdr initialized" with both tenants
- Pull cycle running every 15min
- Sequencer cycle running every 5min

Verify SQLite:
```bash
sqlite3 dispatch.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sdr_%'"
# Expect 6 tables
```

- [ ] **No commit** (smoke only)

---

## FASE E — Routes, race condition tests, deploy, gates

### Task 39: Admin + operator routes

**Files:**
- Create: `packages/plugins/debt-sdr/src/routes/admin-routes.ts`
- Create: `packages/plugins/debt-sdr/src/routes/operator-routes.ts`
- Modify: `packages/plugins/debt-sdr/src/sdr-plugin.ts` (register)

Routes mount under `/api/v1/plugins/debt-sdr/` (loader prefixes namespace).

```ts
// admin-routes.ts
export function registerAdminRoutes(ctx: PluginContext, db: Database.Database, components: { sequencer, alerts, classifierLog }): void {
  ctx.registerRoute('GET',  '/leads',                handleListLeads)            // ?tenant=&state=&limit=&cursor=
  ctx.registerRoute('GET',  '/leads/:id',            handleGetLead)
  ctx.registerRoute('GET',  '/sequences/:lead_id',   handleGetSequenceState)
  ctx.registerRoute('GET',  '/alerts',               handleListAlerts)           // ?tenant=&unresolved=true
  ctx.registerRoute('GET',  '/classifier/log',       handleClassifierLog)        // ?lead_id=&since=
  ctx.registerRoute('GET',  '/health',               handleHealth)               // tenant-by-tenant pipedrive + LLM
  ctx.registerRoute('GET',  '/stats',                handleStats)                // per-tenant aggregates
}

// operator-routes.ts
export function registerOperatorRoutes(...): void {
  ctx.registerRoute('PATCH', '/sequence/:lead_id/abort',  handleAbortSequence)   // body: { reason }
  ctx.registerRoute('PATCH', '/sequence/:lead_id/resume', handleResumeSequence)
  ctx.registerRoute('PATCH', '/alerts/:id/resolve',       handleResolveAlert)    // body: { resolution }
  ctx.registerRoute('POST',  '/leads/:id/force-recheck',  handleForceRecheck)    // re-pull from Pipedrive
}
```

Each handler validates input via Zod. Tests via Fastify `app.inject` — ~12 tests covering happy path + 400/404.

Commit: `"feat(sdr-E39): admin + operator routes (leads, sequences, alerts, abort/resume)"`

---

### Task 40: Prometheus metrics

**Files:**
- Create: `packages/plugins/debt-sdr/src/metrics.ts`

```ts
import promClient from 'prom-client'

export const sdrInvariantViolations = new promClient.Counter({
  name: 'sdr_invariant_violation_total',
  help: 'Count of safety invariant violations (I1-I8); ANY increment pages on-call',
  labelNames: ['invariant'],
})

export const sdrQueueBlockedByTenant = new promClient.Counter({
  name: 'dispatch_queue_blocked_by_tenant_filter_total',
  help: 'Messages skipped at dequeue due to tenant mismatch (G2 working as designed)',
  labelNames: ['tenant', 'device_serial'],
})

export const sdrResponseDroppedMismatch = new promClient.Counter({
  name: 'dispatch_response_dropped_tenant_mismatch_total',
  help: 'Responses dropped at webhook-handler due to tenant mismatch (G5 working)',
})

export const sdrClassifierCalls = new promClient.Counter({
  name: 'sdr_classifier_total',
  labelNames: ['source', 'category', 'tenant'],
  help: 'Classifier calls by source (regex/llm/llm_low_conf/llm_error) and outcome category',
})

export const sdrClassifierLatency = new promClient.Histogram({
  name: 'sdr_classifier_latency_ms',
  labelNames: ['source'],
  buckets: [10, 50, 100, 500, 1000, 2000, 5000],
  help: 'Classifier latency in ms',
})

export const sdrSequenceLeads = new promClient.Gauge({
  name: 'sdr_sequence_leads',
  labelNames: ['tenant', 'status'],
  help: 'Count of leads in each sequence status (refresh on cron tick)',
})

export const sdrLlmCostUsdTotal = new promClient.Counter({
  name: 'sdr_classifier_llm_cost_usd_total',
  labelNames: ['tenant'],
  help: 'Cumulative LLM cost in USD (estimated $0.001/call for Haiku 4.5)',
})
```

Wire in:
- `MessageQueue.dequeueBySender` (G2 rejection): increment `sdrQueueBlockedByTenant`
- `server.ts` G5 tightening: increment `sdrResponseDroppedMismatch`
- `ResponseClassifier`: increment classifier counters + latency
- `Sequencer.tick`: update sdrSequenceLeads gauge

Tests: 4 — counter increments, labeled correctly.

Commit: `"feat(sdr-E40): Prometheus metrics — invariants, queue filter, classifier, sequence gauge"`

---

### Task 41: Race condition adversarial tests (A1-A10)

**Files:**
- Create: `packages/plugins/debt-sdr/src/__tests__/race-conditions.test.ts`

10 tests, one per scenario from spec §8.2. Use real in-memory SQLite + real DeviceTenantAssignment + real MessageQueue (with DTA injected). Mock only ADB/HTTP boundaries.

```ts
describe('Race conditions — formal invariants (per spec §6 + §8)', () => {
  it('A1: concurrent claim of same device — only one plugin succeeds', async () => { /* spawn 2 promises calling claim simultaneously; assert exactly 1 returns ok:true */ })

  it('A2: plugin X cannot release device claimed by plugin Y', async () => { /* DTA.claim(dev, t, "plugin-A"); DTA.release(dev, "plugin-B") returns not_owner; assignment still active */ })

  it('A3: enqueue with cross-tenant sender is rejected', async () => { /* setSenderTenant(s, A); attempting setSenderTenant(s, B) returns conflicting_tenant */ })

  it('A4: response routed only to sender-owning tenant', async () => { /* sender1 has tenant=A; msg with tenant_hint=A is delivered; sender1 has tenant=A, msg tenant_hint=B → routing drops it */ })

  it('A5: concurrent sequencer tick on same lead — no duplicate send (idempotency key)', async () => { /* run sequencer.tick() twice in parallel via Promise.all on same lead; assert only 1 message in queue */ })

  it('A6: plugin reload preserves sequence state', async () => { /* init→insert state→destroy→init again→assert state row present and crons resume processing */ })

  it('A7: duplicate WAHA webhook does not trigger duplicate classification', async () => { /* call response-webhook POST twice with same idempotency_key+message_id → assert classifier called once */ })

  it('A8: sender quarantined mid-tick — msg defers to other sender of same tenant', async () => { /* simulate sender_health update mid-flight; assert sequencer picks alternate sender */ })

  it('A9: legacy plugin send blocked from claimed device', async () => { /* claim device for tenant A; enqueue msg with tenant_hint=null (legacy); dequeueBySender returns 0 */ })

  it('A10: sender_mapping.tenant change mid-flight — graceful failure', async () => { /* enqueue msg with tenant_hint=A; manually UPDATE sender_mapping SET tenant=B; dequeue returns 0; msg stays queued */ })
})
```

Each test ~30-60 LOC of fixture + assertion. Total ~500 LOC for the file.

Commit: `"test(sdr-E41): 10 race condition adversarial tests (A1-A10 per spec §8.2)"`

---

### Task 42: Integration tests (full flow)

**Files:**
- Create: `packages/plugins/debt-sdr/src/__tests__/sdr-flow.integration.test.ts`

End-to-end flows with mocks at boundaries (Pipedrive HTTP, LLM, ADB). Real SQLite + real DTA + real Sequencer + real ResponseHandler.

Scenarios (~12 tests):
- Lead pulled → identity gate → "sim sou eu" → cold-1 → "interessado" → Pipedrive qualified
- Lead pulled → identity gate → "não sou eu" → blacklisted 30d, sequence aborted, Pipedrive updated
- Lead pulled → identity gate → no reply 48h → nudge sent → no reply 96h → no_response, Pipedrive stage_no_response
- Lead pulled → has outgoing history → skip identity → cold-1 directly → "opted_out" → permanent blacklist
- Lead pulled → identity verified → cold-1 → no reply 48h → cold-2 → "ambiguous" → operator alert
- Lead pulled → identity verified → cold-1 → cold-2 → cold-3 → no reply 96h → no_response
- Lead pulled → identity verified → cold-1 → sender quarantined → defer + pick alt sender → cold-1 succeeds
- Lead pulled twice (same deal_id) → only 1 row inserted (idempotent)
- Plugin restart mid-sequence → state preserved → cron resumes → next step fires on schedule
- LLM down → classifier returns ambiguous → operator alert emitted
- Pipedrive client 5xx → writeback enqueued → retry succeeds → row removed from pending
- Cross-tenant response routing dropped (G5)

Commit: `"test(sdr-E42): 12 integration tests covering full SDR flow"`

---

### Task 43: E2E test scaffold (TEST_PHONE_NUMBER)

**Files:**
- Create: `packages/plugins/debt-sdr/src/__tests__/e2e/e2e-sdr.test.ts`

Gated by `process.env.RUN_E2E === 'true'`. Pre-conditions:
- Sandbox Pipedrive accessible (separate from prod)
- POCO #2 reserved (acquire `/tmp/dispatch-e2e.lock`)
- Real WAHA session bound to TEST_SENDER (env)
- TEST_PHONE_NUMBER = `5543991938235` (per CLAUDE.md)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const SHOULD_RUN = process.env.RUN_E2E === 'true'
const describe_ = SHOULD_RUN ? describe : describe.skip

describe_('SDR E2E (real ADB to TEST_PHONE_NUMBER, real Pipedrive sandbox)', () => {
  beforeAll(async () => {
    // Acquire /tmp/dispatch-e2e.lock (flock)
    // Verify POCO #2 is online and has sufficient battery
    // Verify Pipedrive sandbox creds in env
  })

  afterAll(async () => {
    // Release lock; clean up sandbox deals
  })

  it('happy path: new lead → identity verified → cold-1 → "interessado" → Pipedrive qualified', async () => {
    // 1. Insert deal in Pipedrive sandbox at stage_new_lead
    // 2. Manually trigger pull (call POST /admin/leads/force-recheck or fast-forward cron)
    // 3. Wait for handshake message in WAHA history (real ADB sent it to TEST_PHONE_NUMBER)
    // 4. Send canned "sim sou eu" reply via WAHA admin API (simulating lead response)
    // 5. Wait for cold-1 message
    // 6. Send "tenho interesse"
    // 7. Verify Pipedrive deal moved to qualified stage
    // 8. Verify screenshot in reports/
  })
  
  it('plugin isolation: SDR disable releases devices', async () => { /* ... */ })
  
  it('cross-tenant: 2 tenants active, response goes to correct one', async () => { /* ... */ })

  // 5 more scenarios per spec §11
})
```

Document in `packages/plugins/debt-sdr/E2E.md` how to run, prerequisites, expected screenshots, cleanup.

Commit: `"test(sdr-E43): E2E test scaffold + docs (gated by RUN_E2E env)"`

---

### Task 44: Full local test pass

```bash
cd /var/www/adb_tools
pnpm -r typecheck
pnpm -r test  # SKIP_E2E by default
pnpm -r build
```

Expected:
- Typecheck: 0 errors
- Test: ~2070 total (1893 existing + ~180 new SDR tests)
- Build: clean across core, ui, electron, debt-sdr

If anything fails, FIX before proceeding.

No commit — verification step.

---

### Task 45: Operator runbook

**Files:**
- Create: `docs/operations/sdr-runbook.md`

Covers:
- **Setup**: env vars needed, config.json template, Pipedrive sandbox vs prod, claim verification SQL queries
- **Start/stop**: how to enable/disable per tenant via admin API
- **Monitoring**: what metrics to watch (invariant_violation_total = page; queue_blocked = normal but trend), Grafana dashboard layout (1 panel per tenant)
- **Manual operations**: abort sequence, resolve alert, force re-pull a deal
- **Troubleshooting**:
  - `init failed: preflight cross-tenant senders` → run `SELECT * FROM sender_mapping WHERE device_serial=? AND tenant != ?` to find culprits
  - LLM cost spike → check `sdr_classifier_total{source="llm"}` rate; consider adding regex patterns
  - High `ambiguous_rate` → review `sdr_classifier_log WHERE source='llm_low_conf'` for patterns to codify
  - Plugin reload procedure (graceful)
- **Rollback**: feature flags `DISPATCH_QUEUE_TENANT_FILTER` and `DISPATCH_RESPONSE_STRICT_TENANT` (per Task 10)
- **Canary procedure**: tenant `test-sdr` with 5 synthetic leads + observation period
- **Phone number warmup**: gradual ramp from daily_max=5 → 10 → 20 → 40 over 14 days for new senders

Commit: `"docs(sdr): operator runbook (setup, monitoring, troubleshooting, rollback)"`

---

### Task 46: Push to origin/main

```bash
cd /var/www/adb_tools
git status                      # confirm clean working tree
git log --oneline origin/main..HEAD | wc -l   # count commits ahead
git push origin main
```

Expected: ~45-50 commits pushed.

No standalone commit (push only).

---

### Task 47: Deploy to Kali (`dispatch.tail106aa2.ts.net`)

```bash
ssh root@dispatch '
  sudo -u adb bash -lc "
    source /home/adb/.nvm/nvm.sh
    cd /var/www/debt-adb-framework
    git pull --ff-only origin main
    pnpm install --frozen-lockfile
    pnpm -r build
  "
  systemctl restart dispatch-core dispatch-ui
  sleep 5
  systemctl is-active dispatch-core dispatch-ui
'
```

Expected: both services active.

If new env vars are needed in prod, edit `/var/www/debt-adb-framework/packages/core/.env`:
- `PLUGIN_DEBT_SDR_CONFIG_PATH=/var/www/debt-adb-framework/packages/plugins/debt-sdr/config.json`
- `ANTHROPIC_API_KEY=...`
- `PIPEDRIVE_TOKEN_ORALSIN_SDR=...`
- `PIPEDRIVE_TOKEN_SICOOB_SDR=...`

Then restart again. No commit (deployment step).

---

### Task 48: Production smoke

```bash
ssh root@dispatch '
  API_KEY=$(grep DISPATCH_API_KEY /var/www/debt-adb-framework/packages/core/.env | cut -d= -f2-)
  
  echo "=== Plugin loaded ==="
  curl -fsS -H "X-API-Key: $API_KEY" http://127.0.0.1:7890/api/v1/admin/plugins | jq ".[] | select(.name == \"debt-sdr\") | {name, version, status}"
  
  echo "=== Device assignments ==="
  sqlite3 /var/www/debt-adb-framework/packages/core/dispatch.db "SELECT * FROM device_tenant_assignment"
  
  echo "=== Plugin health ==="
  PLUGIN_KEY=$(sqlite3 /var/www/debt-adb-framework/packages/core/dispatch.db "SELECT api_key FROM plugins WHERE name=\"debt-sdr\"")
  curl -fsS -H "X-API-Key: $PLUGIN_KEY" http://127.0.0.1:7890/api/v1/plugins/debt-sdr/health | jq .
  
  echo "=== Stats ==="
  curl -fsS -H "X-API-Key: $PLUGIN_KEY" http://127.0.0.1:7890/api/v1/plugins/debt-sdr/stats | jq .
'
```

Expected:
- Plugin status=active
- 2 rows in device_tenant_assignment (POCO #2 → oralsin-sdr, Samsung → sicoob-sdr)
- Health returns ok:true for both tenants' Pipedrive
- Stats shows zero leads (no pull cycle ran yet) or some pulled count

No commit (smoke).

---

### Task 49: Update progress.md + final commit

**Files:**
- Modify: `.dev-state/progress.md`

Append at end of Session Notes:

```markdown
- 2026-05-14/15: debt-sdr plugin shipped — multi-tenant SDR outbound.
  Tenants: oralsin-sdr (POCO C71 #2) + sicoob-sdr (Samsung A03).
  3 toques per lead (dia 0/2/5), identity gate exclusive to SDR (not used by oralsin cobrança),
  hybrid classifier (regex first ~70% hits, LLM Haiku 4.5 fallback), per-tenant Pipedrive
  pull/writeback. Hard partition via device_tenant_assignment table + queue tenant_hint filter
  + response routing tightening (G5).
  
  Core changes: G1 (sender_mapping.tenant), G2 (device_tenant_assignment + queue filter),
  G3 (PluginContext.requestDeviceAssignment/assertSenderInTenant/releaseDeviceAssignment),
  G5 (response tightening with feature flag). G4 (Pipedrive client extracted to plugin —
  adb-precheck unchanged).
  
  10 race condition adversarial tests (A1-A10) all pass. 12 integration tests. E2E gated.
  Plugin isolation verified: SDR disable → devices released, claim by oralsin-billing
  rejected with explicit error.
  
  Spec: docs/superpowers/specs/2026-05-14-debt-sdr-plugin-design.md
  Plan: docs/superpowers/plans/2026-05-14-debt-sdr-plugin-plan.md
  Runbook: docs/operations/sdr-runbook.md
  
  Deferred: A/B template testing, automatic re-engagement of completed leads,
  multi-idioma (pt-BR only), cold call via voz.
```

```bash
git add .dev-state/progress.md
git commit -m "docs(progress): debt-sdr plugin shipped — multi-tenant SDR outbound"
git push origin main
```

---

### Task 50: Quality gates checklist

Confirm each:

- [ ] **Safety invariants I1-I8**: each has dedicated test case in `race-conditions.test.ts`, all pass
- [ ] **Coverage**: 
  - Backend `packages/core/` SDR-related changes (G1-G5) ≥80% (specifically: device-tenant-assignment 95%, response routing 95%)
  - Plugin `packages/plugins/debt-sdr/` ≥80%, components críticos ≥95% (classifier, identity-gate, sequencer)
- [ ] **Plugin isolation 1**: disable debt-sdr → both devices released; running oralsin cobrança unaffected
- [ ] **Plugin isolation 2**: oralsin-plugin legacy enqueue to POCO #2 → message stays in queue (rejected by G2 filter), `dispatch_queue_blocked_by_tenant_filter_total` increments
- [ ] **Endpoints**: GET /plugins/debt-sdr/{health, stats, leads, alerts, classifier/log, sequences/:id} return 200 with correct shape
- [ ] **Pipedrive integration**: pull cycle inserts row in sdr_lead_queue; writeback updates real (sandbox) deal stage
- [ ] **Identity gate**: handshake message physically sent (E2E or staging), classifier transitions state correctly
- [ ] **Sequence**: cold-1 → cold-2 → cold-3 verified in staging with mock TTL fast-forward
- [ ] **Classifier**: 70%+ regex hit rate on RESPONSE_SAMPLES fixture; LLM fallback works; ambiguous → operator alert
- [ ] **Race conditions**: all 10 A1-A10 tests pass
- [ ] **E2E TEST_PHONE_NUMBER**: at least 1 real send completed with screenshot in `reports/2026-05-14-sdr-e2e.png`
- [ ] **Rollback**: `DISPATCH_QUEUE_TENANT_FILTER=false` restart restores legacy behavior (verified manually)
- [ ] **Docs**: runbook + spec + plan all committed, progress.md updated

If ANY box fails: STOP. Do NOT mark phase done. Fix → redeploy → re-verify.

---

## Self-review

**Spec coverage:**

| Spec section | Covered by tasks |
|---|---|
| §1 Summary | implicit (whole plan) |
| §2 Principles | architecturally encoded in tasks 1-17, 35-37 |
| §3 Tenant isolation (G1+G2+G3) | Tasks 1-6 |
| §4 Identity Gate | Tasks 23-26 |
| §5 Tenant config + Pipedrive | Tasks 12, 16, 27-29, 35-37 |
| §6 Sequence FSM | Tasks 30, 32, 36 |
| §7 Classifier | Tasks 18-22 |
| §8 Race condition guarantees | Task 41 (10 tests A1-A10) |
| §9 Core changes summary | Tasks 1-10 |
| §10 File structure | Encoded in task file paths |
| §11 Testing strategy | Tasks 41-43, 47, 50 |
| §12 Quality gates | Task 50 |
| §13 Risks + mitigations | Tasks 10 (feature flags), 34 (writebacks retry), 26 (operator alerts), 45 (runbook) |
| §14 Non-objectives | enforced by absence in plan |

No gaps detected.

**Placeholder scan:** Zero "TBD/TODO/later". Inline references like `554399XXXXXXX` are example config values the operator fills; the plan never depends on them being real.

**Type consistency:** 
- `Classification` shape used in classifier (Task 21), identity-gate (Task 24), response-handler (Task 33), classifier-log (Task 22) — consistent: `{ category, confidence, source, ... }`
- `TenantConfig` from Task 12 used in Tasks 14, 31, 32, 35
- `SdrLead` row shape consistent across Tasks 29 (puller), 32 (sequencer), 33 (handler)
- `requestDeviceAssignment` signature stable from Task 5 → Tasks 14, 35

**Total estimate**: ~50 tasks, ~2930 LOC source + ~2110 test LOC, ~50 commits, 2-3 weeks engineer-time end-to-end.

