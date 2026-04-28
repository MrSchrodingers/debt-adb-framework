// ── Telemetry bootstrap — MUST be first import so OTel patches HTTP/Fastify/SQLite ──
import './telemetry/init.js'
import 'dotenv/config'
import { createServer } from './server.js'

const core = await createServer()

core.shutdown.installSignalHandlers(async () => {
  await core.server.close()
})
