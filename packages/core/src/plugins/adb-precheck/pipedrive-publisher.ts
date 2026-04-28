import type { PluginLogger } from '../types.js'
import type { PipedriveClient } from './pipedrive-client.js'
import {
  buildDealAllFailActivity,
  buildPastaSummaryNote,
  buildPhoneFailActivity,
} from './pipedrive-formatter.js'
import type {
  PipedriveDealAllFailIntent,
  PipedriveOutgoingIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

/**
 * Async dispatcher between scanner and PipedriveClient.
 *
 * Responsibilities (separated from the client because a) the scanner must NOT
 * block on Pipedrive HTTP and b) we own dedup, which Pipedrive doesn't):
 *
 *   1. Scanner calls `enqueueXxx(...)` — synchronous, fire-and-forget.
 *   2. Publisher dedups by `dedup_key` (combination of scenario + deal +
 *      phone + job_id). Re-enqueueing the same intent within the publisher's
 *      lifetime is a no-op.
 *   3. A single drain loop picks intents off the queue and feeds them to
 *      `client.dispatch(...)` one at a time, respecting the client's own
 *      token-bucket. Drain is initiated lazily by `enqueue*` and re-armed
 *      whenever new intents arrive.
 *
 * Lifetime: tied to the AdbPrecheckPlugin. `flush()` waits for the queue to
 * drain — useful in tests and during graceful shutdown.
 */
export class PipedrivePublisher {
  private readonly queue: PipedriveOutgoingIntent[] = []
  private readonly seenDedupKeys = new Set<string>()
  private draining = false
  private drainPromise: Promise<void> | null = null

  constructor(
    private readonly client: PipedriveClient,
    private readonly logger: PluginLogger,
  ) {}

  enqueuePhoneFail(intent: PipedrivePhoneFailIntent): void {
    this.add(buildPhoneFailActivity(intent))
  }

  enqueueDealAllFail(intent: PipedriveDealAllFailIntent): void {
    this.add(buildDealAllFailActivity(intent))
  }

  enqueuePastaSummary(intent: PipedrivePastaSummaryIntent): void {
    this.add(buildPastaSummaryNote(intent))
  }

  /** Resolves when the queue is empty AND the in-flight drain has finished. */
  async flush(): Promise<void> {
    if (!this.drainPromise) return
    await this.drainPromise
  }

  /** Test helper. */
  pendingCount(): number {
    return this.queue.length
  }

  /** Test helper — view the dedup memory size. */
  dedupSize(): number {
    return this.seenDedupKeys.size
  }

  private add(intent: PipedriveOutgoingIntent): void {
    if (this.seenDedupKeys.has(intent.dedup_key)) {
      this.logger.debug('pipedrive intent deduped', { dedup_key: intent.dedup_key })
      return
    }
    this.seenDedupKeys.add(intent.dedup_key)
    this.queue.push(intent)
    this.kickDrain()
  }

  private kickDrain(): void {
    if (this.draining) return
    this.draining = true
    this.drainPromise = this.drain().finally(() => {
      this.draining = false
    })
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()!
      try {
        const r = await this.client.dispatch(next)
        if (!r.ok) {
          this.logger.warn('pipedrive dispatch returned ok:false', {
            kind: next.kind,
            dedup_key: next.dedup_key,
            attempts: r.attempts,
            status: r.status,
            error: r.error,
          })
        } else {
          this.logger.debug('pipedrive dispatch ok', {
            kind: next.kind,
            dedup_key: next.dedup_key,
            attempts: r.attempts,
          })
        }
      } catch (e) {
        // Defense-in-depth: client is supposed to swallow errors, but we
        // never let a renegade exception kill the drain loop.
        this.logger.error('pipedrive dispatch threw (unexpected)', {
          dedup_key: next.dedup_key,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }
}
