import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { LeadPuller } from './lead-puller.js'
import { TenantPipedriveClient, type PipedriveDeal } from '../pipedrive/tenant-pipedrive-client.js'
import { initSdrSchema } from '../db/migrations.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'

function makeClient(deals: PipedriveDeal[]) {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ data: deals }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  return new TenantPipedriveClient({
    domain: 'oralsin-xyz',
    token: 't',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ratePerSec: 1000,
    burst: 1000,
    wait: () => Promise.resolve(),
  })
}

function tenant(): SdrTenantConfig {
  return {
    name: 'oralsin-sdr',
    label: 'Oralsin',
    pipedrive: {
      domain: 'oralsin-xyz',
      api_token_env: 'PIPEDRIVE_TOKEN_ORALSIN_SDR',
      pull: { stage_id: 5, poll_interval_minutes: 15, batch_size: 50, max_age_days: 30, phone_field_key: 'phone' },
      writeback: {
        stage_qualified_id: 6,
        stage_disqualified_id: 7,
        stage_needs_human_id: 8,
        stage_no_response_id: 9,
        activity_subject_template: 'SDR: {{outcome}}',
      },
    },
    devices: ['devA'],
    senders: [{ phone: '554399000001', app: 'com.whatsapp' }],
    sequence_id: 'oralsin-cold-v1',
    throttle: {
      per_sender_daily_max: 40,
      min_interval_minutes: 8,
      operating_hours: { start: '09:00', end: '18:00' },
      tz: 'America/Sao_Paulo',
    },
    identity_gate: { enabled: true, nudge_after_hours: 48, abort_after_hours: 96 },
  }
}

const fakeBlacklist = {
  isBlacklisted: vi.fn(() => false),
}

describe('LeadPuller.pullTenant', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initSdrSchema(db)
    fakeBlacklist.isBlacklisted.mockReturnValue(false)
  })

  afterEach(() => db.close())

  it('inserts new deals into sdr_lead_queue', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    const client = makeClient([
      { id: 100, title: 'A', stage_id: 5, phone: '+55 43 99193-8235', person_id: { name: 'João' } },
      { id: 101, title: 'B', stage_id: 5, phone: '4399193 8236', person_id: { name: 'Maria' } },
    ])
    const r = await puller.pullTenant(tenant(), client)
    expect(r.examined).toBe(2)
    expect(r.inserted).toBe(2)
    expect(r.skipped_existing).toBe(0)
    const rows = db.prepare("SELECT contact_phone, state FROM sdr_lead_queue").all() as Array<{ contact_phone: string; state: string }>
    expect(rows.every((row) => row.state === 'pulled')).toBe(true)
    expect(rows.map((r) => r.contact_phone).sort()).toEqual(['5543991938235', '5543991938236'])
  })

  it('is idempotent on a repeat pull of the same deal', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    const deals: PipedriveDeal[] = [{ id: 100, title: 'A', stage_id: 5, phone: '5543991938235', person_id: { name: 'João' } }]
    await puller.pullTenant(tenant(), makeClient(deals))
    const r2 = await puller.pullTenant(tenant(), makeClient(deals))
    expect(r2.examined).toBe(1)
    expect(r2.inserted).toBe(0)
    expect(r2.skipped_existing).toBe(1)
  })

  it('skips blacklisted phones', async () => {
    fakeBlacklist.isBlacklisted.mockImplementation((phone: string) => phone === '5543991938235')
    const puller = new LeadPuller(db, fakeBlacklist)
    const client = makeClient([
      { id: 100, title: 'A', stage_id: 5, phone: '5543991938235', person_id: { name: 'João' } },
      { id: 101, title: 'B', stage_id: 5, phone: '5543991938236', person_id: { name: 'Maria' } },
    ])
    const r = await puller.pullTenant(tenant(), client)
    expect(r.inserted).toBe(1)
    expect(r.skipped_blacklisted).toBe(1)
  })

  it('records extract failures without aborting the batch', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    const client = makeClient([
      { id: 100, title: 'A', stage_id: 5, phone: 'not-a-phone', person_id: { name: 'João' } },
      { id: 101, title: 'B', stage_id: 5, phone: '5543991938236', person_id: { name: 'Maria' } },
    ])
    const r = await puller.pullTenant(tenant(), client)
    expect(r.examined).toBe(2)
    expect(r.inserted).toBe(1)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].reason).toBe('invalid_phone')
  })

  it('passes the configured phone_field_key to the extractor', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    const t = tenant()
    t.pipedrive.pull.phone_field_key = 'whatsapp_field'
    const client = makeClient([
      {
        id: 100,
        title: 'A',
        stage_id: 5,
        whatsapp_field: '5543991938235',
        phone: 'IGNORED',
        person_id: { name: 'João' },
      },
    ])
    const r = await puller.pullTenant(t, client)
    expect(r.inserted).toBe(1)
    const row = db.prepare("SELECT contact_phone FROM sdr_lead_queue").get() as { contact_phone: string }
    expect(row.contact_phone).toBe('5543991938235')
  })

  it('stores Pipedrive context as JSON', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    await puller.pullTenant(tenant(), makeClient([
      { id: 100, title: 'Some title', stage_id: 5, phone: '5543991938235', person_id: { name: 'João' } },
    ]))
    const row = db.prepare("SELECT pipedrive_context_json FROM sdr_lead_queue").get() as { pipedrive_context_json: string }
    const ctx = JSON.parse(row.pipedrive_context_json)
    expect(ctx.title).toBe('Some title')
    expect(ctx.stage_id).toBe(5)
  })

  it('reports zero inserts when Pipedrive returns no deals', async () => {
    const puller = new LeadPuller(db, fakeBlacklist)
    const client = makeClient([])
    const r = await puller.pullTenant(tenant(), client)
    expect(r.examined).toBe(0)
    expect(r.inserted).toBe(0)
  })
})
