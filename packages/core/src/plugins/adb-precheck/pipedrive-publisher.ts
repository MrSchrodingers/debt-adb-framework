import type { PluginLogger } from '../types.js'
import type { PipedriveClient } from './pipedrive-client.js'
import {
  buildDealAllFailActivity,
  buildPastaSummaryNote,
  buildPhoneFailActivity,
} from './pipedrive-formatter.js'
import type { PipedriveActivityStore } from './pipedrive-activity-store.js'
import type {
  PipedriveDealAllFailIntent,
  PipedriveOutgoingIntent,
  PipedrivePastaSummaryIntent,
  PipedrivePhoneFailIntent,
} from './types.js'

/**
 * Async dispatcher between scanner and PipedriveClient.
 *
 * Responsibilities:
 *   1. Scanner calls `enqueueXxx(...)` — synchronous, fire-and-forget.
 *   2. Publisher dedups by `dedup_key` (combination of scenario + deal +
 *      phone + job_id). Re-enqueueing the same intent within the publisher's
 *      lifetime is a no-op.
 *   3. Optionally persists every intent in `pipedrive_activities` BEFORE the
 *      HTTP call (status='retrying', attempts=1) and updates the row AFTER
 *      with the dispatch result. The store is optional so existing tests can
 *      continue to construct a publisher without touching SQLite.
 *   4. A single drain loop picks intents off the queue and feeds them to
 *      `client.dispatch(...)` one at a time, respecting the client's own
 *      token-bucket. Drain is initiated lazily by `enqueue*` and re-armed
 *      whenever new intents arrive.
 *
 * Lifetime: tied to the AdbPrecheckPlugin. `flush()` waits for the queue to
 * drain — useful in tests and during graceful shutdown.
 */
interface PendingIntent {
  intent: PipedriveOutgoingIntent
  /** SQLite row id created via store.insertPending — null when no store. */
  rowId: string | null
}

export interface PublisherEnqueueMeta {
  scenario: 'phone_fail' | 'deal_all_fail' | 'pasta_summary'
  deal_id: number
  pasta: string | null
  phone_normalized: string | null
  job_id: string | null
  manual?: boolean
  triggered_by?: string | null
}

export class PipedrivePublisher {
  private readonly queue: PendingIntent[] = []
  private readonly seenDedupKeys = new Set<string>()
  private draining = false
  private drainPromise: Promise<void> | null = null

  constructor(
    private readonly client: PipedriveClient,
    private readonly logger: PluginLogger,
    private readonly store?: PipedriveActivityStore,
    private readonly companyDomain?: string | null,
  ) {}

  enqueuePhoneFail(intent: PipedrivePhoneFailIntent, meta?: Partial<PublisherEnqueueMeta>): string | null {
    return this.add(buildPhoneFailActivity(intent, this.companyDomain), {
      scenario: 'phone_fail',
      deal_id: intent.deal_id,
      pasta: intent.pasta,
      phone_normalized: intent.phone,
      job_id: intent.job_id,
      manual: meta?.manual,
      triggered_by: meta?.triggered_by,
    })
  }

  enqueueDealAllFail(intent: PipedriveDealAllFailIntent, meta?: Partial<PublisherEnqueueMeta>): string | null {
    return this.add(buildDealAllFailActivity(intent, this.companyDomain), {
      scenario: 'deal_all_fail',
      deal_id: intent.deal_id,
      pasta: intent.pasta,
      phone_normalized: null,
      job_id: intent.job_id,
      manual: meta?.manual,
      triggered_by: meta?.triggered_by,
    })
  }

  enqueuePastaSummary(intent: PipedrivePastaSummaryIntent, meta?: Partial<PublisherEnqueueMeta>): string | null {
    return this.add(buildPastaSummaryNote(intent, this.companyDomain), {
      scenario: 'pasta_summary',
      deal_id: intent.first_deal_id,
      pasta: intent.pasta,
      phone_normalized: null,
      job_id: intent.job_id,
      manual: meta?.manual,
      triggered_by: meta?.triggered_by,
    })
  }

  /** Resolves when the queue is empty AND the in-flight drain has finished. */
  async flush(): Promise<void> {
    if (!this.drainPromise) return
    await this.drainPromise
  }

  pendingCount(): number {
    return this.queue.length
  }

  dedupSize(): number {
    return this.seenDedupKeys.size
  }

  private add(intent: PipedriveOutgoingIntent, meta: PublisherEnqueueMeta): string | null {
    if (this.seenDedupKeys.has(intent.dedup_key)) {
      this.logger.debug('pipedrive intent deduped', { dedup_key: intent.dedup_key })
      return null
    }
    this.seenDedupKeys.add(intent.dedup_key)
    let rowId: string | null = null
    if (this.store) {
      const endpoint = intent.kind === 'note' ? '/notes' : '/activities'
      rowId = this.store.insertPending({
        scenario: meta.scenario,
        deal_id: meta.deal_id,
        pasta: meta.pasta,
        phone_normalized: meta.phone_normalized,
        job_id: meta.job_id,
        pipedrive_endpoint: endpoint,
        pipedrive_payload_json: JSON.stringify(intent.payload),
        manual: meta.manual,
        triggered_by: meta.triggered_by,
      })
    }
    this.queue.push({ intent, rowId })
    this.kickDrain()
    return rowId
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
        const r = await this.client.dispatch(next.intent)
        if (this.store && next.rowId) {
          // Persist the freshly-minted Pipedrive entity id (`data.id` from
          // the response) when present — required so future repairs / updates
          // can target the row directly without re-walking the deal's
          // activity list. `responseId` is undefined for legacy callers and
          // null when the response body could not be parsed; both map to the
          // store's "leave as-is" path via COALESCE.
          this.store.updateResult(next.rowId, {
            status: r.ok ? 'success' : 'failed',
            pipedrive_response_id: r.ok ? (r.responseId ?? null) : null,
            http_status: r.status,
            error_msg: r.ok ? null : (r.error ?? null),
            attempts: r.attempts,
          })
        }
        if (!r.ok) {
          this.logger.warn('pipedrive dispatch returned ok:false', {
            kind: next.intent.kind,
            dedup_key: next.intent.dedup_key,
            attempts: r.attempts,
            status: r.status,
            error: r.error,
          })
        } else {
          this.logger.debug('pipedrive dispatch ok', {
            kind: next.intent.kind,
            dedup_key: next.intent.dedup_key,
            attempts: r.attempts,
          })
        }
      } catch (e) {
        // Defense-in-depth: client is supposed to swallow errors, but we
        // never let a renegade exception kill the drain loop.
        const msg = e instanceof Error ? e.message : String(e)
        if (this.store && next.rowId) {
          this.store.updateResult(next.rowId, {
            status: 'failed',
            error_msg: msg,
            attempts: 1,
          })
        }
        this.logger.error('pipedrive dispatch threw (unexpected)', {
          dedup_key: next.intent.dedup_key,
          error: msg,
        })
      }
    }
  }
}
