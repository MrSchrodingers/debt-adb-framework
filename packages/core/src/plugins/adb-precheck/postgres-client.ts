import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { ProvConsultaRow, DealKey, PrecheckScanParams } from './types.js'

function synthRequestId(): string {
  return `sql-${randomUUID()}`
}
import {
  PHONE_COLUMNS,
  type IPipeboardClient,
  type HealthcheckResult,
  type InvalidPhoneRecord,
  type DealInvalidationRequest,
  type DealInvalidationResponse,
  type DealLocalizationRequest,
  type DealLocalizationResponse,
  type AppliedPhone,
} from './pipeboard-client.js'

export { PHONE_COLUMNS } from './pipeboard-client.js'
export type { PhoneColumn } from './pipeboard-client.js'

/**
 * SQL implementation of {@link IPipeboardClient} backed by a `pg.Pool`
 * directly connected to the Pipeboard Postgres (historically over an
 * SSH tunnel — see ADR 0002 for the REST migration). Writes are
 * idempotent (ON CONFLICT, CASE WHEN guards) so retries and replays
 * are safe.
 *
 * Selected by `PLUGIN_ADB_PRECHECK_BACKEND=sql`. The REST counterpart
 * is `PipeboardRest` in `pipeboard-rest.ts`.
 */
export class PipeboardPg implements IPipeboardClient {
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

  async healthcheck(): Promise<HealthcheckResult> {
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
   *
   * NOTE — scanner-driven limit:
   *   `params.limit` is **NOT** applied as an SQL ceiling here. The scanner
   *   enforces it AFTER the freshness filter (`recheck_after_days`), so
   *   re-running a scan with `{ limit: 10, recheck_after_days: 7 }` in a
   *   pool where the first 10 rows are already fresh will correctly fetch
   *   pages until 10 *new* deals have been processed, instead of returning
   *   10 rows that the scanner immediately short-circuits.
   *
   *   Each page is sized by `pageSize` and the iterator stops only when PG
   *   yields fewer rows than requested — meaning the keyset has reached the
   *   end of the pool. The scanner is responsible for breaking out of its
   *   loop once `params.limit` deals have been actually processed.
   */
  async *iterateDeals(
    params: PrecheckScanParams,
    pageSize = 200,
  ): AsyncGenerator<ProvConsultaRow[], void, void> {
    let after: DealKey | null = null

    // eslint-disable-next-line no-constant-condition
    while (true) {
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
      const { rows } = await this.pool.query<ProvConsultaRow>(sql, [...where.args, pageSize])
      if (rows.length === 0) return
      yield rows
      const last = rows[rows.length - 1]!
      after = {
        pasta: last.pasta,
        deal_id: last.deal_id,
        contato_tipo: last.contato_tipo,
        contato_id: last.contato_id,
      }
      if (rows.length < pageSize) return
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
  async recordInvalidPhone(key: DealKey, record: InvalidPhoneRecord): Promise<void> {
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

  /**
   * Batch shim that mirrors the REST `phones/invalidate` semantics on
   * top of the legacy per-phone methods. Not transactional across
   * phones — only kept to let the scanner uniformly call the batch
   * interface regardless of backend.
   *
   * Returned `request_id` is a synthetic UUID (no audit log lives in
   * SQL backend).
   */
  async applyDealInvalidation(
    key: DealKey,
    payload: DealInvalidationRequest,
  ): Promise<DealInvalidationResponse> {
    const applied: AppliedPhone[] = []
    const clearedColumns = new Set<string>()
    for (const phone of payload.phones) {
      await this.recordInvalidPhone(key, {
        telefone: phone.telefone,
        motivo: payload.motivo,
        colunaOrigem: phone.colunaOrigem,
        invalidadoPor: payload.fonte,
        jobId: payload.jobId,
        confidence: phone.confidence,
      })
      const cleared = await this.clearInvalidPhone(key, phone.telefone)
      if (cleared > 0 && phone.colunaOrigem) clearedColumns.add(phone.colunaOrigem)
      await this.clearLocalizadoIfMatches(key, phone.telefone)
      applied.push({ telefone: phone.telefone, status: 'applied' })
    }
    let archived = false
    if (payload.archiveIfEmpty) {
      archived = await this.archiveDealIfEmpty(key, 'todos_telefones_invalidos')
    }
    return {
      requestId: synthRequestId(),
      idempotent: false,
      applied,
      archived,
      clearedColumns: [...clearedColumns],
    }
  }

  /** SQL-backend shim for `applyDealLocalization`. */
  async applyDealLocalization(
    key: DealKey,
    payload: DealLocalizationRequest,
  ): Promise<DealLocalizationResponse> {
    await this.writeLocalizado(key, payload.telefone, payload.source)
    return {
      requestId: synthRequestId(),
      idempotent: false,
      applied: true,
    }
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
    if (params.excluded_keys && params.excluded_keys.length > 0) {
      // PG-side exclusion of recently-scanned deals when the set is small
      // enough to inline. Caller (scanner) is expected to gate this by the
      // 5000-key threshold to avoid blowing the parser stack — we still
      // emit the tuple list as written.
      const tupleParts: string[] = []
      for (const k of params.excluded_keys) {
        args.push(k.pasta, k.deal_id, k.contato_tipo, k.contato_id)
        const n = args.length
        tupleParts.push(`($${n - 3}, $${n - 2}, $${n - 1}, $${n})`)
      }
      conds.push(
        `(pasta, deal_id, contato_tipo, contato_id) NOT IN (${tupleParts.join(', ')})`,
      )
    }
    return conds.length ? { sql: `WHERE ${conds.join(' AND ')}`, args } : { sql: '', args }
  }
}
