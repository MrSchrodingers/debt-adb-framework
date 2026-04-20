import { jsonOrThrow } from '../http-utils.js'
import type { ChatwootApiClient, ChatwootConfig, ChatwootInbox } from './types.js'

const PREFIX = 'Chatwoot API'

export function createChatwootHttpClient(config: ChatwootConfig): ChatwootApiClient {
  const baseUrl = `${config.apiUrl}/api/v1/accounts/${config.accountId}`
  const headers: Record<string, string> = { api_access_token: config.apiToken }

  return {
    async listInboxes() {
      const res = await fetch(`${baseUrl}/inboxes`, { headers })
      const data = await jsonOrThrow<{ payload: ChatwootInbox[] }>(res, PREFIX)
      return data.payload
    },

    async createInbox(name) {
      const res = await fetch(`${baseUrl}/inboxes`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, channel: { type: 'api' } }),
      })
      return jsonOrThrow<ChatwootInbox>(res, PREFIX)
    },

    async getInbox(id) {
      const res = await fetch(`${baseUrl}/inboxes/${id}`, { headers })
      return jsonOrThrow<ChatwootInbox>(res, PREFIX)
    },
  }
}
