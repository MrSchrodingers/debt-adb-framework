import { describe, it, expect } from 'vitest'
import { routeResponse } from './response-router.js'

describe('routeResponse — G5 tenant tightening', () => {
  it('delivers when both sender and msg are legacy (no tenant)', () => {
    const r = routeResponse({
      outgoingMessageId: 'm1',
      message: { pluginName: 'oralsin', tenantHint: null },
      senderTenant: null,
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(true)
  })

  it('delivers when sender tenant matches msg tenantHint', () => {
    const r = routeResponse({
      outgoingMessageId: 'm2',
      message: { pluginName: 'debt-sdr', tenantHint: 'oralsin-sdr' },
      senderTenant: 'oralsin-sdr',
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(true)
  })

  it('delivers when sender has tenant but msg.tenantHint is null', () => {
    const r = routeResponse({
      outgoingMessageId: 'm3',
      message: { pluginName: 'debt-sdr', tenantHint: null },
      senderTenant: 'oralsin-sdr',
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(true)
  })

  it('delivers when msg has tenantHint but sender has no tenant (legacy)', () => {
    const r = routeResponse({
      outgoingMessageId: 'm4',
      message: { pluginName: 'debt-sdr', tenantHint: 'oralsin-sdr' },
      senderTenant: null,
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(true)
  })

  it('drops when sender tenant differs from msg tenantHint', () => {
    const r = routeResponse({
      outgoingMessageId: 'm5',
      message: { pluginName: 'debt-sdr', tenantHint: 'oralsin-sdr' },
      senderTenant: 'sicoob-sdr',
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(false)
    if (!r.deliver && r.reason === 'tenant_mismatch') {
      expect(r.sender_tenant).toBe('sicoob-sdr')
      expect(r.msg_tenant).toBe('oralsin-sdr')
    }
  })

  it('bypasses strict check when feature flag is "false"', () => {
    const r = routeResponse({
      outgoingMessageId: 'm6',
      message: { pluginName: 'debt-sdr', tenantHint: 'oralsin-sdr' },
      senderTenant: 'sicoob-sdr',
      strictTenantFlag: 'false',
    })
    expect(r.deliver).toBe(true)
  })

  it('drops when no outgoing message id (no_history)', () => {
    const r = routeResponse({
      outgoingMessageId: null,
      message: { pluginName: 'x', tenantHint: null },
      senderTenant: null,
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(false)
    if (!r.deliver) expect(r.reason).toBe('no_history')
  })

  it('drops when queue lookup returns null (no_message)', () => {
    const r = routeResponse({
      outgoingMessageId: 'm7',
      message: null,
      senderTenant: null,
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(false)
    if (!r.deliver) expect(r.reason).toBe('no_message')
  })

  it('drops when message has no pluginName (no_plugin)', () => {
    const r = routeResponse({
      outgoingMessageId: 'm8',
      message: { pluginName: null, tenantHint: null },
      senderTenant: null,
      strictTenantFlag: undefined,
    })
    expect(r.deliver).toBe(false)
    if (!r.deliver) expect(r.reason).toBe('no_plugin')
  })

  it('strict bypass also returns deliver=true for legacy/legacy', () => {
    const r = routeResponse({
      outgoingMessageId: 'm9',
      message: { pluginName: 'x', tenantHint: null },
      senderTenant: null,
      strictTenantFlag: 'false',
    })
    expect(r.deliver).toBe(true)
  })
})
