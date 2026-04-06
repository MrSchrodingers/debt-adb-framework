import 'dotenv/config'
import { createServer } from './server.js'

const core = await createServer()

// Graceful shutdown for tsx watch reload + Ctrl+C
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await core.server.close()
    process.exit(0)
  })
}
