import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProbeSnapshotWriter } from './probe-snapshot-writer.js'

describe('ProbeSnapshotWriter', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'snap-'))
  })

  it('writes file with expected naming', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 100, perMinuteCap: 100 })
    const path = w.write({
      xml: '<x/>',
      state: 'unknown',
      phone: '5511999999999',
      timestamp: new Date('2026-05-06T10:30:45Z'),
    })
    expect(path).toMatch(/2026-05-06\/103045_9999_unknown_4\.xml$/)
    const files = readdirSync(join(dir, '2026-05-06'))
    expect(files.length).toBe(1)
  })

  it('persists xml content', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 100, perMinuteCap: 100 })
    const path = w.write({
      xml: '<hierarchy><node/></hierarchy>',
      state: 'unknown',
      phone: '5511999999999',
      timestamp: new Date('2026-05-06T10:30:45Z'),
    })
    expect(path).not.toBeNull()
    expect(readFileSync(path!, 'utf8')).toBe('<hierarchy><node/></hierarchy>')
  })

  it('respects daily quota — returns null after cap', () => {
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

  it('phone last4 padded for short numbers', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 100, perMinuteCap: 100 })
    const path = w.write({
      xml: '<x/>',
      state: 'unknown',
      phone: '12',
      timestamp: new Date('2026-05-06T10:00:00Z'),
    })
    expect(path).toMatch(/100000_0012_unknown_/)
  })

  it('uses current time when timestamp omitted', () => {
    const w = new ProbeSnapshotWriter({ baseDir: dir, dailyQuota: 100, perMinuteCap: 100 })
    const before = new Date()
    const path = w.write({ xml: '<x/>', state: 'unknown', phone: '5511999999999' })
    expect(path).not.toBeNull()
    // Path contains today's date
    const today = before.toISOString().slice(0, 10)
    expect(path).toContain(today)
  })
})
