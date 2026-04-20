import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { EventRecorder } from './event-recorder.js'
import { MessageQueue } from '../queue/index.js'

describe('EventRecorder', () => {
  let db: Database.Database
  let recorder: EventRecorder

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    // initialize() creates the message_events table
    const queue = new MessageQueue(db)
    queue.initialize()
    recorder = new EventRecorder(db)
  })

  it('records event with metadata', () => {
    recorder.record('msg-1', 'strategy_selected', { method: 'prefill', appPackage: 'com.whatsapp' })

    const trace = recorder.getTrace('msg-1')
    expect(trace).toHaveLength(1)
    expect(trace[0].event).toBe('strategy_selected')
    expect(trace[0].metadata).toEqual({ method: 'prefill', appPackage: 'com.whatsapp' })
    expect(trace[0].createdAt).toBeDefined()
  })

  it('records event without metadata', () => {
    recorder.record('msg-2', 'send_tapped')

    const trace = recorder.getTrace('msg-2')
    expect(trace).toHaveLength(1)
    expect(trace[0].event).toBe('send_tapped')
    expect(trace[0].metadata).toBeNull()
  })

  it('getTrace returns events in chronological order', () => {
    recorder.record('msg-3', 'screen_ready', { wakeSent: true })
    recorder.record('msg-3', 'clean_state', { forceStoppedPackage: 'com.whatsapp' })
    recorder.record('msg-3', 'contact_resolved', { registered: false, phone: '91938235' })
    recorder.record('msg-3', 'chat_opened', { method: 'prefill' })
    recorder.record('msg-3', 'send_tapped', {})

    const trace = recorder.getTrace('msg-3')
    expect(trace).toHaveLength(5)
    expect(trace.map(e => e.event)).toEqual([
      'screen_ready',
      'clean_state',
      'contact_resolved',
      'chat_opened',
      'send_tapped',
    ])
  })

  it('getTrace returns empty array for unknown message', () => {
    const trace = recorder.getTrace('nonexistent-msg')
    expect(trace).toEqual([])
  })

  it('handles concurrent inserts for same message', () => {
    // Simulate rapid sequential inserts (SQLite serializes writes but should not lose data)
    for (let i = 0; i < 50; i++) {
      recorder.record('msg-concurrent', `event_${i}`, { index: i })
    }

    const trace = recorder.getTrace('msg-concurrent')
    expect(trace).toHaveLength(50)
    // Verify order preserved (AUTOINCREMENT id guarantees insert order)
    for (let i = 0; i < 50; i++) {
      expect(trace[i].event).toBe(`event_${i}`)
      expect(trace[i].metadata).toEqual({ index: i })
    }
  })
})
