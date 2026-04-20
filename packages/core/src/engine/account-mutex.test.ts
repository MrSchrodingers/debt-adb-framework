import { describe, it, expect, afterEach } from 'vitest'
import { AccountMutex } from './account-mutex.js'

describe('AccountMutex', () => {
  const mutex = new AccountMutex(5_000) // 5s timeout for tests

  afterEach(() => {
    mutex.releaseAll()
  })

  it('acquires lock for a phone number', async () => {
    const release = await mutex.acquire('+554396837945')
    expect(release).toBeTypeOf('function')
    release()
  })

  it('blocks concurrent acquire for same number', async () => {
    const release1 = await mutex.acquire('+554396837945')

    let resolved = false
    const promise = mutex.acquire('+554396837945').then((r) => {
      resolved = true
      return r
    })

    // Should not resolve immediately
    await new Promise((r) => setTimeout(r, 50))
    expect(resolved).toBe(false)

    // Release first lock
    release1()

    // Now second should resolve
    const release2 = await promise
    expect(resolved).toBe(true)
    release2()
  })

  it('allows concurrent acquire for different numbers', async () => {
    const release1 = await mutex.acquire('+554396837945')
    const release2 = await mutex.acquire('+554396837844')

    // Both acquired without blocking
    expect(release1).toBeTypeOf('function')
    expect(release2).toBeTypeOf('function')

    release1()
    release2()
  })

  it('releases lock after use', async () => {
    const release = await mutex.acquire('+554396837945')
    release()

    // Should be able to acquire again immediately
    const release2 = await mutex.acquire('+554396837945')
    expect(release2).toBeTypeOf('function')
    release2()
  })

  it('times out after configured timeout', async () => {
    const shortMutex = new AccountMutex(100) // 100ms timeout
    const release = await shortMutex.acquire('+554396837945')

    await expect(shortMutex.acquire('+554396837945')).rejects.toThrow(/timeout/i)

    release()
    shortMutex.releaseAll()
  })
})
