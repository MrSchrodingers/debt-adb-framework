/**
 * ScreenshotPolicy — controls screenshot sampling, compression, and retention.
 *
 * Reduces storage from ~336MB/day (all PNGs) to ~10MB/day via:
 * - Sampling: mode='sample' captures 100% failures + configurable % successes
 * - Compression: optional JPEG via sharp (87% size reduction at quality=60)
 * - Retention: configurable auto-cleanup of old screenshot files
 *
 * JPEG compression requires the `sharp` package (optional dependency).
 * If sharp is not installed, processBuffer falls back to returning the original PNG.
 * Install with: npm install sharp (adds ~30MB native dep — only if you want JPEG).
 */

export interface ScreenshotPolicyConfig {
  mode: 'all' | 'sample' | 'none'
  sampleRate: number   // 0-1, only used when mode='sample'
  format: 'png' | 'jpeg'
  jpegQuality: number  // 1-100, default 60
  retentionDays: number
}

const DEFAULTS: ScreenshotPolicyConfig = {
  mode: 'all',
  sampleRate: 0.1,
  format: 'png',
  jpegQuality: 60,
  retentionDays: 7,
}

export class ScreenshotPolicy {
  private config: ScreenshotPolicyConfig

  constructor(config?: Partial<ScreenshotPolicyConfig>) {
    this.config = { ...DEFAULTS, ...config }
  }

  static fromEnv(env: Record<string, string | undefined>): ScreenshotPolicy {
    return new ScreenshotPolicy({
      mode: (env.SCREENSHOT_MODE as 'all' | 'sample' | 'none') || DEFAULTS.mode,
      sampleRate: env.SCREENSHOT_SAMPLE_RATE ? Number(env.SCREENSHOT_SAMPLE_RATE) : DEFAULTS.sampleRate,
      format: (env.SCREENSHOT_FORMAT as 'png' | 'jpeg') || DEFAULTS.format,
      jpegQuality: env.SCREENSHOT_JPEG_QUALITY ? Number(env.SCREENSHOT_JPEG_QUALITY) : DEFAULTS.jpegQuality,
      retentionDays: env.SCREENSHOT_RETENTION_DAYS ? Number(env.SCREENSHOT_RETENTION_DAYS) : DEFAULTS.retentionDays,
    })
  }

  /** Whether to capture a screenshot for this send result */
  shouldCapture(success: boolean): boolean {
    if (this.config.mode === 'all') return true
    if (this.config.mode === 'none') return false
    // mode = 'sample': always capture failures, sample successes
    if (!success) return true
    return Math.random() < this.config.sampleRate
  }

  /** Get the file extension for screenshots */
  get format(): 'png' | 'jpeg' {
    return this.config.format
  }

  /** Get JPEG quality setting */
  get jpegQuality(): number {
    return this.config.jpegQuality
  }

  /** Get output file path for a message screenshot */
  getOutputPath(messageId: string): string {
    const ext = this.config.format === 'jpeg' ? 'jpg' : 'png'
    return `reports/sends/${messageId}.${ext}`
  }

  /**
   * Process screenshot buffer — compress to JPEG if configured.
   * Falls back to original PNG if sharp is not installed.
   */
  async processBuffer(buffer: Buffer): Promise<Buffer> {
    if (this.config.format === 'png') return buffer
    // JPEG compression via sharp (optional dependency — not in package.json)
    try {
      // @ts-expect-error sharp is an optional peer dep; missing at build time is expected
      const sharp = await import('sharp')
      return await sharp.default(buffer).jpeg({ quality: this.config.jpegQuality }).toBuffer()
    } catch {
      // sharp not available or conversion failed — return original PNG
      return buffer
    }
  }

  get retentionDays(): number {
    return this.config.retentionDays
  }
}
