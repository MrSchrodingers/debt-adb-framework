import { describe, it, expect } from 'vitest'
import {
  BLOAT_PACKAGES_SAFE,
  BLOAT_PACKAGES_RISKY,
  BLOAT_GREP_PATTERNS,
  getBloatPackages,
} from './bloat-list.js'

describe('bloat-list', () => {
  it('SAFE list contains the user-reported bloatware', () => {
    // From the user feedback: "ainda tem Gmail, Google, Google TV, Meet,
    // Mi Video, Música, Security, YouTube"
    expect(BLOAT_PACKAGES_SAFE).toContain('com.google.android.gm') // Gmail
    expect(BLOAT_PACKAGES_SAFE).toContain('com.google.android.googlequicksearchbox') // "Google" app
    expect(BLOAT_PACKAGES_SAFE).toContain('com.google.android.videos') // Google TV
    expect(BLOAT_PACKAGES_SAFE).toContain('com.google.android.apps.tachyon') // Meet
    expect(BLOAT_PACKAGES_SAFE).toContain('com.miui.videoplayer') // Mi Video
    expect(BLOAT_PACKAGES_SAFE).toContain('com.miui.player') // Música
    expect(BLOAT_PACKAGES_SAFE).toContain('com.google.android.youtube') // YouTube
  })

  it('SAFE list contains MIUI extras flagged by user', () => {
    expect(BLOAT_PACKAGES_SAFE).toContain('com.miui.notes')
    expect(BLOAT_PACKAGES_SAFE).toContain('com.miui.weather2')
    expect(BLOAT_PACKAGES_SAFE).toContain('com.miui.compass')
  })

  it('RISKY list excludes gms.auth (would break WA registration)', () => {
    expect(BLOAT_PACKAGES_RISKY).not.toContain('com.google.android.gms.auth')
  })

  it('getBloatPackages defaults to SAFE only', () => {
    const list = getBloatPackages()
    expect(list).toEqual([...BLOAT_PACKAGES_SAFE])
  })

  it('getBloatPackages with aggressive=true includes RISKY', () => {
    const list = getBloatPackages({ aggressive: true })
    expect(list.length).toBe(BLOAT_PACKAGES_SAFE.length + BLOAT_PACKAGES_RISKY.length)
    for (const pkg of BLOAT_PACKAGES_RISKY) {
      expect(list).toContain(pkg)
    }
  })

  it('BLOAT_GREP_PATTERNS covers the main user-visible bloat', () => {
    expect(BLOAT_GREP_PATTERNS).toContain('youtube')
    expect(BLOAT_GREP_PATTERNS).toContain('gmail')
    expect(BLOAT_GREP_PATTERNS).toContain('miui.player')
    expect(BLOAT_GREP_PATTERNS).toContain('miui.videoplayer')
  })
})
