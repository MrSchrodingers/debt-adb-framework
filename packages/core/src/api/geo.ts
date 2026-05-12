import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { GeoViewRegistry, RegistryError } from '../geo/registry.js'
import { validateGeoQuery } from '../geo/filter-validator.js'
import { VALID_BR_DDDS } from '../util/ddd.js'

export interface GeoRoutesOptions {
  registry: GeoViewRegistry
  apiKey: string
  getPluginStatuses(): Record<string, 'active' | 'error' | 'disabled'>
}

export function registerGeoRoutes(app: FastifyInstance, opts: GeoRoutesOptions): void {
  const { registry, apiKey, getPluginStatuses } = opts

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/v1/geo')) return
    const provided = req.headers['x-api-key']
    if (provided !== apiKey) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.get('/api/v1/geo/views', async () => {
    return registry.listSummary({ statusByPlugin: getPluginStatuses() })
  })

  app.get('/api/v1/geo/views/:viewId/aggregate', async (req, reply) => {
    const { viewId } = req.params as { viewId: string }
    const view = registry.get(viewId)
    if (!view) { reply.code(404).send({ error: 'view_not_found', viewId }); return }
    const q = normalizeQuery(req.query)
    const result = validateGeoQuery({ query: q, filterSpecs: view.filters })
    if (!result.ok) {
      reply.code(400).send({ error: 'invalid_filter', field: result.field, reason: result.reason })
      return
    }
    try {
      const payload = await registry.runAggregate(viewId, result.params)
      return payload
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'plugin_aggregate_failed') {
        reply.code(503).send({
          error: 'plugin_aggregate_failed', viewId,
          pluginError: err.message, retryable: true,
        })
        return
      }
      throw err
    }
  })

  app.get('/api/v1/geo/views/:viewId/drill', async (req, reply) => {
    const { viewId } = req.params as { viewId: string }
    const view = registry.get(viewId)
    if (!view) { reply.code(404).send({ error: 'view_not_found', viewId }); return }
    const q = normalizeQuery(req.query)
    const ddd = q.ddd
    if (!ddd || !/^\d{2}$/.test(ddd) || !VALID_BR_DDDS.has(ddd)) {
      reply.code(400).send({ error: 'invalid_filter', field: 'ddd', reason: `value "${ddd ?? ''}" not a valid BR DDD` })
      return
    }
    const validation = validateGeoQuery({ query: q, filterSpecs: view.filters })
    if (!validation.ok) {
      reply.code(400).send({ error: 'invalid_filter', field: validation.field, reason: validation.reason })
      return
    }
    try {
      const payload = await registry.runDrill(viewId, ddd, validation.params)
      return payload
    } catch (err) {
      if (err instanceof RegistryError && err.code === 'plugin_drill_failed') {
        reply.code(503).send({
          error: 'plugin_drill_failed', viewId,
          pluginError: err.message, retryable: true,
        })
        return
      }
      throw err
    }
  })
}

function normalizeQuery(q: unknown): Record<string, string | undefined> {
  if (typeof q !== 'object' || q === null) return {}
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number') out[k] = String(v)
  }
  return out
}
