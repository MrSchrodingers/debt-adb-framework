import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { DeviceManager } from '../monitor/device-manager.js'

const VALID_ACTIONS = ['keep-awake', 'screenshot', 'reboot'] as const
type BulkAction = (typeof VALID_ACTIONS)[number]

const bulkActionSchema = z.object({
  serials: z.array(z.string()).min(1, 'At least one serial is required'),
  action: z.enum(VALID_ACTIONS),
})

interface AdbAdapter {
  shell: (serial: string, command: string) => Promise<string>
  screenshot: (serial: string) => Promise<Buffer>
}

interface BulkActionDeps {
  adb: AdbAdapter
  deviceManager: DeviceManager
}

interface BulkActionResult {
  serial: string
  success: boolean
  error?: string
}

async function executeAction(
  adb: AdbAdapter,
  serial: string,
  action: BulkAction,
): Promise<BulkActionResult> {
  try {
    switch (action) {
      case 'keep-awake':
        await adb.shell(serial, 'svc power stayon true')
        break
      case 'screenshot':
        await adb.screenshot(serial)
        break
      case 'reboot':
        await adb.shell(serial, 'reboot')
        break
    }
    return { serial, success: true }
  } catch (err) {
    return {
      serial,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function registerBulkActionRoutes(
  server: FastifyInstance,
  deps: BulkActionDeps,
): void {
  const { adb, deviceManager } = deps

  server.post('/api/v1/devices/bulk-action', async (request, reply) => {
    const parsed = bulkActionSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues.map(i => i.message).join('; '),
      })
    }

    const { serials, action } = parsed.data
    const results: BulkActionResult[] = []

    // Execute sequentially to avoid ADB contention
    for (const serial of serials) {
      const result = await executeAction(adb, serial, action)
      results.push(result)
    }

    return { results }
  })
}
