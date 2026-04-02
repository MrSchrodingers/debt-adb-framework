import type Database from 'better-sqlite3'
import type { ManagedSessionRecord } from './types.js'

export class ManagedSessions {
  constructor(_db: Database.Database) {
    throw new Error('Not implemented — TDD Red')
  }

  initialize(): void {
    throw new Error('Not implemented — TDD Red')
  }

  add(_params: {
    sessionName: string
    phoneNumber: string
    deviceSerial: string | null
    profileId: number | null
    chatwootInboxId: number | null
  }): string {
    throw new Error('Not implemented — TDD Red')
  }

  get(_sessionName: string): ManagedSessionRecord | null {
    throw new Error('Not implemented — TDD Red')
  }

  listAll(): ManagedSessionRecord[] {
    throw new Error('Not implemented — TDD Red')
  }

  listManaged(): ManagedSessionRecord[] {
    throw new Error('Not implemented — TDD Red')
  }

  setManaged(_sessionName: string, _managed: boolean): void {
    throw new Error('Not implemented — TDD Red')
  }

  updateChatwootInboxId(_sessionName: string, _inboxId: number): void {
    throw new Error('Not implemented — TDD Red')
  }

  remove(_sessionName: string): void {
    throw new Error('Not implemented — TDD Red')
  }

  findByPhoneNumber(_phoneNumber: string): ManagedSessionRecord[] {
    throw new Error('Not implemented — TDD Red')
  }

  findByDeviceSerial(_deviceSerial: string): ManagedSessionRecord[] {
    throw new Error('Not implemented — TDD Red')
  }
}
