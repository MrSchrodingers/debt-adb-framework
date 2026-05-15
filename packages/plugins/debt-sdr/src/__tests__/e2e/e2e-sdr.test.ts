/**
 * Phase E Task 43 — E2E test scaffold.
 *
 * STATUS: SCAFFOLD ONLY — no real send. Gated by `RUN_E2E=true` so
 * `pnpm test` in CI / dev never reaches a real device or Pipedrive
 * sandbox unless the operator explicitly opts in.
 *
 * When the operator does run it, the suite reserves the test device
 * via a flock-style file lock (`/tmp/dispatch-e2e.lock`) so a parallel
 * `pnpm -r test` can't interfere. The target phone is hard-pinned to
 * `TEST_PHONE_NUMBER=5543991938235` per CLAUDE.md — any other number
 * is rejected at setup time.
 *
 * Pre-conditions (operator must satisfy before RUN_E2E=true):
 *   - POCO #2 (TEST_DEVICE_SERIAL env) reserved & online
 *   - Real WAHA session bound to TEST_SENDER (env)
 *   - Pipedrive sandbox credentials present
 *       PIPEDRIVE_SANDBOX_DOMAIN, PIPEDRIVE_SANDBOX_TOKEN
 *   - DISPATCH_SDR_CRONS_ENABLED stays false during the run
 *
 * On run: the test will FAIL CLOSED if any precondition is missing
 * (we'd rather skip than accidentally send mass traffic).
 *
 * NOTE: this file intentionally contains no enqueue/send calls yet —
 * the runtime fixtures are stubbed (`xfail` style). Wiring real sends
 * lands in a follow-up under operator supervision.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SHOULD_RUN = process.env.RUN_E2E === 'true'
const describe_ = SHOULD_RUN ? describe : describe.skip

const TEST_PHONE = '5543991938235'
const LOCK_PATH = '/tmp/dispatch-e2e.lock'

interface E2EContext {
  acquiredLock: boolean
  testDevice: string
  testSender: string
  pipedriveDomain: string
  pipedriveToken: string
}

const ctx: Partial<E2EContext> = {}

describe_('SDR E2E (real ADB to TEST_PHONE_NUMBER, real Pipedrive sandbox)', () => {
  beforeAll(async () => {
    // 1. Hard-pin to TEST_PHONE — refuse to run if anyone tries to retarget.
    expect(TEST_PHONE).toBe('5543991938235')

    // 2. Acquire exclusive lock so parallel suites can't double-target the device.
    try {
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' })
      ctx.acquiredLock = true
    } catch (err) {
      throw new Error(
        `E2E lock contention — ${LOCK_PATH} exists. Another suite is running. Remove the lock manually if stale (err=${String(err)}).`,
      )
    }

    // 3. Required env vars.
    const required = [
      'TEST_DEVICE_SERIAL',
      'TEST_SENDER',
      'PIPEDRIVE_SANDBOX_DOMAIN',
      'PIPEDRIVE_SANDBOX_TOKEN',
    ]
    const missing = required.filter((k) => !process.env[k])
    if (missing.length > 0) {
      throw new Error(`E2E missing required env vars: ${missing.join(', ')}`)
    }
    ctx.testDevice = process.env.TEST_DEVICE_SERIAL
    ctx.testSender = process.env.TEST_SENDER
    ctx.pipedriveDomain = process.env.PIPEDRIVE_SANDBOX_DOMAIN
    ctx.pipedriveToken = process.env.PIPEDRIVE_SANDBOX_TOKEN

    // 4. Sanity: crons must remain disabled during E2E (no mass traffic).
    if (process.env.DISPATCH_SDR_CRONS_ENABLED === 'true') {
      throw new Error('Refusing to run E2E with DISPATCH_SDR_CRONS_ENABLED=true — cron loops would race the test.')
    }
  })

  afterAll(async () => {
    if (ctx.acquiredLock) {
      try {
        fs.unlinkSync(LOCK_PATH)
      } catch {
        // If unlink fails, surface in logs but don't fail the suite —
        // an orphan lock will be caught by the next run's beforeAll.
      }
    }
  })

  it.skip('happy path: new lead → identity verified → cold-1 → "interessado" → Pipedrive qualified', async () => {
    // SCAFFOLD: real send wired in follow-up. Steps when ready:
    //   1. Insert deal in Pipedrive sandbox at stage_new_lead.
    //   2. Trigger LeadPuller.pullTenant on the sandbox tenant.
    //   3. Assert lead row in sdr_lead_queue with state='pulled'.
    //   4. Trigger Sequencer.tick — assert intro enqueued.
    //   5. ADB worker sends intro to TEST_PHONE.
    //   6. Simulate inbound "sim sou eu" via WAHA webhook.
    //   7. Trigger Sequencer.tick — assert cold-1 enqueued.
    //   8. Simulate inbound "tenho interesse" via WAHA.
    //   9. Assert Pipedrive stage moved to stage_qualified.
    expect(true).toBe(true)
  })

  it.skip('wrong number: "não sou eu" → wrong_number + Pipedrive stage_disqualified', async () => {
    // SCAFFOLD: see happy path skeleton; mirror with rejection response.
    expect(true).toBe(true)
  })

  it.skip('opt-out: "pare de me mandar" → opted_out + permanent blacklist + writeback', async () => {
    // SCAFFOLD: same skeleton; assertion is queue.recordBan-ish behavior
    // surfaces in the central blacklist.
    expect(true).toBe(true)
  })

  it('preflight: lock file acquired and env vars present', () => {
    expect(ctx.acquiredLock).toBe(true)
    expect(ctx.testDevice).toBeTypeOf('string')
    expect(ctx.testSender).toBeTypeOf('string')
    expect(path.isAbsolute(LOCK_PATH)).toBe(true)
  })
})
