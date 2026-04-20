import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdbBridge } from '../adb/index.js'

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
])

const MAX_FILE_SIZE = 16 * 1024 * 1024 // 16MB WhatsApp limit

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

export interface MediaSendParams {
  deviceSerial: string
  mediaUrl: string
  mediaType: string
  appPackage: string
  caption?: string
}

export class MediaSender {
  constructor(
    private adb: AdbBridge,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Download a file from mediaUrl, push it to the device, and send via ACTION_SEND share intent.
   * Cleans up the local temp file after pushing to device.
   */
  async sendMedia(params: MediaSendParams): Promise<void> {
    if (!ALLOWED_MIME_TYPES.has(params.mediaType)) {
      throw new Error(`Unsupported media type: ${params.mediaType}`)
    }

    // Download file
    const response = await this.fetchFn(params.mediaUrl)
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status} ${response.statusText}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`Media file too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`)
    }

    const ext = MIME_TO_EXT[params.mediaType] ?? 'bin'
    const tempDir = 'reports/media-temp'
    const localPath = join(tempDir, `dispatch-media.${ext}`)
    const remotePath = `/sdcard/Download/dispatch-media.${ext}`

    try {
      await mkdir(tempDir, { recursive: true })
      await writeFile(localPath, buffer)

      // Push to device: clear existing, then write via base64 shell encoding
      await this.adb.shell(params.deviceSerial, `rm -f ${remotePath}`)

      const b64 = buffer.toString('base64')
      if (b64.length < 100_000) {
        // Small files: single shell call
        await this.adb.shell(
          params.deviceSerial,
          `echo '${b64}' | base64 -d > ${remotePath}`,
        )
      } else {
        // Larger files: write in chunks to avoid shell argument limits
        await this.adb.shell(params.deviceSerial, `true > ${remotePath}`)
        const chunkSize = 50_000
        for (let i = 0; i < b64.length; i += chunkSize) {
          const chunk = b64.slice(i, i + chunkSize)
          await this.adb.shell(
            params.deviceSerial,
            `echo -n '${chunk}' | base64 -d >> ${remotePath}`,
          )
        }
      }

      // Build share intent command
      const intentParts = [
        'am start -a android.intent.action.SEND',
        `-t ${params.mediaType}`,
        `--eu android.intent.extra.STREAM file://${remotePath}`,
        `-p ${params.appPackage}`,
      ]

      if (params.caption) {
        const escapedCaption = params.caption.replace(/'/g, "'\\''")
        intentParts.push(`--es android.intent.extra.TEXT '${escapedCaption}'`)
      }

      await this.adb.shell(params.deviceSerial, intentParts.join(' '))
    } finally {
      // Cleanup local temp file (best-effort)
      try {
        await unlink(localPath)
      } catch {
        /* ignore — file may not exist if download/write failed */
      }
    }
  }
}
