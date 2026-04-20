import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { SenderMapping } from '../engine/sender-mapping.js'
import type { AuditLogger } from '../config/audit-logger.js'

const createSchema = z.object({
  phone_number: z.string().min(10),
  device_serial: z.string().min(1),
  profile_id: z.number().int().min(0).optional(),
  app_package: z.string().min(1).optional(),
  waha_session: z.string().min(1).optional(),
  waha_api_url: z.string().url().optional(),
})

const updateSchema = z.object({
  device_serial: z.string().min(1).optional(),
  profile_id: z.number().int().min(0).optional(),
  app_package: z.string().min(1).optional(),
  waha_session: z.string().min(1).optional(),
  waha_api_url: z.string().url().optional(),
  active: z.boolean().optional(),
})

export function registerSenderMappingRoutes(
  server: FastifyInstance,
  senderMapping: SenderMapping,
  auditLogger?: AuditLogger,
): void {
  // List all active mappings
  server.get('/api/v1/sender-mapping', async (_request, reply) => {
    const mappings = senderMapping.listAll()
    return reply.send({ mappings })
  })

  // Get single mapping by phone
  server.get('/api/v1/sender-mapping/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const mapping = senderMapping.getByPhone(phone)
    if (!mapping) {
      return reply.status(404).send({ error: 'Mapping not found' })
    }
    return reply.send(mapping)
  })

  // Create new mapping
  server.post('/api/v1/sender-mapping', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    try {
      const mapping = senderMapping.create({
        phoneNumber: parsed.data.phone_number,
        deviceSerial: parsed.data.device_serial,
        profileId: parsed.data.profile_id,
        appPackage: parsed.data.app_package,
        wahaSession: parsed.data.waha_session,
        wahaApiUrl: parsed.data.waha_api_url,
      })
      auditLogger?.log({
        action: 'create',
        resourceType: 'sender_mapping',
        resourceId: parsed.data.phone_number,
        afterState: mapping,
      })
      return reply.status(201).send(mapping)
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
        return reply.status(409).send({ error: 'Mapping already exists for this phone number' })
      }
      throw err
    }
  })

  // Update mapping
  server.put('/api/v1/sender-mapping/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const parsed = updateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.issues })
    }

    const beforeState = senderMapping.getByPhone(phone)
    const updated = senderMapping.update(phone, {
      deviceSerial: parsed.data.device_serial,
      profileId: parsed.data.profile_id,
      appPackage: parsed.data.app_package,
      wahaSession: parsed.data.waha_session,
      wahaApiUrl: parsed.data.waha_api_url,
      active: parsed.data.active,
    })

    if (!updated) {
      return reply.status(404).send({ error: 'Mapping not found' })
    }
    auditLogger?.log({
      action: 'update',
      resourceType: 'sender_mapping',
      resourceId: phone,
      beforeState,
      afterState: updated,
    })
    return reply.send(updated)
  })

  // Delete mapping
  server.delete('/api/v1/sender-mapping/:phone', async (request, reply) => {
    const { phone } = request.params as { phone: string }
    const beforeState = senderMapping.getByPhone(phone)
    const deleted = senderMapping.remove(phone)
    if (!deleted) {
      return reply.status(404).send({ error: 'Mapping not found' })
    }
    auditLogger?.log({
      action: 'delete',
      resourceType: 'sender_mapping',
      resourceId: phone,
      beforeState,
    })
    return reply.status(204).send()
  })
}
