import type { ChatwootApiClient, ChatwootConfig, ChatwootInbox } from './types.js'

export function createChatwootHttpClient(config: ChatwootConfig): ChatwootApiClient {
  const baseUrl = `${config.apiUrl}/api/v1/accounts/${config.accountId}`
  const headers: Record<string, string> = { api_access_token: config.apiToken }

  async function jsonOrThrow<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Chatwoot API ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async listInboxes() {
      const res = await fetch(`${baseUrl}/inboxes`, { headers })
      const data = await jsonOrThrow<{ payload: ChatwootInbox[] }>(res)
      return data.payload
    },

    async createInbox(name) {
      const res = await fetch(`${baseUrl}/inboxes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, channel: { type: 'api' } }),
      })
      return jsonOrThrow<ChatwootInbox>(res)
    },

    async getInbox(id) {
      const res = await fetch(`${baseUrl}/inboxes/${id}`, { headers })
      return jsonOrThrow<ChatwootInbox>(res)
    },
  }
}
