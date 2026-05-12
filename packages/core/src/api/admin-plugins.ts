import type { FastifyInstance } from 'fastify'
import type { PluginRegistry } from '../plugins/plugin-registry.js'
import type { PluginLoader } from '../plugins/plugin-loader.js'
import type { AuditLogger } from '../config/audit-logger.js'
import { DISPATCH_SDK_VERSION } from '../plugins/manifest.js'

/**
 * Admin routes for plugin introspection + control (B4, Sprint 2 v2 roadmap).
 *
 * Surface what the loader knows about each plugin: persisted state (enabled,
 * status) from the registry plus runtime state (loaded?, manifest validation
 * outcome, declared metadata) from the loader. Lets operators enable/disable
 * plugins without touching the DB and reload (DEV-only) without restarting
 * dispatch-core.
 *
 * Auth: protected by the global X-API-Key hook (see api-auth.ts) — same
 * surface as /admin/messages/*.
 */
export function registerAdminPluginRoutes(
  server: FastifyInstance,
  registry: PluginRegistry,
  loader: PluginLoader,
  auditLogger?: AuditLogger,
): void {
  server.get('/api/v1/admin/plugins', async () => {
    const persisted = registry.listPlugins()
    return {
      host_sdk_version: DISPATCH_SDK_VERSION,
      reload_available:
        process.env.NODE_ENV !== 'production' ||
        process.env.DISPATCH_DEV_RELOAD === 'true',
      services: loader.getServices().list(),
      plugins: persisted.map((row) => {
        const loaded = loader.getLoadedPlugin(row.name)
        const manifestResult = loader.getManifestResult(row.name)
        return {
          name: row.name,
          version: row.version,
          enabled: row.enabled === 1,
          status: row.status,
          webhook_url: row.webhook_url,
          events: safeJsonArray(row.events),
          loaded: loaded != null,
          manifest:
            loaded && loaded.manifest
              ? {
                  declared: loaded.manifest,
                  validation: manifestResult ?? null,
                }
              : null,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }
      }),
    }
  })

  server.post('/api/v1/admin/plugins/:name/enable', async (request, reply) => {
    const name = (request.params as { name: string }).name
    if (!registry.getPlugin(name)) {
      return reply.status(404).send({ error: 'plugin_not_found', name })
    }
    registry.enablePlugin(name)
    auditLogger?.log({
      actor: 'admin',
      action: 'plugin_enable',
      resourceType: 'plugin',
      resourceId: name,
      afterState: { enabled: true, status: 'active' },
    })
    return { ok: true, name, enabled: true }
  })

  server.post('/api/v1/admin/plugins/:name/disable', async (request, reply) => {
    const name = (request.params as { name: string }).name
    if (!registry.getPlugin(name)) {
      return reply.status(404).send({ error: 'plugin_not_found', name })
    }
    registry.disablePlugin(name)
    auditLogger?.log({
      actor: 'admin',
      action: 'plugin_disable',
      resourceType: 'plugin',
      resourceId: name,
      afterState: { enabled: false, status: 'disabled' },
    })
    return { ok: true, name, enabled: false }
  })

  server.post('/api/v1/admin/plugins/:name/reload', async (request, reply) => {
    const name = (request.params as { name: string }).name
    const result = await loader.reloadPlugin(name)
    if (!result.ok) {
      const status = result.reason === 'disabled_in_production' ? 403 : 400
      return reply.status(status).send({ error: result.reason, detail: result.detail })
    }
    auditLogger?.log({
      actor: 'admin',
      action: 'plugin_reload',
      resourceType: 'plugin',
      resourceId: name,
      afterState: { reloaded: true },
    })
    return { ok: true, name }
  })
}

function safeJsonArray(s: string): string[] {
  try {
    const parsed = JSON.parse(s) as unknown
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}
