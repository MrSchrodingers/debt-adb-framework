import { describe, it, expect, vi } from 'vitest'
import { PipeboardPg } from './postgres-client.js'
import type { DealKey } from './types.js'

// Minimal fake of the pg.Pool surface we actually call. We don't import pg
// at all — the test never hits a real Postgres. Each fake reads the last
// query executed and the args bound to it.
function fakePool(impl?: (sql: string, args: unknown[]) => { rowCount: number }) {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args })
    const r = impl?.(sql, args) ?? { rowCount: 0 }
    return { rows: [], rowCount: r.rowCount }
  })
  return {
    pool: { query, end: vi.fn(async () => undefined) },
    calls,
    query,
  }
}

// Construct a PipeboardPg without triggering the real pg.Pool constructor —
// we cast in the pool via a test-only indirection. The class assigns
// `this.pool` in its constructor, so we replace it after.
function buildPg(fake: ReturnType<typeof fakePool>): PipeboardPg {
  const inst = Object.create(PipeboardPg.prototype) as PipeboardPg
  // @ts-expect-error — poking a private field is intentional for the test
  inst.pool = fake.pool
  return inst
}

const KEY: DealKey = {
  pasta: 'PASTA-001',
  deal_id: 42,
  contato_tipo: 'PRINCIPAL',
  contato_id: 7,
}

describe('PipeboardPg.clearInvalidPhone', () => {
  it('emits a single UPDATE with a CASE per whitelisted phone column', async () => {
    const fake = fakePool(() => ({ rowCount: 1 }))
    const pg = buildPg(fake)

    const nulled = await pg.clearInvalidPhone(KEY, '(43) 99193-8235')

    expect(nulled).toBe(1)
    expect(fake.calls).toHaveLength(1)
    const sql = fake.calls[0]!.sql
    // Every whitelisted column must appear both in SET and in the OR guard
    for (const col of PipeboardPg.PHONE_COLUMNS) {
      expect(sql).toContain(`${col} = CASE WHEN ${col} = $5 THEN NULL ELSE ${col} END`)
      expect(sql).toContain(`${col} = $5`)
    }
    // PK bound correctly
    expect(fake.calls[0]!.args).toEqual([
      KEY.pasta, KEY.deal_id, KEY.contato_tipo, KEY.contato_id,
      '(43) 99193-8235',
    ])
  })

  it('is idempotent — second invocation returns 0 when nothing matches', async () => {
    const fake = fakePool((_, args) =>
      args[4] === 'matches' ? { rowCount: 2 } : { rowCount: 0 },
    )
    const pg = buildPg(fake)

    expect(await pg.clearInvalidPhone(KEY, 'matches')).toBe(2)
    expect(await pg.clearInvalidPhone(KEY, 'already-cleared')).toBe(0)
  })

  it('exposes the phone column whitelist as a static', () => {
    expect(PipeboardPg.PHONE_COLUMNS).toContain('telefone_1')
    expect(PipeboardPg.PHONE_COLUMNS).toContain('whatsapp_hot')
    expect(PipeboardPg.PHONE_COLUMNS.length).toBe(9)
  })
})

describe('PipeboardPg.clearLocalizadoIfMatches', () => {
  it('only nulls telefone_localizado when current value equals rawPhone', async () => {
    const fake = fakePool(() => ({ rowCount: 1 }))
    const pg = buildPg(fake)

    const n = await pg.clearLocalizadoIfMatches(KEY, '(43) 99193-8235')

    expect(n).toBe(1)
    const { sql, args } = fake.calls[0]!
    expect(sql).toContain('UPDATE tenant_adb.prov_consultas')
    expect(sql).toContain('telefone_localizado = NULL')
    expect(sql).toContain('localizado = false')
    expect(sql).toContain('AND telefone_localizado = $5')
    expect(args[4]).toBe('(43) 99193-8235')
  })
})
