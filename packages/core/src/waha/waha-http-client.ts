import type { WahaApiClient, WahaSessionInfo, WahaWebhookConfig } from './types.js'

export function createWahaHttpClient(apiUrl: string, apiKey: string): WahaApiClient {
  const headers = { 'X-Api-Key': apiKey }

  async function jsonOrThrow<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`WAHA API ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async listSessions() {
      const res = await fetch(`${apiUrl}/api/sessions`, { headers })
      return jsonOrThrow<WahaSessionInfo[]>(res)
    },

    async getSession(name) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}`, { headers })
      return jsonOrThrow<WahaSessionInfo>(res)
    },

    async updateSessionWebhooks(name, webhooks) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { webhooks } }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`WAHA API ${res.status}: ${body}`)
      }
    },

    async restartSession(name) {
      const res = await fetch(`${apiUrl}/api/sessions/${encodeURIComponent(name)}/restart`, {
        method: 'POST',
        headers,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`WAHA API ${res.status}: ${body}`)
      }
    },

    async getServerVersion() {
      const res = await fetch(`${apiUrl}/api/server/version`, { headers })
      return jsonOrThrow<{ version: string; engine: string; tier: string }>(res)
    },

    async downloadMedia(fileUrl) {
      const res = await fetch(fileUrl, { headers })
      if (!res.ok) {
        throw new Error(`WAHA media download ${res.status}`)
      }
      return Buffer.from(await res.arrayBuffer())
    },
  }
}
