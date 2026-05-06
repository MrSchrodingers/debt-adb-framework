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

  function seed(day: string, file: string, content = '<x/>') {
    mkdirSync(join(dir, day), { recursive: true })
    writeFileSync(join(dir, day, file), content)
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
})
