import type { PluginLogger } from '../types.js'
import type { PipedriveClient } from './pipedrive-client.js'
import {
  buildDealAllFailActivity,
  buildPastaSummaryNote,
} from './pipedrive-formatter.js'
import type { PipedriveActivityStore } from './pipedrive-activity-store.js'
import type {
  PipedriveDealAllFailIntent,
  PipedriveOutgoingIntent,
  PipedrivePastaSummaryIntent,
} from './types.js'
import type { PastaLockManager, LockHandle } from '../../locks/pasta-lock-manager.js'

/**
 * Async dispatcher between scanner and PipedriveClient.
 *
 * Responsibilities:
 *   1. Scanner calls `enqueueXxx(...)` — synchronous, fire-and-forget.
 *   2. Publisher dedups by `dedup_key` (combination of scenario + deal +
 *      phone + job_id). Re-enqueueing the same intent within the publisher's
 *      lifetime is a no-op. Dedup is BYPASSED for PUT operations (each scan
 *      should update the note with fresh data without the idempotency window
 *      blocking the write).
 *   3. Optionally persists every intent in `pipedrive_activities` BEFORE the
 *      HTTP call (status='retrying', attempts=1) and updates the row AFTER
 *      with the dispatch result. The store is optional so existing tests can
 *      continue to construct a publisher without touching SQLite.
 *   4. A single drain loop picks intents off the queue and feeds them to
 *      `client.dispatch(...)` one at a time, respecting the client's own
 *      token-bucket. Drain is initiated lazily by `enqueue*` and re-armed
 *      whenever new intents arrive.
 *   5. For `pasta_summary` notes, the drain loop holds a per-pasta lock from
 *      `PastaLockManager` to prevent concurrent publishes for the same pasta
 *      (e.g. two scans running in parallel). If the lock cannot be acquired
 *      within 15 s, the item is re-queued and retried after 30 s.
 *   6. When a PUT returns 404 (the Pipedrive note was deleted upstream), the
 *      publisher orphan-marks the previous store row, inserts a new POST row,
 *      and re-processes the item as a fresh note creation.
 *
 * Lifetime: tied to the AdbPrecheckPlugin. `flush()` waits for the queue to
 * drain — useful in tests and during graceful shutdown.
 */
interface PendingIntent {
  intent: PipedriveOutgoingIntent
  /** SQLite row id created via store.insertPending — null when no store. */
  rowId: string | null
  /** Metadata carried through so the drain loop can act on the scenario. */
  meta: PublisherEnqueueMeta
}

export interface PublisherEnqueueMeta {
  /**
   * `phone_fail` is preserved here purely for type-compat with historical
   * `pipedrive_activities` rows (the store still types it). No active
   * publisher method emits it — it was retired on 2026-04-29.
   */
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
    private readonly idempotencyWindowMs: number = 30 * 24 * 60 * 60_000,
    private readonly pastaLocks?: PastaLockManager,
    /**
     * T23: tenant ownership for cross-tenant dedup. Defaults to 'adb' so
     * existing tests + the legacy single-tenant boot path keep working
     * byte-for-byte. The plugin builds one publisher per tenant in T23 so
     * the in-memory `seenDedupKeys` Set is naturally tenant-scoped.
     */
    private readonly tenant: 'adb' | 'sicoob' | 'oralsin' = 'adb',
    /**
     * T23: human-friendly tenant label, forwarded to the pasta_summary header
     * via `buildPastaSummaryNote`. Defaults to undefined so the adb formatter
     * output stays identical to pre-T23 (no header prefix).
     */
    private readonly tenantLabel?: string,
  ) {}

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
    const builtIntent = buildPastaSummaryNote(intent, this.companyDomain, {
      tenantLabel: this.tenantLabel,
    })
    // Look up the current Pipedrive note for this pasta. If one exists, switch
    // to PUT instead of creating a duplicate note. Only applies when the store
    // is available (test instantiations without a store fall back to POST).
    if (this.store && intent.pasta) {
      const target = this.store.findCurrentPastaNote(intent.pasta)
      if (target && builtIntent.kind === 'note') {
        builtIntent.update_target_id = String(target.pipedrive_response_id)
      }
    }
    return this.add(builtIntent, {
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
    const isUpdate = intent.kind === 'note' && Boolean(intent.update_target_id)

    if (!isUpdate) {
      // Existing dedup logic — POST path only. PUT operations are intentionally
      // bypassed: each scan should be free to update the note with fresh data
      // without the 30-day idempotency window blocking the write.
      if (this.seenDedupKeys.has(intent.dedup_key)) {
        this.logger.debug('pipedrive intent deduped (in-memory)', { dedup_key: intent.dedup_key })
        return null
      }
      if (this.store) {
        const sinceIso = new Date(Date.now() - this.idempotencyWindowMs).toISOString()
        const existing = this.store.hasRecentSuccess({
          scenario: meta.scenario,
          deal_id: meta.deal_id,
          pasta: meta.pasta ?? null,
          phone_normalized: meta.phone_normalized ?? null,
          sinceIso,
        })
        if (existing) {
          this.logger.debug('pipedrive intent deduped (store)', {
            dedup_key: intent.dedup_key,
            scenario: meta.scenario,
            deal_id: meta.deal_id,
            pasta: meta.pasta ?? null,
          })
          this.seenDedupKeys.add(intent.dedup_key)
          return null
        }
      }
      this.seenDedupKeys.add(intent.dedup_key)
    }

    let rowId: string | null = null
    if (this.store) {
      const endpoint = intent.kind === 'note' ? '/notes' : '/activities'
      const revisesRowId =
        isUpdate && meta.pasta && intent.kind === 'note' && intent.update_target_id
          ? this.findRevisesRowId(intent.update_target_id, meta.pasta)
          : undefined
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
        revises_row_id: revisesRowId,
        http_verb: isUpdate ? 'PUT' : 'POST',
        tenant: this.tenant,
        dedup_key: intent.dedup_key,
      })
    }
    this.queue.push({ intent, rowId, meta })
    this.kickDrain()
    return rowId
  }

  private findRevisesRowId(pipedriveId: string, pasta: string): string | undefined {
    if (!this.store) return undefined
    const target = this.store.findCurrentPastaNote(pasta)
    return target && String(target.pipedrive_response_id) === pipedriveId
      ? target.row_id
      : undefined
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
      let lockHandle: LockHandle | null = null

      // Acquire the per-pasta lock for note publishes. Skip when no lock manager
      // is wired (test instantiations).
      if (this.pastaLocks && next.meta.scenario === 'pasta_summary' && next.meta.pasta) {
        lockHandle = await this.pastaLocks.acquireWithWait(
          `note.pasta_summary:${next.meta.pasta}`,
          60_000,
          {
            timeoutMs: 15_000,
            pollMs: 5_000,
            context: { job_id: next.meta.job_id, pasta: next.meta.pasta },
          },
        )
        if (!lockHandle) {
          // Could not acquire the lock within 15s — re-enqueue at the back and
          // sleep before the next attempt to avoid a tight retry loop.
          this.logger.warn('pasta_summary lock unavailable, requeuing', {
            pasta: next.meta.pasta,
            job_id: next.meta.job_id,
          })
          this.queue.push(next)
          await new Promise((r) => setTimeout(r, 30_000))
          continue
        }
      }

      try {
        const r = await this.client.dispatch(next.intent)

        // 404 on PUT → orphan-mark the previous row and re-enqueue as POST.
        if (
          !r.ok &&
          r.status === 404 &&
          next.intent.kind === 'note' &&
          next.intent.update_target_id
        ) {
          this.logger.warn('pipedrive note deleted upstream, recreating', {
            pasta: next.meta.pasta,
            prior_id: next.intent.update_target_id,
          })
          if (this.store && next.rowId) {
            this.store.updateResult(next.rowId, {
              status: 'failed',
              http_status: 404,
              error_msg: r.error ?? 'http_404',
              attempts: r.attempts,
            })
            const orphanRowId = next.meta.pasta
              ? this.findRevisesRowId(next.intent.update_target_id, next.meta.pasta)
              : undefined
            if (orphanRowId) this.store.markOrphaned(orphanRowId, 'PUT returned 404')
          }
          // Build a fresh POST intent (drop update_target_id).
          const fallbackIntent = { ...next.intent, update_target_id: undefined }
          // Release the lock before unshifting so the next iteration can re-acquire.
          lockHandle?.release()
          lockHandle = null
          // Insert a new store row for the fallback POST (so audit history is complete).
          let fallbackRowId: string | null = null
          if (this.store) {
            fallbackRowId = this.store.insertPending({
              scenario: next.meta.scenario,
              deal_id: next.meta.deal_id,
              pasta: next.meta.pasta,
              phone_normalized: next.meta.phone_normalized,
              job_id: next.meta.job_id,
              pipedrive_endpoint: '/notes',
              pipedrive_payload_json: JSON.stringify(fallbackIntent.payload),
              manual: next.meta.manual,
              triggered_by: next.meta.triggered_by,
              http_verb: 'POST',
              // No revises_row_id — fresh creation, not a revision of the orphaned row.
              tenant: this.tenant,
              // T23: fallback recreates the same logical record under a fresh
              // POST — append `:recreate` to the dedup_key so it does not
              // collide with the orphaned PUT row under the partial UNIQUE
              // INDEX (tenant, dedup_key).
              dedup_key: `${fallbackIntent.dedup_key}:recreate`,
            })
          }
          // Unshift so it is the very next item processed.
          this.queue.unshift({ intent: fallbackIntent, rowId: fallbackRowId, meta: next.meta })
          continue
        }

        // Normal success / non-404 failure path.
        if (this.store && next.rowId) {
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
      } finally {
        lockHandle?.release()
      }
    }
  }
}
