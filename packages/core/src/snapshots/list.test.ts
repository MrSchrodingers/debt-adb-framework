import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSnapshotFiles } from './list.js'

describe('listSnapshotFiles', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-list-'))
  })

  /**
   * Seed a file under `<dir>/<tenant>/<day>/<file>`.
   * Defaults to tenant='adb' to match the ProbeSnapshotWriter default.
   */
  function seed(day: string, file: string, content = '<x/>', tenant = 'adb') {
    mkdirSync(join(dir, tenant, day), { recursive: true })
    writeFileSync(join(dir, tenant, day, file), content)
  }

  it('returns empty when baseDir does not exist', () => {
    expect(listSnapshotFiles('/nonexistent/dir')).toEqual([])
  })

  it('returns empty when baseDir is empty', () => {
    expect(listSnapshotFiles(dir)).toEqual([])
  })

  it('lists files matching the convention', () => {
    seed('2026-05-06', '103045_9999_unknown_4.xml')
    seed('2026-05-06', '103046_8888_unknown_dialog_42.xml')
    const files = listSnapshotFiles(dir)
    expect(files.length).toBe(2)
    expect(files[0].state).toBeDefined()
    expect(files[0].phone_last4).toBeDefined()
    expect(files[0].tenant).toBe('adb')
  })

  it('filters non-conforming files', () => {
    seed('2026-05-06', 'this-is-not-a-snapshot.txt')
    seed('2026-05-06', '103045_9999_unknown_4.xml')
    const files = listSnapshotFiles(dir)
    expect(files.length).toBe(1)
  })

  it('filters by since date', () => {
    seed('2026-05-05', '120000_1111_unknown_10.xml')
    seed('2026-05-06', '120000_2222_unknown_10.xml')
    seed('2026-05-07', '120000_3333_unknown_10.xml')
    const files = listSnapshotFiles(dir, { since: '2026-05-06' })
    expect(files.length).toBe(2)
    expect(files.every((f) => f.day >= '2026-05-06')).toBe(true)
  })

  it('filters by state', () => {
    seed('2026-05-06', '103045_9999_unknown_10.xml')
    seed('2026-05-06', '103046_8888_unknown_dialog_10.xml')
    const files = listSnapshotFiles(dir, { state: 'unknown' })
    expect(files.length).toBe(1)
    expect(files[0].state).toBe('unknown')
  })

  it('sorts most recent first', () => {
    seed('2026-05-05', '120000_1111_unknown_10.xml')
    seed('2026-05-07', '120000_3333_unknown_10.xml')
    seed('2026-05-06', '120000_2222_unknown_10.xml')
    const files = listSnapshotFiles(dir)
    expect(files[0].day).toBe('2026-05-07')
    expect(files[1].day).toBe('2026-05-06')
    expect(files[2].day).toBe('2026-05-05')
  })

  it('filters by tenant — returns only matching tenant files', () => {
    seed('2026-05-06', '120000_1111_unknown_10.xml', '<x/>', 'sicoob')
    seed('2026-05-06', '120000_2222_unknown_10.xml', '<x/>', 'adb')
    const files = listSnapshotFiles(dir, { tenant: 'sicoob' })
    expect(files.length).toBe(1)
    expect(files[0].tenant).toBe('sicoob')
  })

  it('traverses all tenants when tenant filter is absent and tags each entry', () => {
    seed('2026-05-06', '120000_1111_unknown_10.xml', '<x/>', 'adb')
    seed('2026-05-06', '120000_2222_unknown_10.xml', '<x/>', 'sicoob')
    const files = listSnapshotFiles(dir)
    expect(files.length).toBe(2)
    const tenants = new Set(files.map((f) => f.tenant))
    expect(tenants.has('adb')).toBe(true)
    expect(tenants.has('sicoob')).toBe(true)
  })
})
