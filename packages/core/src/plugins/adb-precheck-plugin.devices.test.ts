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
