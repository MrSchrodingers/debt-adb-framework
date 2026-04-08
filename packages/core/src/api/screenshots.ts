import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { MessageQueue } from '../queue/index.js'

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

    try {
      await stat(message.screenshotPath)
    } catch {
      return reply.status(404).send({ error: 'Screenshot file not found on disk' })
    }

    return reply
      .type('image/png')
      .send(createReadStream(message.screenshotPath))
  })
}
