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
      // Structured 404 — distinguish why the screenshot is absent
      return reply.status(404).send({
        error: 'screenshot_unavailable',
        code: message.screenshotStatus ?? 'never_persisted',
        reason: message.screenshotSkipReason ?? null,
        deleted_at: message.screenshotDeletedAt ?? null,
        message_sent_at: message.sentAt ?? null,
      })
    }

    // Prevent path traversal — only serve files within reports/sends/
    const resolvedPath = resolve(message.screenshotPath)
    if (!resolvedPath.startsWith(SCREENSHOTS_DIR)) {
      return reply.status(403).send({ error: 'Access denied' })
    }

    try {
      await stat(resolvedPath)
    } catch {
      // Path set in DB but file gone (manual deletion or race with retention)
      return reply.status(404).send({
        error: 'screenshot_unavailable',
        code: 'file_missing_on_disk',
        reason: 'Path is set in DB but file was removed (retention or manual deletion).',
        expected_path: message.screenshotPath,
        message_sent_at: message.sentAt ?? null,
      })
    }

    const contentType = resolvedPath.endsWith('.jpg') || resolvedPath.endsWith('.jpeg')
      ? 'image/jpeg'
      : 'image/png'
    return reply
      .type(contentType)
      .send(createReadStream(resolvedPath))
  })
}
