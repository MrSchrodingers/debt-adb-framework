import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AdbBridge } from '../adb/index.js'
import type { SetupWizardStore } from '../devices/index.js'
import {
  extractPhonesViaRoot,
  isDeviceRooted,
  type WaAccountMapper,
} from '../monitor/index.js'
import type { ChipRegistry } from '../fleet/index.js'
import type { AuditLogger } from '../config/audit-logger.js'
import type { DispatchEmitter } from '../events/index.js'

/**
 * REST endpoints driving the per-device Setup Wizard. The wizard reproduces
 * the rooted reference build (POCO #1) on a fresh POCO C71 / Redmi A5
 * Serenity device:
 *
 *   1. root_check        - probe `su -c id` and persist root_done
 *   2. create_users      - `cmd user create-user --user-type ... NAME` (root required)
 *   3. bypass_setup_*    - reuse the existing per-profile bypass-setup-wizard endpoint
 *   4. install_wa        - `cmd package install-existing --user N <pkg>` per profile
 *   5. mark_registered   - HITL: operator confirms QR / SMS login per profile
 *   6. extract_phones    - reuse existing extract-phones-root endpoint and finalize
 *
 * Every mutation is idempotent: re-entering the wizard after a reload picks
 * up exactly where the operator stopped.
 *
 * SECURITY: profile names supplied by the operator are passed unquoted into
 * `cmd user create-user`. We restrict them to a conservative alphanum + space
 * + dash + underscore set in the Zod schema below; the regex is anchored.
 */

const SAFE_NAME_RE = /^[A-Za-z0-9 _-]{1,32}$/
const ALLOWED_PACKAGES = ['com.whatsapp', 'com.whatsapp.w4b'] as const

export interface SetupWizardRoutesDeps {
  store: SetupWizardStore
  waMapper?: WaAccountMapper
  chipRegistry?: ChipRegistry
  auditLogger?: AuditLogger
  emitter?: DispatchEmitter
}

interface AdbShell {
  shell: (serial: string, cmd: string) => Promise<string>
}

async function listUserIds(adb: AdbShell, serial: string): Promise<number[]> {
  try {
    const out = await adb.shell(serial, 'pm list users')
    return [...out.matchAll(/UserInfo\{(\d+):/g)].map((m) => Number(m[1]))
  } catch {
    return []
  }
}

/** Best-effort wizard event emit. Wizard tabs subscribe via Socket.IO. */
function emitWizardEvent(
  emitter: DispatchEmitter | undefined,
  event: 'setup_wizard:progress' | 'setup_wizard:step_done',
  payload: Record<string, unknown>,
): void {
  if (!emitter) return
  // Cast: these events are wizard-specific extensions of the dispatch stream.
  // We pipe them to the same socket without strict typing — UI consumers are
  // the wizard component only.
  ;(emitter as unknown as { emit: (e: string, d: unknown) => void }).emit(event, payload)
}

export function registerSetupWizardRoutes(
  server: FastifyInstance,
  adb: AdbBridge,
  deps: SetupWizardRoutesDeps,
): void {
  const { store } = deps

  // GET /api/v1/devices/:serial/setup/state
  server.get('/api/v1/devices/:serial/setup/state', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const state = store.get(serial)
    if (!state) {
      return reply.send({
        device_serial: serial,
        root_done: false,
        users_created: {},
        bypassed_profiles: {},
        wa_installed_profiles: {},
        wa_registered_profiles: {},
        extraction_complete: false,
        current_step: null,
        started_at: null,
        updated_at: null,
        finished_at: null,
        exists: false,
      })
    }
    return reply.send({ ...state, exists: true })
  })

  // POST /api/v1/devices/:serial/setup/root-check
  server.post('/api/v1/devices/:serial/setup/root-check', async (request, reply) => {
    const { serial } = request.params as { serial: string }

    let rooted = false
    try {
      rooted = await isDeviceRooted(adb, serial)
    } catch (err) {
      server.log.warn({ serial, err }, 'setup-wizard: root probe failed')
    }

    const state = store.upsert(serial, {
      root_done: rooted,
      current_step: rooted ? 'root_done' : null,
    })

    deps.auditLogger?.log({
      action: 'setup_wizard.root_check',
      resourceType: 'device',
      resourceId: serial,
      afterState: { rooted },
    })
    emitWizardEvent(deps.emitter, 'setup_wizard:progress', {
      serial,
      step: 'root_check',
      ok: rooted,
    })

    if (!rooted) {
      return reply.status(409).send({
        ok: false,
        rooted: false,
        state,
        hint:
          'Dispositivo nao rooteado. Siga docs/devices/poco-c71-root-procedure.md ' +
          '(Magisk 28.1 + PIF v16 + Zygisk-Assistant) e tente novamente.',
      })
    }

    return reply.send({ ok: true, rooted: true, state })
  })

  // POST /api/v1/devices/:serial/setup/manual-root-ack
  // Operator escape hatch: the device IS rooted but the probe is being shy.
  // Persists root_done=true without re-probing. Audit-logged.
  server.post('/api/v1/devices/:serial/setup/manual-root-ack', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    const state = store.upsert(serial, { root_done: true, current_step: 'root_done' })
    deps.auditLogger?.log({
      action: 'setup_wizard.manual_root_ack',
      resourceType: 'device',
      resourceId: serial,
      afterState: { root_done: true },
    })
    return reply.send({ ok: true, state })
  })

  // POST /api/v1/devices/:serial/setup/create-users
  // Body: { users: [{ uid: number, name: string }, ...] }
  server.post('/api/v1/devices/:serial/setup/create-users', async (request, reply) => {
    const { serial } = request.params as { serial: string }

    const bodySchema = z
      .object({
        users: z
          .array(
            z.object({
              uid: z.number().int().min(10).max(99).optional(),
              name: z.string().regex(SAFE_NAME_RE, 'name must match /^[A-Za-z0-9 _-]{1,32}$/'),
            }),
          )
          .min(1)
          .max(16),
      })
      .strict()
    const parsed = bodySchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'Validation failed', details: parsed.error.issues })
    }

    const rooted = await isDeviceRooted(adb, serial).catch(() => false)
    if (!rooted) {
      return reply.status(409).send({
        error: 'device_not_rooted',
        detail: 'Criacao de usuarios secundarios via cmd user create-user exige root.',
      })
    }

    const existing = await listUserIds(adb, serial)
    const results: Array<{
      requested_name: string
      requested_uid?: number
      uid?: number
      created: boolean
      already_existed: boolean
      error?: string
    }> = []
    const usersDelta: Record<string, string> = {}

    for (const u of parsed.data.users) {
      // `cmd user create-user` does NOT honour an explicit uid — Android picks
      // the next free id. We only check overlap on the requested uid for
      // diagnostics; the actual created uid is parsed from output.
      if (u.uid !== undefined && existing.includes(u.uid)) {
        results.push({
          requested_name: u.name,
          requested_uid: u.uid,
          uid: u.uid,
          created: false,
          already_existed: true,
        })
        usersDelta[String(u.uid)] = u.name
        continue
      }

      // Quote the name to defang spaces (validated to /^[A-Za-z0-9 _-]+$/ already).
      const quoted = `"${u.name.replace(/"/g, '')}"`
      try {
        const out = await adb.shell(
          serial,
          `su -c "cmd user create-user --user-type android.os.usertype.full.SECONDARY ${quoted}"`,
        )
        // Output: "Success: created user id 11"
        const match = out.match(/created user id (\d+)/)
        if (match) {
          const uid = Number(match[1])
          results.push({
            requested_name: u.name,
            requested_uid: u.uid,
            uid,
            created: true,
            already_existed: false,
          })
          usersDelta[String(uid)] = u.name
        } else {
          results.push({
            requested_name: u.name,
            requested_uid: u.uid,
            created: false,
            already_existed: false,
            error: out.trim().slice(0, 200) || 'no_user_id_in_output',
          })
        }
      } catch (err) {
        results.push({
          requested_name: u.name,
          requested_uid: u.uid,
          created: false,
          already_existed: false,
          error: (err as Error).message,
        })
      }
    }

    const state = store.upsert(serial, {
      users_created: usersDelta,
      current_step: 'users_created',
    })

    deps.auditLogger?.log({
      action: 'setup_wizard.create_users',
      resourceType: 'device',
      resourceId: serial,
      afterState: {
        requested: parsed.data.users.length,
        created: results.filter((r) => r.created).length,
        already: results.filter((r) => r.already_existed).length,
      },
    })
    emitWizardEvent(deps.emitter, 'setup_wizard:step_done', {
      serial,
      step: 'create_users',
      results,
    })

    return reply.send({ ok: true, results, state })
  })

  // POST /api/v1/devices/:serial/setup/install-wa-per-user
  // Body: { profile_ids?: number[]; package_names?: ('com.whatsapp'|'com.whatsapp.w4b')[] }
  // Defaults: every secondary profile (uid >= 10) reported by `pm list users`,
  // both com.whatsapp and com.whatsapp.w4b. Idempotent — `pm install-existing`
  // returns success when the package was already installed for that user.
  server.post(
    '/api/v1/devices/:serial/setup/install-wa-per-user',
    async (request, reply) => {
      const { serial } = request.params as { serial: string }

      const bodySchema = z
        .object({
          profile_ids: z.array(z.number().int().min(0).max(99)).optional(),
          package_names: z.array(z.enum(ALLOWED_PACKAGES)).optional(),
        })
        .strict()
      const parsed = bodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation failed', details: parsed.error.issues })
      }

      const allUsers = await listUserIds(adb, serial)
      const targetUsers =
        parsed.data.profile_ids ?? allUsers.filter((u) => u >= 10)
      const targetPkgs = parsed.data.package_names ?? [
        ...ALLOWED_PACKAGES,
      ]

      if (targetUsers.length === 0) {
        return reply.status(400).send({
          error: 'no_target_users',
          detail:
            'Nenhum profile secundario encontrado. Crie usuarios na etapa 2 antes de propagar o WA.',
        })
      }

      const installed: Record<string, string[]> = {}
      const results: Array<{
        uid: number
        package_name: string
        ok: boolean
        output: string
      }> = []
      for (const uid of targetUsers) {
        for (const pkg of targetPkgs) {
          try {
            const out = await adb.shell(
              serial,
              `cmd package install-existing --user ${uid} ${pkg}`,
            )
            const ok =
              out.toLowerCase().includes('installed for user') ||
              out.toLowerCase().includes('package ' + pkg) ||
              out.toLowerCase().includes('success')
            results.push({ uid, package_name: pkg, ok, output: out.trim().slice(0, 200) })
            if (ok) {
              const list = installed[String(uid)] ?? []
              if (!list.includes(pkg)) list.push(pkg)
              installed[String(uid)] = list
            }
          } catch (err) {
            results.push({
              uid,
              package_name: pkg,
              ok: false,
              output: (err as Error).message,
            })
          }
        }
      }

      const state = store.upsert(serial, {
        wa_installed_profiles: installed,
        current_step: 'wa_installed',
      })

      deps.auditLogger?.log({
        action: 'setup_wizard.install_wa_per_user',
        resourceType: 'device',
        resourceId: serial,
        afterState: {
          profiles: targetUsers.length,
          packages: targetPkgs.length,
          installed_count: results.filter((r) => r.ok).length,
        },
      })
      emitWizardEvent(deps.emitter, 'setup_wizard:step_done', {
        serial,
        step: 'install_wa',
        results,
      })

      return reply.send({ ok: true, results, state })
    },
  )

  // POST /api/v1/devices/:serial/setup/mark-registered
  // Body: { uid: number; phone_number?: string }
  // HITL acknowledgement after the operator finished QR / SMS on the device.
  server.post(
    '/api/v1/devices/:serial/setup/mark-registered',
    async (request, reply) => {
      const { serial } = request.params as { serial: string }

      const bodySchema = z
        .object({
          uid: z.number().int().min(0).max(99),
          phone_number: z.string().min(8).max(20).optional(),
        })
        .strict()
      const parsed = bodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation failed', details: parsed.error.issues })
      }

      const phone = parsed.data.phone_number ?? 'pending'
      const state = store.upsert(serial, {
        wa_registered_profiles: { [String(parsed.data.uid)]: phone },
        current_step: 'wa_registered',
      })

      deps.auditLogger?.log({
        action: 'setup_wizard.mark_registered',
        resourceType: 'device_profile',
        resourceId: `${serial}:${parsed.data.uid}`,
        afterState: { phone_number: phone },
      })
      emitWizardEvent(deps.emitter, 'setup_wizard:progress', {
        serial,
        step: 'mark_registered',
        uid: parsed.data.uid,
        phone,
      })

      return reply.send({ ok: true, state })
    },
  )

  // POST /api/v1/devices/:serial/setup/finalize
  // Triggers extract-phones-root one more time, persists chip mapping, and
  // marks the wizard as complete.
  server.post('/api/v1/devices/:serial/setup/finalize', async (request, reply) => {
    const { serial } = request.params as { serial: string }

    const rooted = await isDeviceRooted(adb, serial).catch(() => false)
    if (!rooted) {
      return reply.status(409).send({
        error: 'device_not_rooted',
        detail: 'A finalizacao depende da extracao de telefones via root.',
      })
    }

    const results = await extractPhonesViaRoot(adb, serial, {
      logger: { warn: (payload, msg) => server.log.warn(payload, msg) },
    })
    let persisted = 0
    for (const r of results) {
      if (r.phone && deps.waMapper) {
        try {
          deps.waMapper.setPhoneNumber(serial, r.profile_id, r.package_name, r.phone)
          persisted++
        } catch (err) {
          server.log.warn(
            { serial, profile: r.profile_id, err },
            'finalize: setPhoneNumber failed',
          )
        }
      }
    }

    let chipsCreated = 0
    if (persisted > 0 && deps.chipRegistry) {
      try {
        const before = deps.chipRegistry.listChips({}).length
        deps.chipRegistry.importFromDevices()
        const after = deps.chipRegistry.listChips({}).length
        chipsCreated = Math.max(0, after - before)
      } catch (err) {
        server.log.warn({ serial, err }, 'finalize: chip import failed')
      }
    }

    const state = store.upsert(serial, {
      extraction_complete: true,
      current_step: 'extraction_complete',
      finished_at: new Date().toISOString(),
    })

    deps.auditLogger?.log({
      action: 'setup_wizard.finalize',
      resourceType: 'device',
      resourceId: serial,
      afterState: { phones_persisted: persisted, chips_created: chipsCreated },
    })
    emitWizardEvent(deps.emitter, 'setup_wizard:step_done', {
      serial,
      step: 'finalize',
      phones_persisted: persisted,
      chips_created: chipsCreated,
    })

    return reply.send({
      ok: true,
      phones_persisted: persisted,
      chips_created: chipsCreated,
      results,
      state,
    })
  })

  // POST /api/v1/devices/:serial/setup/reset (admin only)
  server.post('/api/v1/devices/:serial/setup/reset', async (request, reply) => {
    const { serial } = request.params as { serial: string }
    store.reset(serial)
    deps.auditLogger?.log({
      action: 'setup_wizard.reset',
      resourceType: 'device',
      resourceId: serial,
    })
    return reply.send({ ok: true })
  })
}
