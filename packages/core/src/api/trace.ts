import type { FastifyInstance } from 'fastify'
import type { EventRecorder } from '../engine/event-recorder.js'

export function registerTraceRoutes(server: FastifyInstance, recorder: EventRecorder): void {
  server.get('/api/v1/messages/:id/trace', async (request, reply) => {
    const { id } = request.params as { id: string }
    const trace = recorder.getTrace(id)
    if (trace.length === 0) {
      return reply.status(404).send({ error: 'No trace events found for this message' })
    }
    return { messageId: id, events: trace }
  })
}
