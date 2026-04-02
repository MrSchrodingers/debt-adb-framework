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
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}/qr`, { headers })
      const data = await jsonOrThrow<{ qr: string }>(res, PREFIX)
      return data.qr
    },
  }
}
