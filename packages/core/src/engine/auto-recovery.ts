import type { CrashDetection, RecoveryResult } from './types.js'
import type { AdbShellAdapter } from '../monitor/types.js'

export class AutoRecovery {
  private wait: (ms: number) => Promise<void>

  constructor(
    private adb: AdbShellAdapter,
    delay?: (ms: number) => Promise<void>,
  ) {
    this.wait = delay ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  detectCrash(sendButtonFound: boolean, pidOutput: string): CrashDetection {
    if (sendButtonFound) {
      return { crashed: false, hasPid: pidOutput.trim().length > 0 }
    }
    return {
      crashed: true,
      hasPid: pidOutput.trim().length > 0,
    }
  }

  async recover(
    deviceSerial: string,
    crashInfo: CrashDetection,
    toNumber: string,
    packageName = 'com.whatsapp',
  ): Promise<RecoveryResult> {
    if (!crashInfo.crashed) {
      return { recovered: true, action: 'none' }
    }

    const action = crashInfo.hasPid ? 'back_reopen' : 'force_stop' as const

    try {
      if (!crashInfo.hasPid) {
        await this.adb.shell(deviceSerial, `am force-stop ${packageName}`)
        await this.wait(3000)
      } else {
        for (let i = 0; i < 3; i++) {
          await this.adb.shell(deviceSerial, 'input keyevent 4')
          await this.wait(300)
        }
      }

      await this.adb.shell(
        deviceSerial,
        `am start -a android.intent.action.VIEW -d "https://wa.me/${toNumber}" -p ${packageName}`,
      )
      return { recovered: true, action }
    } catch {
      return { recovered: false, action }
    }
  }

}
