import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GracefulShutdown } from './graceful-shutdown.js'

describe('GracefulShutdown', () => {
  let shutdown: GracefulShutdown
  let mockLogger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
  })

  describe('execute', () => {
    it('calls all shutdown handlers in order', async () => {
      const callOrder: string[] = []
      shutdown = new GracefulShutdown(mockLogger, 5_000)

      shutdown.addHandler('plugins', async () => { callOrder.push('plugins') })
      shutdown.addHandler('intervals', async () => { callOrder.push('intervals') })
      shutdown.addHandler('database', async () => { callOrder.push('database') })

      await shutdown.execute()

      expect(callOrder).toEqual(['plugins', 'intervals', 'database'])
    })

    it('logs "Shutdown complete" at the end', async () => {
      shutdown = new GracefulShutdown(mockLogger, 5_000)
      await shutdown.execute()

      expect(mockLogger.info).toHaveBeenCalledWith('Shutdown complete')
    })

    it('continues executing handlers even if one fails', async () => {
      const callOrder: string[] = []
      shutdown = new GracefulShutdown(mockLogger, 5_000)

      shutdown.addHandler('failing', async () => { throw new Error('boom') })
      shutdown.addHandler('after-fail', async () => { callOrder.push('after-fail') })

      await shutdown.execute()

      expect(callOrder).toEqual(['after-fail'])
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('is idempotent — second call is a no-op', async () => {
      let callCount = 0
      shutdown = new GracefulShutdown(mockLogger, 5_000)
      shutdown.addHandler('counter', async () => { callCount++ })

      await shutdown.execute()
      await shutdown.execute()

      expect(callCount).toBe(1)
    })

    it('times out if a handler takes too long', async () => {
      vi.useFakeTimers()
      shutdown = new GracefulShutdown(mockLogger, 100) // 100ms timeout

      shutdown.addHandler('slow', () => new Promise(() => {
        // never resolves
      }))

      const promise = shutdown.execute()
      await vi.advanceTimersByTimeAsync(200)
      await promise

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
      )
      vi.useRealTimers()
    })
  })

  describe('waitForSend', () => {
    it('resolves immediately when no send is active', async () => {
      shutdown = new GracefulShutdown(mockLogger, 5_000)
      await shutdown.waitForSend()
    })

    it('resolves after active send completes', async () => {
      shutdown = new GracefulShutdown(mockLogger, 5_000)

      let resolveSend!: () => void
      const sendPromise = new Promise<void>((r) => { resolveSend = r })
      shutdown.markSendActive(sendPromise)

      let waitResolved = false
      const waitPromise = shutdown.waitForSend().then(() => { waitResolved = true })

      expect(waitResolved).toBe(false)
      resolveSend()
      await waitPromise
      expect(waitResolved).toBe(true)
    })
  })
})
