import { describe, it, expect } from 'vitest'
import {
  DISPATCH_SDK_VERSION,
  isSdkCompatible,
  validateManifest,
  type PluginManifest,
} from './manifest.js'

describe('isSdkCompatible', () => {
  it.each<[string, string, boolean]>([
    ['exact match', '1.0.0', true],
    ['exact mismatch', '2.0.0', false],
    ['caret same major', '^1.0.0', true],
    ['caret different major', '^2.0.0', false],
    ['tilde same minor', '~1.0.5', true],
    ['tilde different minor', '~1.1.0', false],
    ['wildcard 1.x', '1.x', true],
    ['wildcard 2.x', '2.x', false],
    ['wildcard 1.*', '1.*', true],
    ['bare major 1', '1', true],
    ['bare major 2', '2', false],
    ['malformed', 'not-a-version', false],
    ['empty', '', false],
  ])('host=1.0.0 vs range "%s" → %s (%s)', (_label, range, expected) => {
    expect(isSdkCompatible(range, '1.0.0')).toBe(expected)
  })
})

describe('validateManifest', () => {
  const valid: PluginManifest = {
    name: 'oralsin',
    version: '1.2.3',
    sdkVersion: '^1.0.0',
    description: 'Oralsin debt collection adapter',
  }

  it('accepts a well-formed manifest', () => {
    const r = validateManifest(valid)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.name).toBe('oralsin')
  })

  it('rejects missing required field', () => {
    const r = validateManifest({ ...valid, version: undefined })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_schema')
  })

  it('rejects when name does not match expected', () => {
    const r = validateManifest(valid, 'different-plugin')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('name_mismatch')
      expect(r.detail).toContain('oralsin')
    }
  })

  it('rejects when sdkVersion is incompatible major', () => {
    const r = validateManifest({ ...valid, sdkVersion: '^2.0.0' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('sdk_incompatible')
    }
  })

  it('accepts when sdkVersion is compatible caret', () => {
    const r = validateManifest({ ...valid, sdkVersion: '^1.999.0' })
    expect(r.ok).toBe(true)
  })

  it('rejects extra long description', () => {
    const r = validateManifest({ ...valid, description: 'x'.repeat(501) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid_schema')
  })

  it('respects custom hostSdkVersion override', () => {
    const r = validateManifest({ ...valid, sdkVersion: '^2.0.0' }, undefined, '2.0.0')
    expect(r.ok).toBe(true)
  })

  it('DISPATCH_SDK_VERSION is exported and major is positive integer', () => {
    expect(DISPATCH_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
