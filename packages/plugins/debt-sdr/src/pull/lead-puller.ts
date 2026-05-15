import type Database from 'better-sqlite3'
import { ulid } from 'ulid'
import type { TenantPipedriveClient } from '../pipedrive/tenant-pipedrive-client.js'
import { extractLead, type ExtractFailure } from '../pipedrive/lead-extractor.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'

export interface PullResult {
  tenant: string
  examined: number
  inserted: number
  skipped_existing: number
  skipped_blacklisted: number
  failures: ExtractFailure[]
}

export interface BlacklistCheck {
  isBlacklisted(phone: string): boolean
}

export interface LeadPullerLogger {
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  debug?(msg: string, data?: Record<string, unknown>): void
}

/**
 * Pulls Pipedrive deals for one tenant and inserts the eligible ones
 * into `sdr_lead_queue`. Idempotent across runs via
 * `UNIQUE(tenant, pipedrive_deal_id)` — INSERT OR IGNORE swallows
 * already-seen deals, so the puller is safe to run at any cadence
 * without producing duplicates.
 *
 * Per spec §5.4 the puller is throttle-agnostic: it can run 24/7. The
 * sequencer is what respects operating_hours / daily_max — leads sit
 * in `pulled` state until the sequencer picks them up during the
 * tenant's send window.
 */
export class LeadPuller {
  constructor(
    private readonly db: Database.Database,
    private readonly blacklist: BlacklistCheck,
    private readonly logger?: LeadPullerLogger,
  ) {}

  async pullTenant(
    tenant: SdrTenantConfig,
    client: TenantPipedriveClient,
  ): Promise<PullResult> {
    const result: PullResult = {
      tenant: tenant.name,
      examined: 0,
      inserted: 0,
      skipped_existing: 0,
      skipped_blacklisted: 0,
      failures: [],
    }

    const deals = await client.getDealsByStage(tenant.pipedrive.pull.stage_id, {
      limit: tenant.pipedrive.pull.batch_size,
    })
    result.examined = deals.length

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO sdr_lead_queue
         (id, tenant, pipedrive_deal_id, contact_phone, contact_name,
          pipedrive_context_json, pulled_at, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pulled', ?, ?)`,
    )

    for (const deal of deals) {
      const ex = extractLead(deal, tenant.pipedrive.pull.phone_field_key)
      if (!ex.ok) {
        result.failures.push(ex.failure)
        this.logger?.warn?.('lead extract failed', {
          tenant: tenant.name,
          deal_id: ex.failure.deal_id,
          reason: ex.failure.reason,
        })
        continue
      }

      if (this.blacklist.isBlacklisted(ex.lead.contact_phone)) {
        result.skipped_blacklisted++
        continue
      }

      const now = new Date().toISOString()
      const r = insert.run(
        ulid(),
        tenant.name,
        ex.lead.deal_id,
        ex.lead.contact_phone,
        ex.lead.contact_name,
        JSON.stringify({ title: deal.title, stage_id: deal.stage_id }),
        now,
        now,
        now,
      )
      if (r.changes > 0) {
        result.inserted++
      } else {
        result.skipped_existing++
      }
    }

    this.logger?.info?.('lead pull complete', {
      ...result,
      failures: result.failures.length,
    })

    return result
  }
}
