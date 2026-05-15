export interface DeviceMutexCtx {
  tenant: string
  jobId: string
}

interface HolderState extends DeviceMutexCtx {
  since: string // ISO 8601
}

export class DeviceMutex {
  private locks = new Map<string, { resolve: () => void; ctx?: DeviceMutexCtx }[]>()
  private held = new Map<string, HolderState>()

  constructor(private timeoutMs = 60_000) {}

  async acquire(deviceSerial: string, ctx?: DeviceMutexCtx): Promise<() => void> {
    if (!this.held.has(deviceSerial)) {
      this.held.set(deviceSerial, {
        tenant: ctx?.tenant ?? '(unknown)',
        jobId: ctx?.jobId ?? '(unknown)',
        since: new Date().toISOString(),
      })
      return () => this.release(deviceSerial)
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.locks.get(deviceSerial)
        if (waiters) {
          const idx = waiters.findIndex((w) => w.resolve === onRelease)
          if (idx !== -1) waiters.splice(idx, 1)
        }
        reject(new Error(`DeviceMutex timeout after ${this.timeoutMs}ms for ${deviceSerial}`))
      }, this.timeoutMs)

      const onRelease = () => {
        clearTimeout(timer)
        this.held.set(deviceSerial, {
          tenant: ctx?.tenant ?? '(unknown)',
          jobId: ctx?.jobId ?? '(unknown)',
          since: new Date().toISOString(),
        })
        resolve(() => this.release(deviceSerial))
      }

      if (!this.locks.has(deviceSerial)) this.locks.set(deviceSerial, [])
      this.locks.get(deviceSerial)!.push({ resolve: onRelease, ctx })
    })
  }

  isHeld(deviceSerial: string): boolean {
    return this.held.has(deviceSerial)
  }

  describeHolder(deviceSerial: string): HolderState | null {
    return this.held.get(deviceSerial) ?? null
  }

  private release(deviceSerial: string): void {
    const waiters = this.locks.get(deviceSerial)
    if (waiters && waiters.length > 0) {
      this.held.delete(deviceSerial)
      const next = waiters.shift()!
      next.resolve()
    } else {
      this.held.delete(deviceSerial)
      this.locks.delete(deviceSerial)
    }
  }

  releaseAll(): void {
    this.held.clear()
    this.locks.clear()
  }
}
