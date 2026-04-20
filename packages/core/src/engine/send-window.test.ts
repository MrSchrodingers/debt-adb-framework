import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SendWindow } from './send-window.js'

describe('SendWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Helper: create a UTC Date at a specific point.
  // dayOfWeek is JS convention: 0=Sun, 1=Mon, ..., 6=Sat
  // We pick specific known dates to control the day-of-week precisely.
  // 2026-04-06 = Monday, 2026-04-07 = Tuesday, ..., 2026-04-11 = Saturday, 2026-04-12 = Sunday

  describe('isOpen', () => {
    it('returns true during business hours (Monday 10:00 BRT)', () => {
      // Monday 10:00 BRT = Monday 13:00 UTC (BRT = UTC-3)
      const monday10BRT = new Date('2026-04-06T13:00:00Z')
      vi.setSystemTime(monday10BRT)

      const window = new SendWindow() // defaults: 7-21, Mon-Fri, UTC-3
      expect(window.isOpen()).toBe(true)
    })

    it('returns false outside hours (Monday 03:00 BRT)', () => {
      // Monday 03:00 BRT = Monday 06:00 UTC
      const monday03BRT = new Date('2026-04-06T06:00:00Z')
      vi.setSystemTime(monday03BRT)

      const window = new SendWindow()
      expect(window.isOpen()).toBe(false)
    })

    it('returns false on weekend (Saturday 10:00 BRT)', () => {
      // Saturday 10:00 BRT = Saturday 13:00 UTC
      // 2026-04-11 = Saturday
      const saturday10BRT = new Date('2026-04-11T13:00:00Z')
      vi.setSystemTime(saturday10BRT)

      const window = new SendWindow()
      expect(window.isOpen()).toBe(false)
    })

    it('returns true on configured weekend day if days includes 6,7', () => {
      // Saturday 10:00 BRT = Saturday 13:00 UTC
      const saturday10BRT = new Date('2026-04-11T13:00:00Z')
      vi.setSystemTime(saturday10BRT)

      const window = new SendWindow({ days: '1,2,3,4,5,6,7' })
      expect(window.isOpen()).toBe(true)
    })

    it('returns false at exactly the end hour (boundary)', () => {
      // Monday 21:00 BRT = Tuesday 00:00 UTC
      const monday21BRT = new Date('2026-04-07T00:00:00Z')
      vi.setSystemTime(monday21BRT)

      const window = new SendWindow()
      expect(window.isOpen()).toBe(false)
    })

    it('returns true at exactly the start hour (boundary)', () => {
      // Monday 07:00 BRT = Monday 10:00 UTC
      const monday07BRT = new Date('2026-04-06T10:00:00Z')
      vi.setSystemTime(monday07BRT)

      const window = new SendWindow()
      expect(window.isOpen()).toBe(true)
    })
  })

  describe('nextOpenAt', () => {
    it('returns next Monday 07:00 when called on Friday evening', () => {
      // Friday 22:00 BRT = Saturday 01:00 UTC
      // 2026-04-10 = Friday => Saturday 2026-04-11 01:00 UTC
      const fridayEvening = new Date('2026-04-11T01:00:00Z')
      vi.setSystemTime(fridayEvening)

      const window = new SendWindow()
      const next = window.nextOpenAt()

      // Next Monday = 2026-04-13, 07:00 BRT = 10:00 UTC
      expect(next.toISOString()).toBe('2026-04-13T10:00:00.000Z')
    })

    it('returns today start when called before start time on a workday', () => {
      // Monday 05:00 BRT = Monday 08:00 UTC
      const mondayEarly = new Date('2026-04-06T08:00:00Z')
      vi.setSystemTime(mondayEarly)

      const window = new SendWindow()
      const next = window.nextOpenAt()

      // Today Monday 07:00 BRT = 10:00 UTC
      expect(next.toISOString()).toBe('2026-04-06T10:00:00.000Z')
    })

    it('returns current time when window is currently open', () => {
      // Monday 10:00 BRT = Monday 13:00 UTC
      const mondayOpen = new Date('2026-04-06T13:00:00Z')
      vi.setSystemTime(mondayOpen)

      const window = new SendWindow()
      const next = window.nextOpenAt()

      // Should return the current time (window is open now)
      expect(next.getTime()).toBe(mondayOpen.getTime())
    })

    it('returns next allowed day when called on Saturday (weekend)', () => {
      // Saturday 10:00 BRT = Saturday 13:00 UTC
      const saturdayMorning = new Date('2026-04-11T13:00:00Z')
      vi.setSystemTime(saturdayMorning)

      const window = new SendWindow() // Mon-Fri only
      const next = window.nextOpenAt()

      // Next Monday = 2026-04-13, 07:00 BRT = 10:00 UTC
      expect(next.toISOString()).toBe('2026-04-13T10:00:00.000Z')
    })
  })

  describe('msUntilOpen', () => {
    it('returns 0 when window is open', () => {
      // Monday 10:00 BRT = Monday 13:00 UTC
      const mondayOpen = new Date('2026-04-06T13:00:00Z')
      vi.setSystemTime(mondayOpen)

      const window = new SendWindow()
      expect(window.msUntilOpen()).toBe(0)
    })

    it('returns positive value when window is closed', () => {
      // Monday 05:00 BRT = Monday 08:00 UTC
      const mondayEarly = new Date('2026-04-06T08:00:00Z')
      vi.setSystemTime(mondayEarly)

      const window = new SendWindow()
      const ms = window.msUntilOpen()

      // Should be 2 hours = 7,200,000 ms (from 05:00 to 07:00 BRT)
      expect(ms).toBe(2 * 60 * 60 * 1000)
    })

    it('returns correct ms when waiting for next week', () => {
      // Friday 22:00 BRT = Saturday 01:00 UTC (2026-04-11)
      const fridayEvening = new Date('2026-04-11T01:00:00Z')
      vi.setSystemTime(fridayEvening)

      const window = new SendWindow()
      const ms = window.msUntilOpen()

      // Next open: Monday 2026-04-13 07:00 BRT = 10:00 UTC
      // From Saturday 01:00 UTC to Monday 10:00 UTC = 2 days 9 hours
      const expected = (2 * 24 + 9) * 60 * 60 * 1000
      expect(ms).toBe(expected)
    })
  })

  describe('custom UTC offset', () => {
    it('respects custom UTC offset (e.g., -5 for EST)', () => {
      // We want to check: Monday 10:00 EST = Monday 15:00 UTC (EST = UTC-5)
      const monday10EST = new Date('2026-04-06T15:00:00Z')
      vi.setSystemTime(monday10EST)

      const window = new SendWindow({ utcOffsetHours: -5 })
      expect(window.isOpen()).toBe(true)

      // Monday 06:00 EST = Monday 11:00 UTC — before 07:00 EST
      const monday06EST = new Date('2026-04-06T11:00:00Z')
      vi.setSystemTime(monday06EST)
      expect(window.isOpen()).toBe(false)
    })

    it('handles positive UTC offset (e.g., +5:30 IST approximated as +5)', () => {
      // Monday 10:00 IST(+5) = Monday 05:00 UTC
      const monday10IST = new Date('2026-04-06T05:00:00Z')
      vi.setSystemTime(monday10IST)

      const window = new SendWindow({ utcOffsetHours: 5 })
      expect(window.isOpen()).toBe(true)
    })
  })

  describe('midnight-crossing window', () => {
    it('handles window crossing midnight (start=22, end=6)', () => {
      // Window: 22:00-06:00 BRT, Mon-Fri
      const window = new SendWindow({ start: 22, end: 6 })

      // Monday 23:00 BRT = Tuesday 02:00 UTC
      const monday23BRT = new Date('2026-04-07T02:00:00Z')
      vi.setSystemTime(monday23BRT)
      expect(window.isOpen()).toBe(true)

      // Tuesday 03:00 BRT = Tuesday 06:00 UTC
      const tuesday03BRT = new Date('2026-04-07T06:00:00Z')
      vi.setSystemTime(tuesday03BRT)
      expect(window.isOpen()).toBe(true)

      // Monday 10:00 BRT = Monday 13:00 UTC — outside 22-06 window
      const monday10BRT = new Date('2026-04-06T13:00:00Z')
      vi.setSystemTime(monday10BRT)
      expect(window.isOpen()).toBe(false)
    })
  })

  describe('configuration', () => {
    it('uses defaults when no config provided', () => {
      const window = new SendWindow()
      // Monday 12:00 BRT = Monday 15:00 UTC
      vi.setSystemTime(new Date('2026-04-06T15:00:00Z'))
      expect(window.isOpen()).toBe(true)
    })

    it('filters invalid day numbers from config', () => {
      const window = new SendWindow({ days: '1,2,8,-1,3' })
      // Should only have days 1, 2, 3

      // Wednesday (day 3) 10:00 BRT = Wednesday 13:00 UTC
      // 2026-04-08 = Wednesday
      vi.setSystemTime(new Date('2026-04-08T13:00:00Z'))
      expect(window.isOpen()).toBe(true)

      // Thursday (day 4) 10:00 BRT = Thursday 13:00 UTC — not in allowed days
      // 2026-04-09 = Thursday
      vi.setSystemTime(new Date('2026-04-09T13:00:00Z'))
      expect(window.isOpen()).toBe(false)
    })
  })
})
