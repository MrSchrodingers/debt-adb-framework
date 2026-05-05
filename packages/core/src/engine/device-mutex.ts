/**
 * Per-device serial mutex shared across every component that mutates
 * a device's UI: WorkerOrchestrator (sending messages) and
 * AdbProbeStrategy (wa.me intent probes from the adb-precheck plugin).
 *
 * Without coordination they race on the same physical screen — a probe
 * fires `am start ... wa.me/X` mid-typing and WhatsApp moves the
 * already-typed body into the previous chat's draft. Operators saw
 * dozens of half-written Oralsin messages stuck as drafts whenever a
 * scan ran during the send window.
 *
 * Same shape as `AccountMutex` (FIFO waiters, timeout-based abort) but
 * keyed by device serial and exposed at engine root so it can be
 * injected anywhere `adb.shell` is called.
 */
export class DeviceMutex {
  private locks = new Map<string, { resolve: () => void }[]>()
  private held = new Set<string>()

  constructor(private timeoutMs = 60_000) {}

  /**
   * Acquire exclusive lock for a device serial. Returns a release
   * function. Rejects after `timeoutMs` so a stuck holder cannot wedge
   * the entire system — the caller can decide whether to retry or
   * surface the error.
   */
  async acquire(deviceSerial: string): Promise<() => void> {
    if (!this.held.has(deviceSerial)) {
      this.held.add(deviceSerial)
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
        resolve(() => this.release(deviceSerial))
      }

      if (!this.locks.has(deviceSerial)) {
        this.locks.set(deviceSerial, [])
      }
      this.locks.get(deviceSerial)!.push({ resolve: onRelease })
    })
  }

  /** True when the device is currently locked (probe or send in flight). */
  isHeld(deviceSerial: string): boolean {
    return this.held.has(deviceSerial)
  }

  private release(deviceSerial: string): void {
    const waiters = this.locks.get(deviceSerial)
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!
      next.resolve()
    } else {
      this.held.delete(deviceSerial)
      this.locks.delete(deviceSerial)
    }
  }

  /** Release every lock — for shutdown/tests. */
  releaseAll(): void {
    this.held.clear()
    this.locks.clear()
  }
}
