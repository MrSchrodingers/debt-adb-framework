import 'dotenv/config'
import { createServer } from './server.js'

const core = await createServer()

core.shutdown.installSignalHandlers(async () => {
  await core.server.close()
})
