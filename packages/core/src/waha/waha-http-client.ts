import { jsonOrThrow, assertOk } from '../http-utils.js'
import type { WahaApiClient, WahaSessionInfo, WahaWebhookConfig } from './types.js'

const PREFIX = 'WAHA API'

export function createWahaHttpClient(apiUrl: string, apiKey: string): WahaApiClient {
  const headers = { 'X-Api-Key': apiKey }

  return {
    async listSessions() {
      const res = await fetch(`${apiUrl}/api/sessions`, { headers })
      return jsonOrThrow<WahaSessionInfo[]>(res, PREFIX)
    },

    async getSession(name) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}`, { headers })
      return jsonOrThrow<WahaSessionInfo>(res, PREFIX)
    },

    async updateSessionWebhooks(name, webhooks) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { webhooks } }),
      })
      await assertOk(res, PREFIX)
    },

    async restartSession(name) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}/restart`, {
        method: 'POST',
        headers,
      })
      await assertOk(res, PREFIX)
    },

    async stopSession(name) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}/stop`, {
        method: 'POST',
        headers,
      })
      await assertOk(res, PREFIX)
    },

    async getServerVersion() {
      const res = await fetch(`${apiUrl}/api/server/version`, { headers })
      return jsonOrThrow<{ version: string; engine: string; tier: string }>(res, PREFIX)
    },

    async downloadMedia(fileUrl) {
      const res = await fetch(fileUrl, { headers })
      await assertOk(res, `${PREFIX} media download`)
      return Buffer.from(await res.arrayBuffer())
    },

    async getQrCode(name) {
      // GoWS WAHA Plus uses /api/{session}/auth/qr (returns PNG binary)
      const res = await fetch(`${apiUrl}/api/${encodeURIComponent(name)}/auth/qr`, { headers })
      if (!res.ok) throw new Error(`${PREFIX} ${res.status}: QR code not available for session ${name}`)
      const buf = Buffer.from(await res.arrayBuffer())
      // Return as base64 data URI for direct use in <img src>
      return `data:image/png;base64,${buf.toString('base64')}`
    },

    async checkExists(session, phone) {
      // WAHA Plus: POST /api/checkExists with { session, phone }
      // Returns { numberExists: boolean, chatId?: string | null }
      const res = await fetch(`${apiUrl}/api/checkExists`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session, phone }),
      })
      if (res.status === 404) return { numberExists: false, chatId: null }
      return jsonOrThrow<{ numberExists: boolean; chatId?: string | null }>(res, PREFIX)
    },
  }
}
