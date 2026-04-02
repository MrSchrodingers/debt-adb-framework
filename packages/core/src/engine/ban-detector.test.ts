import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BanDetector } from './ban-detector.js'
import type { AdbShellAdapter } from '../monitor/types.js'
import { DEFAULT_BAN_DETECTION_CONFIG } from './types.js'

describe('BanDetector', () => {
  let adb: AdbShellAdapter
  let detector: BanDetector

  beforeEach(() => {
    adb = { shell: vi.fn<(serial: string, cmd: string) => Promise<string>>() }
    detector = new BanDetector(DEFAULT_BAN_DETECTION_CONFIG, adb)
  })

  describe('analyzeScreenshot', () => {
    it('detects "banned" keyword with confidence >= 60%', () => {
      const result = detector.analyzeScreenshot(
        'Your account has been banned from using WhatsApp',
        0.75,
      )
      expect(result.isSuspect).toBe(true)
      expect(result.matchedStrings).toContain('banned')
    })

    it('detects "verify your phone" keyword', () => {
      const result = detector.analyzeScreenshot(
        'Please verify your phone number to continue',
        0.65,
      )
      expect(result.isSuspect).toBe(true)
      expect(result.matchedStrings).toContain('verify your phone')
    })

    it('detects Portuguese ban strings', () => {
      const result = detector.analyzeScreenshot(
        'Sua conta foi banido temporariamente',
        0.70,
      )
      expect(result.isSuspect).toBe(true)
      expect(result.matchedStrings).toContain('banido')
    })

    it('detects "captcha" keyword', () => {
      const result = detector.analyzeScreenshot(
        'Complete the captcha to verify you are human',
        0.80,
      )
      expect(result.isSuspect).toBe(true)
      expect(result.matchedStrings).toContain('captcha')
    })

    it('returns isSuspect=false for normal chat screenshot', () => {
      const result = detector.analyzeScreenshot(
        'Type a message... Send button visible. Chat with John',
        0.90,
      )
      expect(result.isSuspect).toBe(false)
      expect(result.matchedStrings).toHaveLength(0)
    })

    it('returns isSuspect=false when confidence < 60%', () => {
      const result = detector.analyzeScreenshot(
        'Your account has been banned',
        0.45,
      )
      expect(result.isSuspect).toBe(false)
    })

    it('is case-insensitive for ban string matching', () => {
      const result = detector.analyzeScreenshot(
        'YOUR ACCOUNT HAS BEEN SUSPENDED',
        0.70,
      )
      expect(result.isSuspect).toBe(true)
      expect(result.matchedStrings).toContain('suspended')
    })
  })

  describe('behavioralProbe', () => {
    it('returns isBanned=false when input field is present in UI dump', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      // Simulate opening wa.me chat
      mockShell.mockResolvedValueOnce('') // am start intent
      mockShell.mockResolvedValueOnce('') // sleep/wait
      // UIAutomator dump with send button present
      mockShell.mockResolvedValueOnce('') // uiautomator dump
      mockShell.mockResolvedValueOnce(
        '<node resource-id="com.whatsapp:id/entry" class="android.widget.EditText" />'
      )

      const result = await detector.behavioralProbe('DEVICE1', '5543991938235')
      expect(result.isBanned).toBe(false)
      expect(result.hasInputField).toBe(true)
    })

    it('returns isBanned=true when input field is missing in UI dump', async () => {
      const mockShell = adb.shell as ReturnType<typeof vi.fn>
      mockShell.mockResolvedValueOnce('') // am start intent
      mockShell.mockResolvedValueOnce('') // sleep/wait
      mockShell.mockResolvedValueOnce('') // uiautomator dump
      // UI dump without input field — ban/verify screen
      mockShell.mockResolvedValueOnce(
        '<node resource-id="com.whatsapp:id/verify_sms" class="android.widget.Button" text="Verify" />'
      )

      const result = await detector.behavioralProbe('DEVICE1', '5543991938235')
      expect(result.isBanned).toBe(true)
      expect(result.hasInputField).toBe(false)
    })
  })

  describe('extractBanCountdown', () => {
    it('parses "8 horas e 23 minutos" to correct duration', () => {
      const uiDump = `
        <node text="Você poderá usar o WhatsApp novamente em 8 horas e 23 minutos" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).not.toBeNull()
      // 8h23m = (8*60 + 23) * 60 * 1000 = 30,180,000ms
      expect(result!.durationMs).toBe(8 * 60 * 60 * 1000 + 23 * 60 * 1000)
    })

    it('parses "24 horas" to correct duration', () => {
      const uiDump = `
        <node text="Você poderá usar o WhatsApp novamente em 24 horas" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).not.toBeNull()
      expect(result!.durationMs).toBe(24 * 60 * 60 * 1000)
    })

    it('parses "45 minutos" to correct duration', () => {
      const uiDump = `
        <node text="Você poderá usar o WhatsApp novamente em 45 minutos" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).not.toBeNull()
      expect(result!.durationMs).toBe(45 * 60 * 1000)
    })

    it('parses English format "8 hours and 23 minutes"', () => {
      const uiDump = `
        <node text="You can use WhatsApp again in 8 hours and 23 minutes" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).not.toBeNull()
      expect(result!.durationMs).toBe(8 * 60 * 60 * 1000 + 23 * 60 * 1000)
    })

    it('returns null when no countdown found in UI dump', () => {
      const uiDump = `
        <node text="WhatsApp Settings" />
        <node text="Linked Devices" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).toBeNull()
    })

    it('stores raw text in result', () => {
      const uiDump = `
        <node text="Você poderá usar o WhatsApp novamente em 2 horas e 15 minutos" />
      `
      const result = detector.extractBanCountdown(uiDump)
      expect(result).not.toBeNull()
      expect(result!.rawText).toContain('2 horas e 15 minutos')
    })
  })
})
