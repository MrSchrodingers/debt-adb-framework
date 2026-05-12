import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryServicesRegistry } from './services-registry.js'

describe('InMemoryServicesRegistry', () => {
  let reg: InMemoryServicesRegistry
  beforeEach(() => { reg = new InMemoryServicesRegistry() })

  it('register + get round-trip', () => {
    const svc = { hello: () => 'world' }
    reg.register('greeter', svc)
    expect(reg.get<typeof svc>('greeter')?.hello()).toBe('world')
  })

  it('has() reflects registration', () => {
    expect(reg.has('pipedrive')).toBe(false)
    reg.register('pipedrive', {})
    expect(reg.has('pipedrive')).toBe(true)
  })

  it('throws on duplicate registration', () => {
    reg.register('x', { v: 1 })
    expect(() => reg.register('x', { v: 2 })).toThrowError(/already registered/)
  })

  it('rejects empty name', () => {
    expect(() => reg.register('', {})).toThrowError(/non-empty/)
  })

  it('list() returns sorted names', () => {
    reg.register('zeta', {})
    reg.register('alpha', {})
    reg.register('mu', {})
    expect(reg.list()).toEqual(['alpha', 'mu', 'zeta'])
  })

  it('get() returns undefined for unknown name', () => {
    expect(reg.get('nothing')).toBeUndefined()
  })
})
