import pg from 'pg'
import type { ProvConsultaRow, DealKey, PrecheckScanParams } from './types.js'

/**
 * Thin typed wrapper around the Pipeboard pg pool.
 *
 * Isolation: owns its own `pg.Pool`, never touches Dispatch SQLite. Writes are
 * idempotent (ON CONFLICT DO NOTHING for invalidos).
 */
/**
 * Columns in tenant_adb.prov_consultas that can hold a phone. Kept in sync
 * with PHONE_COLUMNS in phone-extractor.ts. Used as a whitelist for the
 * `clearInvalidPhone` UPDATE — prevents SQL injection via dynamic column
 * interpolation.
 */
const PHONE_COLUMNS = [
  'whatsapp_hot',
  'telefone_hot_1',
  'telefone_hot_2',
  'telefone_1',
  'telefone_2',
  'telefone_3',
  'telefone_4',
  'telefone_5',
  'telefone_6',
] as const
export type PhoneColumn = (typeof PHONE_COLUMNS)[number]

export class PipeboardPg {
  static readonly PHONE_COLUMNS = PHONE_COLUMNS

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

  /**
   * Clear every phone column in prov_consultas whose current value equals
   * `rawPhone` for the given deal. Handles the case where the same number
   * was duplicated across multiple columns — all matching columns are
   * NULLed in one UPDATE.
   *
   * Safety:
   *   - Columns are emitted from the `PHONE_COLUMNS` whitelist, so the
   *     dynamic SQL composition is not user-controlled.
   *   - The `= $5` guard makes this idempotent: re-running has no effect
   *     once the column is already NULL or changed.
   *
   * Returns the total number of column-cells nulled (can be 0 if nothing
   * matched, up to N where N = number of columns holding the duplicate).
   */
  async clearInvalidPhone(key: DealKey, rawPhone: string): Promise<number> {
    const setClauses = PHONE_COLUMNS
      .map((col) => `${col} = CASE WHEN ${col} = $5 THEN NULL ELSE ${col} END`)
      .join(', ')
    const whereAny = PHONE_COLUMNS.map((col) => `${col} = $5`).join(' OR ')
    const sql = `
      UPDATE tenant_adb.prov_consultas
         SET ${setClauses}
       WHERE pasta = $1 AND deal_id = $2 AND contato_tipo = $3 AND contato_id = $4
         AND (${whereAny})
    `
    const { rowCount } = await this.pool.query(sql, [
      key.pasta,
      key.deal_id,
      key.contato_tipo,
      key.contato_id,
      rawPhone,
    ])
    return rowCount ?? 0
  }

  /**
   * Also clear `telefone_localizado` if it currently holds `rawPhone` — a
   * prior run may have surfaced this number as "localizado" before we
   * re-checked and found it invalid. Keeps prov_consultas internally
   * consistent. No-op if the current localizado value differs.
   */
  async clearLocalizadoIfMatches(key: DealKey, rawPhone: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE tenant_adb.prov_consultas
          SET telefone_localizado = NULL,
              localizado = false
        WHERE pasta = $1 AND deal_id = $2 AND contato_tipo = $3 AND contato_id = $4
          AND telefone_localizado = $5`,
      [key.pasta, key.deal_id, key.contato_tipo, key.contato_id, rawPhone],
    )
    return rowCount ?? 0
  }

  /**
   * Record (or refresh) a per-phone invalid entry in prov_telefones_invalidos.
   *
   * Acts as the authoritative blocklist consumed by the Pipeboard ETL: any
   * phone present here with `revalidado_em IS NULL` is filtered out of
   * prov_consultas on every sync.
   *
   * Idempotent: re-calling with the same (key, telefone) refreshes the
   * timestamp and clears any prior `revalidado_em` (the most recent decision
   * wins). The composite PK (pasta, deal_id, contato_tipo, contato_id,
   * telefone) prevents duplicates.
   *
   * `telefone` MUST be the normalized E.164 form (55DD9XXXXXXXX), matching
   * what the ETL stores and compares against.
   */
  async recordInvalidPhone(
    key: DealKey,
    record: {
      telefone: string
      motivo: string
      colunaOrigem: string | null
      invalidadoPor: string
      jobId: string | null
      confidence: number | null
    },
  ): Promise<void> {
    const sql = `
      INSERT INTO tenant_adb.prov_telefones_invalidos (
        pasta, deal_id, contato_tipo, contato_id, telefone,
        motivo, coluna_origem, invalidado_por, job_id, confidence
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (pasta, deal_id, contato_tipo, contato_id, telefone)
      DO UPDATE SET
        motivo = EXCLUDED.motivo,
        coluna_origem = EXCLUDED.coluna_origem,
        invalidado_em = now(),
        invalidado_por = EXCLUDED.invalidado_por,
        job_id = EXCLUDED.job_id,
        confidence = EXCLUDED.confidence,
        revalidado_em = NULL,
        revalidado_por = NULL
    `
    await this.pool.query(sql, [
      key.pasta,
      key.deal_id,
      key.contato_tipo,
      key.contato_id,
      record.telefone,
      record.motivo,
      record.colunaOrigem,
      record.invalidadoPor,
      record.jobId,
      record.confidence,
    ])
  }

  /**
   * Atomically archive a prov_consultas row to prov_consultas_snapshot when
   * (and only when) every phone column is NULL.
   *
   * Single CTE → both DELETE and INSERT happen in one statement, so partial
   * states are impossible. ON CONFLICT keeps the operation idempotent: if the
   * key was already snapshotted (e.g. by the ETL or a previous run) the new
   * insert is dropped.
   *
   * Returns true when a row was archived, false when the predicate did not
   * match (the deal still has at least one phone).
   */
  async archiveDealIfEmpty(key: DealKey, motivo: string): Promise<boolean> {
    const allNull = PHONE_COLUMNS.map((c) => `${c} IS NULL`).join(' AND ')
    const sql = `
      WITH archived AS (
        DELETE FROM tenant_adb.prov_consultas
         WHERE pasta = $1 AND deal_id = $2 AND contato_tipo = $3 AND contato_id = $4
           AND ${allNull}
        RETURNING *
      )
      INSERT INTO tenant_adb.prov_consultas_snapshot (
        pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
        add_time, update_time, stage_change_time, local_do_acidente,
        data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
        telefone_localizado, encontrado_por, encontrado_em, contato_nome,
        contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
        telefone_5, telefone_6, whatsapp_hot, telefone_hot_1, telefone_hot_2,
        stage_id, pipeline_id, removido_em, motivo
      )
      SELECT
        pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
        add_time, update_time, stage_change_time, local_do_acidente,
        data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
        telefone_localizado, encontrado_por, encontrado_em, contato_nome,
        contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
        telefone_5, telefone_6, whatsapp_hot, telefone_hot_1, telefone_hot_2,
        stage_id, pipeline_id, now(), $5
      FROM archived
      ON CONFLICT (pasta, deal_id, contato_tipo, contato_id) DO NOTHING
    `
    const { rowCount } = await this.pool.query(sql, [
      key.pasta,
      key.deal_id,
      key.contato_tipo,
      key.contato_id,
      motivo,
    ])
    return (rowCount ?? 0) > 0
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
