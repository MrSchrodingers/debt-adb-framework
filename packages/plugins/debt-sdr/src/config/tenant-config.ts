import { z } from 'zod'

// ── primitives ────────────────────────────────────────────────────────────

/** BR digits-only phone, 12-13 digits (55 + DDD + 8 or 9 digits). */
const phoneSchema = z
  .string()
  .regex(/^55\d{10,11}$/, 'phone must be BR digits-only (55 + DDD + number)')

const appSchema = z.enum(['com.whatsapp', 'com.whatsapp.w4b'])

const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM 24h')

const senderSchema = z.object({
  phone: phoneSchema,
  app: appSchema,
})

const pullSchema = z.object({
  stage_id: z.number().int().positive(),
  poll_interval_minutes: z.number().int().positive().max(60 * 24),
  batch_size: z.number().int().positive().max(500),
  max_age_days: z.number().int().positive().max(365),
  phone_field_key: z.string().min(1),
})

const writebackSchema = z.object({
  stage_qualified_id: z.number().int().positive(),
  stage_disqualified_id: z.number().int().positive(),
  stage_needs_human_id: z.number().int().positive(),
  stage_no_response_id: z.number().int().positive(),
  activity_subject_template: z.string().min(1),
})

const pipedriveSchema = z.object({
  domain: z.string().min(1),
  api_token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'env var name must be UPPER_SNAKE_CASE'),
  pull: pullSchema,
  writeback: writebackSchema,
})

const operatingHoursSchema = z
  .object({
    start: hhmmSchema,
    end: hhmmSchema,
  })
  .refine(
    (o) => o.start < o.end,
    { message: 'operating_hours.start must be strictly less than end (HH:MM)', path: ['end'] },
  )

const throttleSchema = z.object({
  per_sender_daily_max: z.number().int().positive().max(500),
  min_interval_minutes: z.number().int().positive().max(60 * 24),
  operating_hours: operatingHoursSchema,
  tz: z.string().min(1),
})

const identityGateSchema = z
  .object({
    enabled: z.boolean(),
    nudge_after_hours: z.number().int().positive(),
    abort_after_hours: z.number().int().positive(),
  })
  .refine(
    (g) => g.abort_after_hours > g.nudge_after_hours,
    { message: 'identity_gate.abort_after_hours must be > nudge_after_hours', path: ['abort_after_hours'] },
  )

// ── per-tenant ────────────────────────────────────────────────────────────

export const sdrTenantConfigSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'tenant name must be lower-kebab-case'),
  label: z.string().min(1),
  pipeboard_tenant: z.string().optional(),
  pipedrive: pipedriveSchema,
  devices: z.array(z.string().min(1)).min(1, 'each tenant must claim at least one device'),
  senders: z.array(senderSchema).min(1, 'each tenant must declare at least one sender'),
  sequence_id: z.string().regex(/^[a-z][a-z0-9-]*-v\d+$/, 'sequence_id must be kebab-case ending in -v<N>'),
  throttle: throttleSchema,
  identity_gate: identityGateSchema,
})

export type SdrTenantConfig = z.infer<typeof sdrTenantConfigSchema>

// ── plugin-level (cross-tenant invariants) ────────────────────────────────

export const sdrPluginConfigSchema = z
  .object({
    tenants: z.array(sdrTenantConfigSchema).min(1, 'at least one tenant must be configured'),
  })
  .superRefine((cfg, ctx) => {
    // Duplicate tenant names.
    const seenTenants = new Set<string>()
    for (let i = 0; i < cfg.tenants.length; i++) {
      const n = cfg.tenants[i].name
      if (seenTenants.has(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', i, 'name'],
          message: `duplicate tenant name: ${n}`,
        })
      }
      seenTenants.add(n)
    }

    // Duplicate device serials across tenants (hard partition invariant I1).
    const devToTenant = new Map<string, string>()
    cfg.tenants.forEach((t, ti) => {
      t.devices.forEach((d, di) => {
        const owner = devToTenant.get(d)
        if (owner && owner !== t.name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tenants', ti, 'devices', di],
            message: `device ${d} is already claimed by tenant ${owner}`,
          })
        }
        devToTenant.set(d, t.name)
      })
    })

    // Duplicate (phone, app) across tenants (invariant I3 — sender exclusivity).
    const senderToTenant = new Map<string, string>()
    cfg.tenants.forEach((t, ti) => {
      t.senders.forEach((s, si) => {
        const key = `${s.phone}|${s.app}`
        const owner = senderToTenant.get(key)
        if (owner && owner !== t.name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tenants', ti, 'senders', si, 'phone'],
            message: `sender (${s.phone}, ${s.app}) is already claimed by tenant ${owner}`,
          })
        }
        senderToTenant.set(key, t.name)
      })
    })

    // Duplicate api_token_env across tenants — cross-tenant data leak risk.
    const tokenEnvToTenant = new Map<string, string>()
    cfg.tenants.forEach((t, ti) => {
      const key = t.pipedrive.api_token_env
      const owner = tokenEnvToTenant.get(key)
      if (owner && owner !== t.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tenants', ti, 'pipedrive', 'api_token_env'],
          message: `api_token_env ${key} reused across tenants — token sharing is forbidden`,
        })
      }
      tokenEnvToTenant.set(key, t.name)
    })
  })

export type SdrPluginConfig = z.infer<typeof sdrPluginConfigSchema>

// ── loader ────────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON config. Throws ZodError on failure with
 * the full issue list so operators can fix all problems in one pass.
 */
export function loadSdrPluginConfig(raw: unknown): SdrPluginConfig {
  return sdrPluginConfigSchema.parse(raw)
}
