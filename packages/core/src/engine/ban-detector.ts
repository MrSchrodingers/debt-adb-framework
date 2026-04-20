import type { BanDetectionConfig, OcrAnalysis, BehavioralProbeResult, BanCountdown } from './types.js'
import { assertSafePhone } from './types.js'
import type { AdbShellAdapter } from '../monitor/types.js'

export class BanDetector {
  constructor(
    private config: BanDetectionConfig,
    private adb: AdbShellAdapter,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
  ) {}

  analyzeScreenshot(ocrText: string, confidence: number): OcrAnalysis {
    if (confidence < this.config.ocrConfidenceThreshold) {
      return { isSuspect: false, confidence, matchedStrings: [] }
    }

    const lowerText = ocrText.toLowerCase()
    const matchedStrings = this.config.banStrings.filter(s => lowerText.includes(s.toLowerCase()))

    return {
      isSuspect: matchedStrings.length > 0,
      confidence,
      matchedStrings,
    }
  }

  async behavioralProbe(deviceSerial: string, toNumber: string): Promise<BehavioralProbeResult> {
    assertSafePhone(toNumber)
    await this.adb.shell(
      deviceSerial,
      `am start -a android.intent.action.VIEW -d "https://wa.me/${toNumber}" -p com.whatsapp`,
    )
    await this.delay(4000)

    // UIAutomator dump
    await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-probe.xml')
    const xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-probe.xml')

    // Check for chat input field (EditText with entry/input resource-id)
    const hasInputField = /resource-id="com\.whatsapp:id\/(entry|conversation_entry|text_entry)"/.test(xml)
      || (/class="android\.widget\.EditText"/.test(xml) && /com\.whatsapp/.test(xml))

    return {
      isBanned: !hasInputField,
      hasInputField,
    }
  }

  extractBanCountdown(uiDumpText: string): BanCountdown | null {
    // Match Portuguese: "X horas e Y minutos", "X horas", "Y minutos"
    // Match English: "X hours and Y minutes", "X hours", "Y minutes"
    const patterns = [
      /(\d+)\s*(?:horas?|hours?)\s*(?:e|and)\s*(\d+)\s*(?:minutos?|minutes?)/i,
      /(\d+)\s*(?:horas?|hours?)/i,
      /(\d+)\s*(?:minutos?|minutes?)/i,
    ]

    for (const pattern of patterns) {
      const match = uiDumpText.match(pattern)
      if (!match) continue

      const fullMatch = match[0]

      // First pattern: hours + minutes
      if (match[2] !== undefined) {
        const hours = parseInt(match[1], 10)
        const minutes = parseInt(match[2], 10)
        return {
          durationMs: hours * 60 * 60 * 1000 + minutes * 60 * 1000,
          rawText: fullMatch,
        }
      }

      // Second/third pattern: check if it's hours or minutes
      const value = parseInt(match[1], 10)
      if (/horas?|hours?/i.test(fullMatch)) {
        return { durationMs: value * 60 * 60 * 1000, rawText: fullMatch }
      }
      return { durationMs: value * 60 * 1000, rawText: fullMatch }
    }

    return null
  }
}
