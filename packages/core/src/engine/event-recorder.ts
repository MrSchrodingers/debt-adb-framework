import type Database from 'better-sqlite3'

export class EventRecorder {
  constructor(private db: Database.Database) {}

  record(messageId: string, event: string, metadata?: Record<string, unknown>): void {
    this.db.prepare(
      'INSERT INTO message_events (message_id, event, metadata) VALUES (?, ?, ?)',
    ).run(messageId, event, metadata ? JSON.stringify(metadata) : null)
  }

  getTrace(messageId: string): Array<{ event: string; metadata: unknown; createdAt: string }> {
    const rows = this.db.prepare(
      'SELECT event, metadata, created_at FROM message_events WHERE message_id = ? ORDER BY id ASC',
    ).all(messageId) as Array<{ event: string; metadata: string | null; created_at: string }>
    return rows.map(r => ({
      event: r.event,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
      createdAt: r.created_at,
    }))
  }
}
