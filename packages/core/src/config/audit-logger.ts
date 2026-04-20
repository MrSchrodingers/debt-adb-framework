import type Database from 'better-sqlite3'

export interface AuditEntry {
  id: number
  actor: string
  action: string
  resourceType: string
  resourceId: string | null
  beforeState: unknown
  afterState: unknown
  createdAt: string
}

export interface AuditQueryParams {
  resourceType?: string
  resourceId?: string
  action?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}

export interface AuditLogParams {
  actor?: string
  action: string
  resourceType: string
  resourceId?: string
  beforeState?: unknown
  afterState?: unknown
}

export class AuditLogger {
  private readonly insertStmt: Database.Statement

  constructor(private db: Database.Database) {
    this.insertStmt = this.db.prepare(
      'INSERT INTO audit_log (actor, action, resource_type, resource_id, before_state, after_state) VALUES (?, ?, ?, ?, ?, ?)',
    )
  }

  log(params: AuditLogParams): void {
    this.insertStmt.run(
      params.actor ?? 'api',
      params.action,
      params.resourceType,
      params.resourceId ?? null,
      params.beforeState != null ? JSON.stringify(params.beforeState) : null,
      params.afterState != null ? JSON.stringify(params.afterState) : null,
    )
  }

  query(params: AuditQueryParams = {}): { entries: AuditEntry[]; total: number } {
    const conditions: string[] = []
    const values: unknown[] = []

    if (params.resourceType) {
      conditions.push('resource_type = ?')
      values.push(params.resourceType)
    }
    if (params.resourceId) {
      conditions.push('resource_id = ?')
      values.push(params.resourceId)
    }
    if (params.action) {
      conditions.push('action = ?')
      values.push(params.action)
    }
    if (params.startDate) {
      conditions.push('created_at >= ?')
      values.push(params.startDate)
    }
    if (params.endDate) {
      conditions.push('created_at <= ?')
      values.push(params.endDate)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = params.limit ?? 50
    const offset = params.offset ?? 0

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM audit_log ${where}`,
    ).get(...values) as { cnt: number }

    const rows = this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...values, limit, offset) as Array<{
      id: number
      actor: string
      action: string
      resource_type: string
      resource_id: string | null
      before_state: string | null
      after_state: string | null
      created_at: string
    }>

    return {
      entries: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        beforeState: r.before_state ? JSON.parse(r.before_state) : null,
        afterState: r.after_state ? JSON.parse(r.after_state) : null,
        createdAt: r.created_at,
      })),
      total: countRow.cnt,
    }
  }
}
