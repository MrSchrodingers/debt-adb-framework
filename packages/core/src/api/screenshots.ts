import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { MessageQueue } from '../queue/index.js'

const SCREENSHOTS_DIR = resolve('reports/sends')

export function registerScreenshotRoutes(server: FastifyInstance, queue: MessageQueue): void {
  server.get('/api/v1/messages/:id/screenshot', async (request, reply) => {
    const { id } = request.params as { id: string }
    const message = queue.getById(id)

    if (!message) {
      return reply.status(404).send({ error: 'Message not found' })
    }

    if (!message.screenshotPath) {
      return reply.status(404).send({ error: 'No screenshot available for this message' })
    }

    // Prevent path traversal — only serve files within reports/sends/
    const resolvedPath = resolve(message.screenshotPath)
    if (!resolvedPath.startsWith(SCREENSHOTS_DIR)) {
      return reply.status(403).send({ error: 'Access denied' })
    }

    try {
      await stat(resolvedPath)
    } catch {
      return reply.status(404).send({ error: 'Screenshot file not found on disk' })
    }

    return reply
      .type('image/png')
      .send(createReadStream(resolvedPath))
  })
}
