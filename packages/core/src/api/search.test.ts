/**
 * Tests for the command-palette search endpoints:
 *   GET /api/v1/devices/search?q=
 *   GET /api/v1/messages/search?q=
 *
 * Phase 8.1 — Task 8.1 backend search endpoints.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { MessageQueue } from '../queue/message-queue.js'
import { registerMessageRoutes } from './messages.js'
import { registerDeviceRoutes } from './devices.js'
import type { AdbBridge } from '../adb/index.js'
import type { DispatchEmitter } from '../events/index.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function buildMessageServer() {
  const db = new Database(':memory:')
  const queue = new MessageQueue(db)
  queue.initialize()

  const emitter = { emit: vi.fn() } as unknown as DispatchEmitter

  const server = Fastify({ logger: false })
  registerMessageRoutes(server, queue, emitter)
  return { server, queue, db }
}

function buildDeviceServer(devices: Array<{ serial: string; type: string }>) {
  const adb = {
    discover: vi.fn().mockResolvedValue(devices),
    shell: vi.fn(),
    health: vi.fn(),
  } as unknown as AdbBridge

  const server = Fastify({ logger: false })
  registerDeviceRoutes(server, adb)
  return { server, adb }
}

// ── Message search tests ───────────────────────────────────────────────────

describe('GET /api/v1/messages/search', () => {
  let ctx: ReturnType<typeof buildMessageServer>

  beforeEach(() => {
    ctx = buildMessageServer()
    // Seed a few messages
    ctx.queue.enqueue({ to: '5511111110001', body: 'hello', idempotencyKey: 'ik-1' })
    ctx.queue.enqueue({ to: '5511222220002', body: 'world', idempotencyKey: 'ik-2' })
    ctx.queue.enqueue({ to: '5599887766554', body: 'foo', idempotencyKey: 'ik-3' })
  })

  it('returns all recent messages when q is empty', async () => {
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/search',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThanOrEqual(3)
  })

  it('filters by phone substring', async () => {
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/search?q=5511111',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as Array<{ to: string }>
    expect(data.every((m) => m.to.includes('5511111'))).toBe(true)
  })

  it('returns at most 20 items', async () => {
    // Seed 25 more messages
    for (let i = 0; i < 25; i++) {
      ctx.queue.enqueue({
        to: `55${String(i).padStart(13, '0')}`,
        body: 'pad',
        idempotencyKey: `bulk-${i}`,
      })
    }
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/search',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as unknown[]
    expect(data.length).toBeLessThanOrEqual(20)
  })

  it('returns id, to, status, createdAt fields', async () => {
    const res = await ctx.server.inject({
      method: 'GET',
      url: '/api/v1/messages/search?q=5511111',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as Array<Record<string, unknown>>
    expect(data.length).toBeGreaterThan(0)
    const first = data[0]
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('to')
    expect(first).toHaveProperty('status')
    expect(first).toHaveProperty('createdAt')
  })
})

// ── Device search tests ────────────────────────────────────────────────────

describe('GET /api/v1/devices/search', () => {
  const mockDevices = [
    { serial: 'ABC123DEF', type: 'device' },
    { serial: 'XYZ789GHI', type: 'device' },
    { serial: 'OFFLINE001', type: 'offline' },
  ]

  it('returns all devices when q is empty', async () => {
    const { server } = buildDeviceServer(mockDevices)
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/search',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as unknown[]
    expect(data.length).toBe(3)
  })

  it('filters by serial substring (case-insensitive)', async () => {
    const { server } = buildDeviceServer(mockDevices)
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/search?q=abc',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as Array<{ serial: string; status: string }>
    expect(data.length).toBe(1)
    expect(data[0].serial).toBe('ABC123DEF')
    expect(data[0].status).toBe('online')
  })

  it('maps type=device to status=online', async () => {
    const { server } = buildDeviceServer([{ serial: 'DEV001', type: 'device' }])
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/search?q=DEV001',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as Array<{ status: string }>
    expect(data[0].status).toBe('online')
  })

  it('returns at most 20 devices', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      serial: `DEV${String(i).padStart(3, '0')}`,
      type: 'device',
    }))
    const { server } = buildDeviceServer(many)
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/devices/search',
    })
    expect(res.statusCode).toBe(200)
    const data = res.json() as unknown[]
    expect(data.length).toBeLessThanOrEqual(20)
  })
})
