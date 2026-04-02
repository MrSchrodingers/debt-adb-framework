import type { BanDetectionConfig, OcrAnalysis, BehavioralProbeResult, BanCountdown } from './types.js'
import type { AdbShellAdapter } from '../monitor/types.js'

export class BanDetector {
  constructor(
    private config: BanDetectionConfig,
    private adb: AdbShellAdapter,
  ) {}

  /** Analyze screenshot text for ban indicators via OCR */
  analyzeScreenshot(_ocrText: string, _confidence: number): OcrAnalysis {
    throw new Error('Not implemented')
  }

  /** Behavioral probe: open wa.me chat and check if input field exists */
  behavioralProbe(_deviceSerial: string, _toNumber: string): Promise<BehavioralProbeResult> {
    throw new Error('Not implemented')
  }

  /** Extract ban countdown duration from UIAutomator dump text */
  extractBanCountdown(_uiDumpText: string): BanCountdown | null {
    throw new Error('Not implemented')
  }
}
