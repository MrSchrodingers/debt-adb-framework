/**
 * Phase 3 E2E — Send batch of 5 messages with rate limiting
 *
 * Usage: npx tsx scripts/phase-3-e2e.ts
 *
 * Sends 5 messages to TEST_PHONE_NUMBER via ADB on POCO Serenity,
 * with the Phase 3 rate limiter controlling delays between sends.
 * Saves final screenshot as proof.
 */

import { writeFileSync } from 'node:fs'
import { AdbBridge } from '../packages/core/src/adb/adb-bridge.js'
import { RateLimiter } from '../packages/core/src/engine/rate-limiter.js'
import { DEFAULT_RATE_LIMIT_CONFIG } from '../packages/core/src/engine/types.js'
import type { RateLimitStore } from '../packages/core/src/engine/types.js'

const DEVICE_SERIAL = '9b01005930533036340030832250ac'
const TEST_PHONE = '5543991938235'
const PACKAGE = 'com.whatsapp'

// In-memory store (Redis in prod)
class InMemoryStore implements RateLimitStore {
  private timestamps = new Map<string, number[]>()
  private pairSends = new Map<string, number>()

  async getSendTimestamps(senderNumber: string): Promise<number[]> {
    return this.timestamps.get(senderNumber) ?? []
  }
  async addSendTimestamp(senderNumber: string, timestamp: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    ts.push(timestamp)
    this.timestamps.set(senderNumber, ts)
  }
  async cleanExpiredTimestamps(senderNumber: string, windowMs: number): Promise<void> {
    const ts = this.timestamps.get(senderNumber) ?? []
    const cutoff = Date.now() - windowMs
    this.timestamps.set(senderNumber, ts.filter(t => t > cutoff))
  }
  async getLastPairSend(senderNumber: string, toNumber: string): Promise<number | null> {
    return this.pairSends.get(`${senderNumber}:${toNumber}`) ?? null
  }
  async setLastPairSend(senderNumber: string, toNumber: string, timestamp: number): Promise<void> {
    this.pairSends.set(`${senderNumber}:${toNumber}`, timestamp)
  }
  async getSendCount(senderNumber: string): Promise<number> {
    return (this.timestamps.get(senderNumber) ?? []).length
  }
}

function gaussianDelay(mean: number, stddev: number): number {
  const u1 = Math.random()
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(20, Math.round(mean + z * stddev))
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function sendMessage(adb: AdbBridge, serial: string, body: string): Promise<Buffer> {
  // Clean state
  await adb.shell(serial, 'input keyevent 4')
  await delay(300)
  await adb.shell(serial, 'input keyevent 3')
  await delay(500)

  // Open WA chat
  await adb.shell(serial, `am start -a android.intent.action.VIEW -d "https://wa.me/${TEST_PHONE}" -p ${PACKAGE}`)
  await delay(4000)

  // Type message
  for (const char of body) {
    if (char === ' ') {
      await adb.shell(serial, 'input keyevent 62')
    } else {
      const escaped = char.replace(/'/g, "'\\''")
      await adb.shell(serial, `input text '${escaped}'`)
    }
    await delay(gaussianDelay(80, 30))
  }

  // Send
  await delay(500)
  await adb.shell(serial, 'uiautomator dump /sdcard/dispatch-ui.xml')
  const xml = await adb.shell(serial, 'cat /sdcard/dispatch-ui.xml')
  const match = xml.match(
    /resource-id="com\.whatsapp:id\/send"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
  )
  if (match) {
    const [, x1, y1, x2, y2] = match.map(Number)
    const cx = Math.round((x1 + x2) / 2)
    const cy = Math.round((y1 + y2) / 2)
    await adb.shell(serial, `input tap ${cx} ${cy}`)
  } else {
    await adb.shell(serial, 'input keyevent 66')
  }

  await delay(2000)
  return adb.screenshot(serial)
}

async function main() {
  const adb = new AdbBridge()
  const store = new InMemoryStore()

  // Use a shorter config for E2E (don't wait 20-35s between each during testing)
  const e2eConfig = {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    baseMinDelayS: 8.0,  // Shorter for E2E — still demonstrates rate limiting
    baseMaxDelayS: 12.0,
  }
  const limiter = new RateLimiter(store, e2eConfig)
  const senderNumber = 'e2e-test'

  console.log('=== Phase 3 E2E: Rate-Limited Batch Send ===')
  console.log(`Device: ${DEVICE_SERIAL}`)
  console.log(`Target: ${TEST_PHONE}`)
  console.log(`Messages: 5`)
  console.log(`Rate limit: ${e2eConfig.baseMinDelayS}-${e2eConfig.baseMaxDelayS}s base`)
  console.log()

  // Verify device
  const devices = await adb.discover()
  const device = devices.find(d => d.serial === DEVICE_SERIAL)
  if (!device || device.type !== 'device') {
    console.error('Device not found or not authorized')
    process.exit(1)
  }
  console.log(`Device found: ${device.brand} ${device.model} (${device.serial})`)

  const messages = [
    'E2E Phase 3 msg 1/5 — rate limiter active',
    'E2E Phase 3 msg 2/5 — volume scaling test',
    'E2E Phase 3 msg 3/5 — jitter applied',
    'E2E Phase 3 msg 4/5 — dispatch engine',
    'E2E Phase 3 msg 5/5 — batch complete',
  ]

  const sendTimes: number[] = []
  let lastScreenshot: Buffer | null = null

  for (let i = 0; i < messages.length; i++) {
    // Check rate limit (skip first — no cooldown yet)
    if (i > 0) {
      const check = await limiter.canSend(senderNumber, TEST_PHONE)
      if (!check.canSend) {
        const waitS = (check.waitMs / 1000).toFixed(1)
        console.log(`  Rate limit: waiting ${waitS}s...`)
        await delay(check.waitMs)
      }

      // Apply jitter on top of scaled delay
      const scaledDelay = await limiter.calculateScaledDelay(senderNumber)
      const finalDelay = limiter.applyJitter(scaledDelay)
      const elapsed = Date.now() - sendTimes[i - 1]
      const remaining = Math.max(0, finalDelay - elapsed)
      if (remaining > 0) {
        const waitS = (remaining / 1000).toFixed(1)
        const scale = await limiter.getVolumeScale(senderNumber)
        console.log(`  Delay: ${waitS}s (scale: ${scale.toFixed(2)}x)`)
        await delay(remaining)
      }
    }

    const startMs = Date.now()
    console.log(`[${i + 1}/5] Sending: "${messages[i]}"`)

    lastScreenshot = await sendMessage(adb, DEVICE_SERIAL, messages[i])
    await limiter.recordSend(senderNumber, TEST_PHONE)
    sendTimes.push(Date.now())

    const durationS = ((Date.now() - startMs) / 1000).toFixed(1)
    console.log(`  Sent in ${durationS}s`)
  }

  // Save final screenshot
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const screenshotPath = `reports/phase-3-e2e-${timestamp}.png`
  writeFileSync(screenshotPath, lastScreenshot!)
  console.log()
  console.log(`Screenshot saved: ${screenshotPath}`)

  // Summary
  console.log()
  console.log('=== Summary ===')
  for (let i = 1; i < sendTimes.length; i++) {
    const gap = ((sendTimes[i] - sendTimes[i - 1]) / 1000).toFixed(1)
    console.log(`  Gap ${i}→${i + 1}: ${gap}s`)
  }
  const totalS = ((sendTimes[sendTimes.length - 1] - sendTimes[0]) / 1000).toFixed(1)
  console.log(`  Total: ${totalS}s for 5 messages`)
  console.log(`  Volume count: ${await store.getSendCount(senderNumber)}`)
  console.log()
  console.log('E2E PASSED')
}

main().catch((err) => {
  console.error('E2E FAILED:', err)
  process.exit(1)
})
