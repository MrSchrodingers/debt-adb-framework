import pg from 'pg'
import type { ProvConsultaRow, DealKey, PrecheckScanParams } from './types.js'

/**
 * Thin typed wrapper around the Pipeboard pg pool.
 *
 * Isolation: owns its own `pg.Pool`, never touches Dispatch SQLite. Writes are
 * idempotent (ON CONFLICT DO NOTHING for invalidos).
 */
export class PipeboardPg {
  private pool: pg.Pool

  constructor(connectionString: string, max = 4) {
    this.pool = new pg.Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      application_name: 'dispatch-adb-precheck',
    })
  }

  async healthcheck(): Promise<{ ok: true; server_time: string } | { ok: false; error: string }> {
    try {
      const { rows } = await this.pool.query<{ now: string }>('SELECT now() AS now')
      return { ok: true, server_time: rows[0]!.now }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  /** Count deals available to scan given the filter. */
  async countPool(params: PrecheckScanParams): Promise<number> {
    const where = this.buildWhere(params)
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tenant_adb.prov_consultas ${where.sql}`,
      where.args,
    )
    return Number(rows[0]?.n ?? 0)
  }

  /**
   * Stream deals page by page. Uses keyset pagination on (pasta, deal_id,
   * contato_tipo, contato_id) to avoid OFFSET scans on large pools.
   */
  async *iterateDeals(
    params: PrecheckScanParams,
    pageSize = 200,
  ): AsyncGenerator<ProvConsultaRow[], void, void> {
    let after: DealKey | null = null
    const hardLimit = params.limit ?? Number.MAX_SAFE_INTEGER
    let emitted = 0

    while (emitted < hardLimit) {
      const fetch = Math.min(pageSize, hardLimit - emitted)
      const where = this.buildWhere(params, after)
      const sql = `
        SELECT pasta, deal_id, contato_tipo, contato_id, contato_nome, contato_relacao,
               stage_nome, pipeline_nome,
               whatsapp_hot, telefone_hot_1, telefone_hot_2,
               telefone_1, telefone_2, telefone_3, telefone_4, telefone_5, telefone_6,
               localizado, telefone_localizado
        FROM tenant_adb.prov_consultas
        ${where.sql}
        ORDER BY pasta, deal_id, contato_tipo, contato_id
        LIMIT $${where.args.length + 1}
      `
      const { rows } = await this.pool.query<ProvConsultaRow>(sql, [...where.args, fetch])
      if (rows.length === 0) return
      yield rows
      emitted += rows.length
      const last = rows[rows.length - 1]!
      after = {
        pasta: last.pasta,
        deal_id: last.deal_id,
        contato_tipo: last.contato_tipo,
        contato_id: last.contato_id,
      }
      if (rows.length < fetch) return
    }
  }

  /** Insert invalid phones for a deal. PK dedupes, so safe to re-run. */
  async writeInvalid(key: DealKey, motivo: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO tenant_adb.prov_invalidos (pasta, deal_id, contato_tipo, contato_id, motivo)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pasta, deal_id, contato_tipo, contato_id, motivo) DO NOTHING`,
      [key.pasta, key.deal_id, key.contato_tipo, key.contato_id, motivo],
    )
    return rowCount ?? 0
  }

  /** Mark deal as located with the first valid phone found. */
  async writeLocalizado(key: DealKey, phone: string, source: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenant_adb.prov_consultas
         SET localizado = true,
             telefone_localizado = $5,
             encontrado_por = $6,
             encontrado_em = now()
       WHERE pasta = $1 AND deal_id = $2 AND contato_tipo = $3 AND contato_id = $4
         AND (localizado IS DISTINCT FROM true OR telefone_localizado IS DISTINCT FROM $5)`,
      [key.pasta, key.deal_id, key.contato_tipo, key.contato_id, phone, source],
    )
  }

  private buildWhere(
    params: PrecheckScanParams,
    after?: DealKey | null,
  ): { sql: string; args: unknown[] } {
    const conds: string[] = []
    const args: unknown[] = []
    if (params.pasta_prefix) {
      args.push(`${params.pasta_prefix}%`)
      conds.push(`pasta LIKE $${args.length}`)
    }
    if (params.pipeline_nome) {
      args.push(params.pipeline_nome)
      conds.push(`pipeline_nome = $${args.length}`)
    }
    if (after) {
      args.push(after.pasta, after.deal_id, after.contato_tipo, after.contato_id)
      const n = args.length
      conds.push(
        `(pasta, deal_id, contato_tipo, contato_id) > ($${n - 3}, $${n - 2}, $${n - 1}, $${n})`,
      )
    }
    return conds.length ? { sql: `WHERE ${conds.join(' AND ')}`, args } : { sql: '', args }
  }
}
