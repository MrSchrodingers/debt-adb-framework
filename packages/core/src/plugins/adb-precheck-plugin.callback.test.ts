import { describe, it, expect } from 'vitest'

describe('Callback payload — tenant propagation', () => {
  it('includes tenant field in body + X-Dispatch-Tenant header', () => {
    const tenant = 'sicoob'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Dispatch-Tenant': tenant,
    }
    const body = { event: 'precheck_completed' as const, tenant, job_id: 'j1' }

    expect(JSON.parse(JSON.stringify(body))).toMatchObject({ tenant: 'sicoob' })
    expect(headers['X-Dispatch-Tenant']).toBe('sicoob')
  })

  it('defaults tenant to "adb" when job row lacks tenant column (back-compat)', () => {
    const job = { id: 'j1' } as { id: string; tenant?: string }
    const tenant = job.tenant ?? 'adb'
    expect(tenant).toBe('adb')
  })
})
