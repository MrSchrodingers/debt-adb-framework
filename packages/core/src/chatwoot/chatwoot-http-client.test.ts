import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createChatwootHttpClient } from './chatwoot-http-client.js'
import type { ChatwootApiClient, ChatwootConfig } from './types.js'

describe('ChatwootHttpClient', () => {
  let client: ChatwootApiClient
  const config: ChatwootConfig = {
    apiUrl: 'https://chat.debt.com.br',
    accountId: 1,
    apiToken: 'test-token-123',
  }

  beforeEach(() => {
    client = createChatwootHttpClient(config)
    vi.restoreAllMocks()
  })

  describe('listInboxes', () => {
    it('fetches inboxes from Chatwoot API with correct auth header', async () => {
      const mockInboxes = [
        { id: 175, name: 'Oralsin 1-2', channel_type: 'api', inbox_identifier: 'BPwVxtANpvAzddkwr5BN3eLj' },
        { id: 176, name: 'Oralsin 1-3', channel_type: 'api', inbox_identifier: 'abc123' },
      ]
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ payload: mockInboxes }), { status: 200 }),
      )

      const result = await client.listInboxes()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://chat.debt.com.br/api/v1/accounts/1/inboxes',
        expect.objectContaining({
          headers: expect.objectContaining({ api_access_token: 'test-token-123' }),
        }),
      )
      expect(result).toEqual(mockInboxes)
    })

    it('throws on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      )

      await expect(client.listInboxes()).rejects.toThrow('Chatwoot API 401')
    })
  })

  describe('createInbox', () => {
    it('creates API inbox with correct payload', async () => {
      const mockInbox = { id: 200, name: 'Dispatch — 554396835104', channel_type: 'api', inbox_identifier: 'xyz789' }
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockInbox), { status: 200 }),
      )

      const result = await client.createInbox('Dispatch — 554396835104')

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://chat.debt.com.br/api/v1/accounts/1/inboxes',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            api_access_token: 'test-token-123',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ name: 'Dispatch — 554396835104', channel: { type: 'api' } }),
        }),
      )
      expect(result).toEqual(mockInbox)
    })

    it('throws on creation failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Name already taken', { status: 422 }),
      )

      await expect(client.createInbox('Duplicate')).rejects.toThrow('Chatwoot API 422')
    })
  })

  describe('getInbox', () => {
    it('fetches single inbox by ID', async () => {
      const mockInbox = { id: 175, name: 'Oralsin 1-2', channel_type: 'api' }
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(mockInbox), { status: 200 }),
      )

      const result = await client.getInbox(175)

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://chat.debt.com.br/api/v1/accounts/1/inboxes/175',
        expect.objectContaining({
          headers: expect.objectContaining({ api_access_token: 'test-token-123' }),
        }),
      )
      expect(result).toEqual(mockInbox)
    })

    it('throws on 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Not found', { status: 404 }),
      )

      await expect(client.getInbox(999)).rejects.toThrow('Chatwoot API 404')
    })
  })
})
