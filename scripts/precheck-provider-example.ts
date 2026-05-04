/**
 * Sample TypeScript client for providers integrating with the
 * Pipeboard Precheck API. Demonstrates how to call
 * `POST /precheck/phones/invalidate` with proper idempotency,
 * batching, error handling, and response interpretation.
 *
 * Run with:
 *   tsx scripts/precheck-provider-example.ts
 *
 * Required env:
 *   PRECHECK_API_KEY    pbk_... (precheck:write scope)
 *   PRECHECK_BASE_URL   default: https://adb.debt.com.br/api/v1
 *
 * This is a STANDALONE example — not wired into Dispatch's runtime.
 * See packages/core/src/plugins/adb-precheck/pipeboard-rest.ts for
 * the production client.
 */

import { randomUUID } from 'node:crypto'

interface PhoneInput {
  telefone: string
  coluna_origem?: string | null
  confidence?: number | null
}

interface InvalidateRequest {
  fonte: 'debt_adb_provider'
  deal_id: number
  pasta: string
  contato_tipo: string
  contato_id: number
  motivo: string
  job_id?: string
  phones: PhoneInput[]
  archive_if_empty: false
}

type AppliedStatus =
  | 'applied'
  | 'duplicate_already_moved'
  | 'rejected_invalid_input'
  | 'rejected_no_match'

interface AppliedPhone {
  telefone: string
  status: AppliedStatus
  cleared_from?: string[]
}

interface InvalidateResponse {
  request_id: string
  idempotent: boolean
  applied: AppliedPhone[]
  deal_archived: boolean
  pipedrive?: { scenario?: string; workflow_id?: string }
}

class PrecheckProviderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    if (!apiKey) throw new Error('PRECHECK_API_KEY is required')
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /**
   * Invalidate one or more phones for a deal.
   *
   * Idempotency: if `idempotencyKey` is omitted, a random UUIDv4 is
   * generated. Pass an explicit key (e.g. derived from your event
   * ID) when you want safe retries — same key + same body returns
   * the original response.
   *
   * Throws on transport errors and on HTTP status >= 400. Per-phone
   * "rejections" come back inside `applied[].status` and do NOT
   * throw — inspect the array.
   */
  async invalidate(
    payload: InvalidateRequest,
    idempotencyKey: string = randomUUID(),
  ): Promise<InvalidateResponse> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/adb/precheck/phones/invalidate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      },
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new PrecheckError(res.status, text)
    }
    return (await res.json()) as InvalidateResponse
  }
}

class PrecheckError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Pipeboard precheck POST → ${status}: ${body.slice(0, 200)}`)
    this.name = 'PrecheckError'
  }
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
  get isPermanent(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403 || this.status === 409
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.PRECHECK_API_KEY
  if (!apiKey) {
    console.error('Missing PRECHECK_API_KEY env')
    process.exit(1)
  }
  const client = new PrecheckProviderClient(
    process.env.PRECHECK_BASE_URL ?? 'https://adb.debt.com.br/api/v1',
    apiKey,
  )

  // Example 1: single phone
  const single = await client.invalidate({
    fonte: 'debt_adb_provider',
    deal_id: 12345,
    pasta: 'AB-2024/12',
    contato_tipo: 'person',
    contato_id: 67890,
    motivo: 'número inexistente',
    job_id: 'provider-event-abc',
    phones: [
      { telefone: '5543991938235', coluna_origem: 'telefone_3', confidence: 0.95 },
    ],
    archive_if_empty: false,
  })
  console.log('single →', JSON.stringify(single, null, 2))

  // Example 2: batched (up to 50 per call)
  const batched = await client.invalidate({
    fonte: 'debt_adb_provider',
    deal_id: 12345,
    pasta: 'AB-2024/12',
    contato_tipo: 'person',
    contato_id: 67890,
    motivo: 'desligado',
    phones: [
      { telefone: '5543991111111', confidence: 0.9 },
      { telefone: '5543992222222', confidence: 0.9 },
    ],
    archive_if_empty: false,
  })
  for (const p of batched.applied) {
    if (p.status === 'applied') {
      console.log(`✓ ${p.telefone} blocked (cleared from ${p.cleared_from?.join(',') ?? '∅'})`)
    } else if (p.status === 'duplicate_already_moved') {
      console.log(`⟳ ${p.telefone} already in blocklist (no-op)`)
    } else {
      console.log(`✗ ${p.telefone} → ${p.status}`)
    }
  }

  // Example 3: idempotent retry (same key, same body)
  const key = randomUUID()
  const first = await client.invalidate(
    {
      fonte: 'debt_adb_provider',
      deal_id: 12345,
      pasta: 'AB-2024/12',
      contato_tipo: 'person',
      contato_id: 67890,
      motivo: 'idempotency demo',
      phones: [{ telefone: '5543993333333' }],
      archive_if_empty: false,
    },
    key,
  )
  const replay = await client.invalidate(
    {
      fonte: 'debt_adb_provider',
      deal_id: 12345,
      pasta: 'AB-2024/12',
      contato_tipo: 'person',
      contato_id: 67890,
      motivo: 'idempotency demo',
      phones: [{ telefone: '5543993333333' }],
      archive_if_empty: false,
    },
    key,
  )
  console.log('idempotent? request_id matches:', first.request_id === replay.request_id, '/ flag:', replay.idempotent)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    if (err instanceof PrecheckError) {
      console.error(
        `[${err.status}] ${err.message} | retryable=${err.isRetryable} permanent=${err.isPermanent}`,
      )
    } else {
      console.error(err)
    }
    process.exit(1)
  })
}

export { PrecheckProviderClient, PrecheckError }
export type { InvalidateRequest, InvalidateResponse, AppliedPhone, AppliedStatus, PhoneInput }
