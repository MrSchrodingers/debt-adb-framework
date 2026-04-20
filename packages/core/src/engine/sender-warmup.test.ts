import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { SenderWarmup } from './sender-warmup.js'

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE IF NOT EXISTS sender_warmup (
      sender_number TEXT PRIMARY KEY,
      activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      skipped INTEGER NOT NULL DEFAULT 0,
      skipped_at TEXT
    );
  `)
  return db
}

describe('SenderWarmup', () => {
  let db: InstanceType<typeof Database>
  let warmup: SenderWarmup

  beforeEach(() => {
    vi.useFakeTimers()
    db = createTestDb()
    warmup = new SenderWarmup(db)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  describe('getTier', () => {
    it('returns tier 1 for new sender (day 0)', () => {
      // Not activated yet — should return tier 1
      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(1)
      expect(tier.dailyCap).toBe(20)
    })

    it('returns tier 1 for sender activated today (day 0)', () => {
      warmup.activateSender('+5543991938235')
      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(1)
    })

    it('returns tier 2 for sender activated 4 days ago', () => {
      // Set current time, then insert with an old activated_at
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      // Manually backdate the activated_at to 4 days ago
      const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(fourDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(2)
      expect(tier.dailyCap).toBe(50)
    })

    it('returns tier 3 for sender activated 10 days ago', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(tenDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(3)
      expect(tier.dailyCap).toBe(100)
    })

    it('returns tier 4 for sender activated 15 days ago', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(fifteenDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(4)
      expect(tier.dailyCap).toBe(150)
    })
  })

  describe('getEffectiveDailyCap', () => {
    it('returns 20 for tier 1 (new sender)', () => {
      expect(warmup.getEffectiveDailyCap('+5543991938235')).toBe(20)
    })

    it('returns 50 for tier 2', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      expect(warmup.getEffectiveDailyCap('+5543991938235')).toBe(50)
    })

    it('returns 100 for tier 3', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      expect(warmup.getEffectiveDailyCap('+5543991938235')).toBe(100)
    })

    it('returns 150 for tier 4 (fully warmed up)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      expect(warmup.getEffectiveDailyCap('+5543991938235')).toBe(150)
    })
  })

  describe('getEffectiveDelays', () => {
    it('returns tier 1 delays for new sender', () => {
      const delays = warmup.getEffectiveDelays('+5543991938235')
      expect(delays.firstContactDelayMs).toBe(45_000)
      expect(delays.recurringContactDelayMs).toBe(30_000)
    })

    it('returns tier 2 delays for 4-day sender', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      const delays = warmup.getEffectiveDelays('+5543991938235')
      expect(delays.firstContactDelayMs).toBe(35_000)
      expect(delays.recurringContactDelayMs).toBe(25_000)
    })

    it('returns tier 3 delays for 10-day sender', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      const delays = warmup.getEffectiveDelays('+5543991938235')
      expect(delays.firstContactDelayMs).toBe(30_000)
      expect(delays.recurringContactDelayMs).toBe(20_000)
    })

    it('returns tier 4 delays for fully warmed sender', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const daysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(daysAgo, '+5543991938235')

      const delays = warmup.getEffectiveDelays('+5543991938235')
      expect(delays.firstContactDelayMs).toBe(30_000)
      expect(delays.recurringContactDelayMs).toBe(15_000)
    })
  })

  describe('activateSender', () => {
    it('creates a new warmup record', () => {
      warmup.activateSender('+5543991938235')

      const row = db.prepare('SELECT * FROM sender_warmup WHERE sender_number = ?')
        .get('+5543991938235') as { sender_number: string; activated_at: string; skipped: number }
      expect(row).toBeDefined()
      expect(row.sender_number).toBe('+5543991938235')
      expect(row.skipped).toBe(0)
    })

    it('does not overwrite existing record (INSERT OR IGNORE)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const originalRow = db.prepare('SELECT activated_at FROM sender_warmup WHERE sender_number = ?')
        .get('+5543991938235') as { activated_at: string }

      // Advance time and activate again
      vi.setSystemTime(new Date('2026-04-10T12:00:00Z'))
      warmup.activateSender('+5543991938235')

      const afterRow = db.prepare('SELECT activated_at FROM sender_warmup WHERE sender_number = ?')
        .get('+5543991938235') as { activated_at: string }

      // Should keep original activation date
      expect(afterRow.activated_at).toBe(originalRow.activated_at)
    })
  })

  describe('skipWarmup', () => {
    it('sets skipped=1 and returns tier 4 cap', () => {
      warmup.skipWarmup('+5543991938235')

      const cap = warmup.getEffectiveDailyCap('+5543991938235')
      expect(cap).toBe(150)
    })

    it('sets skipped_at timestamp', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.skipWarmup('+5543991938235')

      const row = db.prepare('SELECT skipped, skipped_at FROM sender_warmup WHERE sender_number = ?')
        .get('+5543991938235') as { skipped: number; skipped_at: string }
      expect(row.skipped).toBe(1)
      expect(row.skipped_at).toBeTruthy()
    })

    it('skipped sender always returns tier 4 regardless of age', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      // Activate sender first (day 0 — would normally be tier 1)
      warmup.activateSender('+5543991938235')
      const tierBefore = warmup.getTier('+5543991938235')
      expect(tierBefore.tier).toBe(1)

      // Skip warmup
      warmup.skipWarmup('+5543991938235')

      const tierAfter = warmup.getTier('+5543991938235')
      expect(tierAfter.tier).toBe(4)
      expect(tierAfter.dailyCap).toBe(150)
    })

    it('creates record if sender not yet activated, then skips', () => {
      // skipWarmup on a sender that was never activated
      warmup.skipWarmup('+5543991938235')

      const row = db.prepare('SELECT * FROM sender_warmup WHERE sender_number = ?')
        .get('+5543991938235') as { sender_number: string; skipped: number }
      expect(row).toBeDefined()
      expect(row.skipped).toBe(1)
    })
  })

  describe('tier boundary precision', () => {
    it('returns tier 1 at day 2 (boundary)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(twoDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(1)
    })

    it('returns tier 2 at day 3 (transition)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(threeDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(2)
    })

    it('returns tier 2 at day 6 (upper boundary)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(sixDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(2)
    })

    it('returns tier 3 at day 7 (transition)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(sevenDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(3)
    })

    it('returns tier 3 at day 13 (upper boundary)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const thirteenDaysAgo = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(thirteenDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(3)
    })

    it('returns tier 4 at day 14 (transition)', () => {
      const now = new Date('2026-04-09T12:00:00Z')
      vi.setSystemTime(now)

      warmup.activateSender('+5543991938235')
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare('UPDATE sender_warmup SET activated_at = ? WHERE sender_number = ?')
        .run(fourteenDaysAgo, '+5543991938235')

      const tier = warmup.getTier('+5543991938235')
      expect(tier.tier).toBe(4)
    })
  })
})
