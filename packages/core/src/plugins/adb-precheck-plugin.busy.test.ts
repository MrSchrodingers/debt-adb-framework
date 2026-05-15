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
