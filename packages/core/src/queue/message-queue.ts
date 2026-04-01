import type Database from 'better-sqlite3'
import type { EnqueueParams, Message, MessageStatus } from './types.js'

export class MessageQueue {
  constructor(private db: Database.Database) {}

  initialize(): void {
    throw new Error('Not implemented')
  }

  enqueue(_params: EnqueueParams): Message {
    throw new Error('Not implemented')
  }

  dequeue(_deviceSerial: string): Message | null {
    throw new Error('Not implemented')
  }

  updateStatus(_id: string, _status: MessageStatus): Message {
    throw new Error('Not implemented')
  }

  cleanStaleLocks(): number {
    throw new Error('Not implemented')
  }

  getById(_id: string): Message | null {
    throw new Error('Not implemented')
  }
}
