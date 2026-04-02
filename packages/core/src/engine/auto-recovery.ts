import type { CrashDetection, RecoveryResult } from './types.js'
import type { AdbShellAdapter } from '../monitor/types.js'

export class AutoRecovery {
  constructor(private adb: AdbShellAdapter) {}

  /** Detect if WhatsApp has crashed based on UI dump and process state */
  detectCrash(
    _sendButtonFound: boolean,
    _pidOutput: string,
  ): CrashDetection {
    throw new Error('Not implemented')
  }

  /** Recover WhatsApp after a crash */
  recover(
    _deviceSerial: string,
    _crashInfo: CrashDetection,
    _toNumber: string,
    _packageName?: string,
  ): Promise<RecoveryResult> {
    throw new Error('Not implemented')
  }
}
