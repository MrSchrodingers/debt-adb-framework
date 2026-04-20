interface ShutdownLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string | Record<string, unknown>, ...args: unknown[]): void
}

interface ShutdownHandler {
  name: string
  fn: () => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 60_000

export class GracefulShutdown {
  private handlers: ShutdownHandler[] = []
  private executed = false
  private activeSend: Promise<void> | null = null

  constructor(
    private logger: ShutdownLogger,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  addHandler(name: string, fn: () => Promise<void>): void {
    this.handlers.push({ name, fn })
  }

  /**
   * Mark a send operation as active. waitForSend() will block until it completes.
   */
  markSendActive(sendPromise: Promise<void>): void {
    this.activeSend = sendPromise.finally(() => {
      this.activeSend = null
    })
  }

  /**
   * Wait for the current send to complete (if any).
   */
  async waitForSend(): Promise<void> {
    if (this.activeSend) {
      this.logger.info('Waiting for active send to complete...')
      await this.activeSend
    }
  }

  /**
   * Execute all shutdown handlers in order. Idempotent — second call is no-op.
   * Each handler has a timeout; failures are logged but don't block others.
   */
  async execute(): Promise<void> {
    if (this.executed) return
    this.executed = true

    this.logger.info('Graceful shutdown initiated')

    const deadline = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), this.timeoutMs),
    )

    const work = async (): Promise<void> => {
      // Wait for active send first
      await this.waitForSend()

      for (const handler of this.handlers) {
        try {
          await handler.fn()
          this.logger.info(`Shutdown handler "${handler.name}" completed`)
        } catch (err) {
          this.logger.error(
            { err, handler: handler.name },
            `Shutdown handler "${handler.name}" failed`,
          )
        }
      }
    }

    const result = await Promise.race([work().then(() => 'done' as const), deadline])
    if (result === 'timeout') {
      this.logger.warn('Graceful shutdown timed out')
    }

    this.logger.info('Shutdown complete')
  }

  /**
   * Install SIGINT/SIGTERM handlers that trigger graceful shutdown.
   */
  installSignalHandlers(onShutdown: () => Promise<void>): void {
    const handler = async (signal: string): Promise<void> => {
      this.logger.info(`Received ${signal}, starting graceful shutdown`)
      await onShutdown()
      process.exit(0)
    }

    process.on('SIGINT', () => void handler('SIGINT'))
    process.on('SIGTERM', () => void handler('SIGTERM'))
  }
}
