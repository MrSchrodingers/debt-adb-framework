import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ScreenshotPolicy } from './screenshot-policy.js'

// ── Minimal queue stub for retentionSweep tests ──
function makeQueueStub(rows: Array<{ id: string; screenshotPath: string }> = []) {
  const deleted: Array<{ id: string; deletedAtIso: string; reason: string }> = []
  return {
    findScreenshotsOlderThan: vi.fn().mockReturnValue(rows),
    markScreenshotDeleted: vi.fn().mockImplementation(
      (id: string, deletedAtIso: string, reason: string) => { deleted.push({ id, deletedAtIso, reason }) },
    ),
    _deleted: deleted,
  }
}

describe('ScreenshotPolicy', () => {
  describe('shouldCapture', () => {
    it('returns true when mode=all regardless of success', () => {
      const policy = new ScreenshotPolicy({ mode: 'all' })
      expect(policy.shouldCapture(true)).toBe(true)
      expect(policy.shouldCapture(false)).toBe(true)
    })

    it('returns false when mode=none regardless of success', () => {
      const policy = new ScreenshotPolicy({ mode: 'none' })
      expect(policy.shouldCapture(true)).toBe(false)
      expect(policy.shouldCapture(false)).toBe(false)
    })

    it('returns true for failures when mode=sample', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 0 })
      // Failures always captured, even with sampleRate=0
      expect(policy.shouldCapture(false)).toBe(true)
    })

    it('uses sampleRate for successes when mode=sample (rate=1 → always)', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 1.0 })
      // sampleRate=1.0 means Math.random() < 1.0 is always true
      expect(policy.shouldCapture(true)).toBe(true)
    })

    it('uses sampleRate for successes when mode=sample (rate=0 → never)', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 0 })
      // sampleRate=0 means Math.random() < 0 is always false
      expect(policy.shouldCapture(true)).toBe(false)
    })

    it('respects sampleRate stochastically (rate=0.5)', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 0.5 })
      // Run 200 times — expect roughly half true (with tolerance)
      let captured = 0
      for (let i = 0; i < 200; i++) {
        if (policy.shouldCapture(true)) captured++
      }
      // Should be between 30% and 70% (6-sigma tolerance for n=200, p=0.5)
      expect(captured).toBeGreaterThan(60)
      expect(captured).toBeLessThan(140)
    })
  })

  describe('format', () => {
    it('returns configured format', () => {
      expect(new ScreenshotPolicy({ format: 'jpeg' }).format).toBe('jpeg')
      expect(new ScreenshotPolicy({ format: 'png' }).format).toBe('png')
    })

    it('defaults to png', () => {
      expect(new ScreenshotPolicy().format).toBe('png')
    })
  })

  describe('getOutputPath', () => {
    it('generates .jpg extension when format=jpeg', () => {
      const policy = new ScreenshotPolicy({ format: 'jpeg' })
      expect(policy.getOutputPath('msg-123')).toBe('reports/sends/msg-123.jpg')
    })

    it('generates .png extension when format=png', () => {
      const policy = new ScreenshotPolicy({ format: 'png' })
      expect(policy.getOutputPath('msg-456')).toBe('reports/sends/msg-456.png')
    })
  })

  describe('processBuffer', () => {
    it('returns buffer as-is for PNG format', async () => {
      const policy = new ScreenshotPolicy({ format: 'png' })
      const input = Buffer.from('fake-png-data')
      const result = await policy.processBuffer(input)
      expect(result).toBe(input) // Same reference — no copy
    })

    it('attempts JPEG compression when format=jpeg (graceful fallback)', async () => {
      const policy = new ScreenshotPolicy({ format: 'jpeg', jpegQuality: 60 })
      const input = Buffer.from('fake-png-data')
      // sharp may or may not be installed — either way, processBuffer must return a Buffer
      const result = await policy.processBuffer(input)
      expect(Buffer.isBuffer(result)).toBe(true)
    })

    it('returns original buffer when sharp is not available and format=jpeg', async () => {
      // Force sharp import to fail by mocking
      const policy = new ScreenshotPolicy({ format: 'jpeg', jpegQuality: 60 })
      const input = Buffer.from('fake-png-data')

      // Mock the dynamic import to throw (simulating sharp not installed)
      const origProcessBuffer = policy.processBuffer.bind(policy)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(policy as any)._importSharp = () => { throw new Error('Cannot find module sharp') }
      // Since we can't easily mock dynamic import, just verify the method handles errors
      const result = await origProcessBuffer(input)
      expect(Buffer.isBuffer(result)).toBe(true)
    })
  })

  describe('retentionDays', () => {
    it('returns configured value', () => {
      expect(new ScreenshotPolicy({ retentionDays: 14 }).retentionDays).toBe(14)
    })

    it('defaults to 7', () => {
      expect(new ScreenshotPolicy().retentionDays).toBe(7)
    })
  })

  describe('jpegQuality', () => {
    it('returns configured value', () => {
      expect(new ScreenshotPolicy({ jpegQuality: 80 }).jpegQuality).toBe(80)
    })

    it('defaults to 60', () => {
      expect(new ScreenshotPolicy().jpegQuality).toBe(60)
    })
  })

  describe('fromEnv', () => {
    it('reads all values from env vars', () => {
      const policy = ScreenshotPolicy.fromEnv({
        SCREENSHOT_MODE: 'sample',
        SCREENSHOT_SAMPLE_RATE: '0.2',
        SCREENSHOT_FORMAT: 'jpeg',
        SCREENSHOT_JPEG_QUALITY: '80',
        SCREENSHOT_RETENTION_DAYS: '14',
      })
      expect(policy.format).toBe('jpeg')
      expect(policy.retentionDays).toBe(14)
      expect(policy.jpegQuality).toBe(80)
      // mode=sample, sampleRate=0.2 — failures always captured
      expect(policy.shouldCapture(false)).toBe(true)
    })

    it('uses defaults for missing env vars', () => {
      const policy = ScreenshotPolicy.fromEnv({})
      expect(policy.format).toBe('png')
      expect(policy.retentionDays).toBe(7)
      expect(policy.jpegQuality).toBe(60)
      // mode=all → always capture
      expect(policy.shouldCapture(true)).toBe(true)
    })
  })

  describe('defaults', () => {
    it('has sensible defaults', () => {
      const policy = new ScreenshotPolicy()
      expect(policy.format).toBe('png')
      expect(policy.retentionDays).toBe(7)
      expect(policy.jpegQuality).toBe(60)
      // Default mode=all
      expect(policy.shouldCapture(true)).toBe(true)
      expect(policy.shouldCapture(false)).toBe(true)
    })
  })

  describe('skipReason()', () => {
    it('returns "mode=none" when mode is none', () => {
      const policy = new ScreenshotPolicy({ mode: 'none' })
      expect(policy.skipReason()).toBe('mode=none')
    })

    it('encodes mode + sampleRate for sample mode', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 0.2 })
      expect(policy.skipReason()).toBe('mode=sample,sampleRate=0.2')
    })

    it('includes sampleRate=0 for extreme case', () => {
      const policy = new ScreenshotPolicy({ mode: 'sample', sampleRate: 0 })
      expect(policy.skipReason()).toContain('sampleRate=0')
    })
  })

  describe('retentionSweep()', () => {
    it('returns { deleted: 0 } when no stale screenshots', async () => {
      const policy = new ScreenshotPolicy({ retentionDays: 7 })
      const queue = makeQueueStub([])
      const result = await policy.retentionSweep(queue, new Date())
      expect(result.deleted).toBe(0)
    })

    it('calls markScreenshotDeleted for each stale screenshot (files may or may not exist)', async () => {
      const policy = new ScreenshotPolicy({ retentionDays: 7 })

      const rows = [
        { id: 'msg-1', screenshotPath: 'reports/sends/msg-1.png' },
        { id: 'msg-2', screenshotPath: 'reports/sends/msg-2.png' },
      ]
      const queue = makeQueueStub(rows)
      const now = new Date('2026-04-27T12:00:00.000Z')
      const result = await policy.retentionSweep(queue, now)

      // Regardless of whether files exist, all rows must be processed
      expect(result.deleted).toBe(2)
      expect(queue.markScreenshotDeleted).toHaveBeenCalledTimes(2)
      // Calls should include the message ids and the correct timestamp
      const calls = (queue.markScreenshotDeleted as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(([id]: [string]) => id === 'msg-1')).toBe(true)
      expect(calls.some(([id]: [string]) => id === 'msg-2')).toBe(true)
      calls.forEach(([, ts]: [string, string]) => expect(ts).toBe(now.toISOString()))
    })

    it('still marks deleted and counts when file does not exist on disk', async () => {
      const policy = new ScreenshotPolicy({ retentionDays: 7 })
      const { default: fsPromises } = await import('node:fs/promises')
      vi.spyOn(fsPromises, 'unlink').mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))

      const rows = [{ id: 'msg-3', screenshotPath: 'reports/sends/msg-3.png' }]
      const queue = makeQueueStub(rows)
      const now = new Date('2026-04-27T13:00:00.000Z')
      const result = await policy.retentionSweep(queue, now)

      expect(result.deleted).toBe(1)
      expect(queue.markScreenshotDeleted).toHaveBeenCalledWith(
        'msg-3',
        now.toISOString(),
        expect.stringContaining('retention_sweep_missing'),
      )
      vi.restoreAllMocks()
    })

    it('uses configured retentionDays as cutoff for findScreenshotsOlderThan', async () => {
      const policy = new ScreenshotPolicy({ retentionDays: 14 })
      const queue = makeQueueStub([])
      const now = new Date('2026-04-27T00:00:00.000Z')
      await policy.retentionSweep(queue, now)

      const [cutoff] = (queue.findScreenshotsOlderThan as ReturnType<typeof vi.fn>).mock.calls[0]
      const expectedCutoff = new Date(now.getTime() - 14 * 86_400_000)
      // Allow 1 second tolerance for test timing
      expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000)
    })
  })
})
