import Fastify from 'fastify'
import cors from '@fastify/cors'

export async function createServer(port = Number(process.env.PORT) || 7890) {
  const server = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  })

  await server.register(cors)

  server.get('/api/v1/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  await server.listen({ port, host: '0.0.0.0' })
  return server
}
