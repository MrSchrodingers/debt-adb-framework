import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MediaSender } from './media-sender.js'
import type { AdbBridge } from '../adb/index.js'
import { unlink, readdir } from 'node:fs/promises'

function createMockAdb(): AdbBridge {
  return {
    shell: vi.fn().mockResolvedValue(''),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    discover: vi.fn().mockResolvedValue([]),
    forward: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(Buffer.from('')),
  } as unknown as AdbBridge
}

function createMockFetch(body: Buffer, status = 200, statusText = 'OK'): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }) as unknown as typeof fetch
}

describe('MediaSender', () => {
  let mockAdb: AdbBridge
  const smallJpeg = Buffer.alloc(1024, 0xff) // 1KB fake JPEG

  beforeEach(() => {
    mockAdb = createMockAdb()
  })

  afterEach(async () => {
    // Cleanup temp files that may have been created
    try {
      const files = await readdir('reports/media-temp')
      for (const f of files) {
        try { await unlink(`reports/media-temp/${f}`) } catch { /* ignore */ }
      }
    } catch { /* dir may not exist */ }
  })

  it('downloads file from URL and pushes to device via ADB', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/photo.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
    })

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/photo.jpg')

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )

    // Should remove old file first
    expect(shellCalls.some((cmd: string) => cmd.includes('rm -f /sdcard/Download/dispatch-media.jpg'))).toBe(true)

    // Should push via base64
    expect(shellCalls.some((cmd: string) => cmd.includes('base64 -d'))).toBe(true)
  })

  it('sends share intent with correct MIME type', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/photo.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
    })

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )

    const intentCall = shellCalls.find((cmd: string) => cmd.includes('android.intent.action.SEND'))
    expect(intentCall).toBeDefined()
    expect(intentCall).toContain('-t image/jpeg')
    expect(intentCall).toContain('file:///sdcard/Download/dispatch-media.jpg')
    expect(intentCall).toContain('-p com.whatsapp')
  })

  it('includes caption as android.intent.extra.TEXT when provided', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/photo.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
      caption: 'Check this out!',
    })

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )

    const intentCall = shellCalls.find((cmd: string) => cmd.includes('android.intent.action.SEND'))
    expect(intentCall).toContain("android.intent.extra.TEXT 'Check this out!'")
  })

  it('handles download failure gracefully', async () => {
    const mockFetch = createMockFetch(Buffer.alloc(0), 404, 'Not Found')
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/missing.jpg',
        mediaType: 'image/jpeg',
        appPackage: 'com.whatsapp',
      }),
    ).rejects.toThrow('Failed to download media: 404 Not Found')
  })

  it('cleans up temp file after push', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/photo.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
    })

    // After send completes, the local temp file should be removed
    // We verify by checking unlink would fail (file doesn't exist)
    await expect(unlink('reports/media-temp/dispatch-media.jpg')).rejects.toThrow()
  })

  it('rejects files larger than 16MB', async () => {
    const bigFile = Buffer.alloc(17 * 1024 * 1024) // 17MB
    const mockFetch = createMockFetch(bigFile)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/huge.jpg',
        mediaType: 'image/jpeg',
        appPackage: 'com.whatsapp',
      }),
    ).rejects.toThrow('Media file too large')
  })

  it('supports image/jpeg', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/photo.jpg',
        mediaType: 'image/jpeg',
        appPackage: 'com.whatsapp',
      }),
    ).resolves.toBeUndefined()
  })

  it('supports image/png', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/image.png',
        mediaType: 'image/png',
        appPackage: 'com.whatsapp',
      }),
    ).resolves.toBeUndefined()

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )
    expect(shellCalls.some((cmd: string) => cmd.includes('dispatch-media.png'))).toBe(true)
  })

  it('supports image/webp', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/sticker.webp',
        mediaType: 'image/webp',
        appPackage: 'com.whatsapp',
      }),
    ).resolves.toBeUndefined()
  })

  it('supports application/pdf', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/doc.pdf',
        mediaType: 'application/pdf',
        appPackage: 'com.whatsapp',
      }),
    ).resolves.toBeUndefined()

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )
    expect(shellCalls.some((cmd: string) => cmd.includes('dispatch-media.pdf'))).toBe(true)
  })

  it('rejects unsupported MIME types', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await expect(
      sender.sendMedia({
        deviceSerial: 'device-1',
        mediaUrl: 'https://example.com/video.mp4',
        mediaType: 'video/mp4',
        appPackage: 'com.whatsapp',
      }),
    ).rejects.toThrow('Unsupported media type: video/mp4')

    // Should not have attempted any ADB shell calls
    expect(mockAdb.shell).not.toHaveBeenCalled()
  })

  it('uses chunked transfer for files with large base64 encoding', async () => {
    // Create a buffer whose base64 exceeds 100k chars (~75KB binary)
    const largeFile = Buffer.alloc(80_000, 0xab)
    const mockFetch = createMockFetch(largeFile)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/large.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
    })

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )

    // Should have created empty file first
    expect(shellCalls.some((cmd: string) => cmd.startsWith('true > /sdcard/Download/dispatch-media.jpg'))).toBe(true)

    // Should have multiple append calls (chunked)
    const appendCalls = shellCalls.filter((cmd: string) => cmd.includes('>> /sdcard/Download/'))
    expect(appendCalls.length).toBeGreaterThan(1)
  })

  it('escapes single quotes in caption', async () => {
    const mockFetch = createMockFetch(smallJpeg)
    const sender = new MediaSender(mockAdb, mockFetch)

    await sender.sendMedia({
      deviceSerial: 'device-1',
      mediaUrl: 'https://example.com/photo.jpg',
      mediaType: 'image/jpeg',
      appPackage: 'com.whatsapp',
      caption: "It's a test",
    })

    const shellCalls = (mockAdb.shell as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string,
    )

    const intentCall = shellCalls.find((cmd: string) => cmd.includes('android.intent.action.SEND'))
    expect(intentCall).toBeDefined()
    // Should contain escaped quote
    expect(intentCall).toContain("It'\\''s a test")
  })
})
