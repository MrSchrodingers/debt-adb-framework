import { describe, it, expect } from 'vitest'
import { DeviceMutex } from './device-mutex.js'

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
