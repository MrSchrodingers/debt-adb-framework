import { z } from 'zod'

/**
 * Current Dispatch Plugin SDK version. Bump MAJOR when the plugin contract
 * breaks (e.g., field renamed in DispatchPlugin or PluginContext). Bump MINOR
 * when the contract adds new optional fields plugins can ignore. Plugins
 * declare a semver range in `manifest.sdkVersion`; loader rejects on major
 * mismatch and warns on minor lag.
 */
export const DISPATCH_SDK_VERSION = '1.0.0'

/**
 * Declarative metadata about a plugin. Optional on `DispatchPlugin` — plugins
 * without a manifest still load (backwards compat) but emit a warning and
 * cannot opt into reload/admin features.
 */
export interface PluginManifest {
  /** Plugin identifier — must match DispatchPlugin.name. */
  name: string
  /** Plugin version (semver). */
  version: string
  /**
   * Dispatch SDK range the plugin is built against (semver range).
   * Examples: "^1.0.0", "~1.2", "1.x". Loader rejects when host SDK major
   * doesn't satisfy the declared range.
   */
  sdkVersion: string
  /** Short, human-readable summary for the admin UI. */
  description: string
  /** Optional author or maintainer string. */
  author?: string
}

const manifestSchema = z.object({
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(32),
  sdkVersion: z.string().min(1).max(32),
  description: z.string().min(1).max(500),
  author: z.string().min(1).max(200).optional(),
})

export interface ManifestValidationOk {
  ok: true
  manifest: PluginManifest
}

export interface ManifestValidationError {
  ok: false
  reason: 'invalid_schema' | 'sdk_incompatible' | 'name_mismatch'
  detail: string
}

export type ManifestValidationResult = ManifestValidationOk | ManifestValidationError

/**
 * Validate a plugin manifest:
 *  - Conforms to the Zod schema (required fields, length limits)
 *  - SDK version range satisfies the current host SDK major
 *  - `name` matches the plugin's declared `name` (when expected provided)
 */
export function validateManifest(
  candidate: unknown,
  expectedName?: string,
  hostSdkVersion: string = DISPATCH_SDK_VERSION,
): ManifestValidationResult {
  const parsed = manifestSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }

  const manifest = parsed.data

  if (expectedName && manifest.name !== expectedName) {
    return {
      ok: false,
      reason: 'name_mismatch',
      detail: `manifest.name="${manifest.name}" does not match plugin.name="${expectedName}"`,
    }
  }

  if (!isSdkCompatible(manifest.sdkVersion, hostSdkVersion)) {
    return {
      ok: false,
      reason: 'sdk_incompatible',
      detail: `manifest requires sdk "${manifest.sdkVersion}" but host runs "${hostSdkVersion}"`,
    }
  }

  return { ok: true, manifest }
}

/**
 * Minimal semver-range satisfiability check. Supports:
 *  - exact: "1.0.0" — host must equal
 *  - caret: "^1.0.0" — host major must equal (semver compatible-with-caret)
 *  - tilde: "~1.2.0" — host major.minor must equal
 *  - wildcard: "1.x", "1.*" — host major must equal
 *  - bare major: "1" — host major must equal
 *
 * NOT a full semver implementation — sufficient for plugin SDK gating where
 * a single MAJOR contract version is in flight at a time. We add `semver`
 * as a direct dep when we need richer ranges (multi-major windows).
 */
export function isSdkCompatible(pluginRange: string, hostVersion: string): boolean {
  const hostMajor = parseMajor(hostVersion)
  const hostMinor = parseMinor(hostVersion)
  if (hostMajor === null) return false

  const trimmed = pluginRange.trim()

  // Exact "1.0.0"
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) {
    return trimmed === hostVersion
  }

  // Caret "^1.0.0" — major must match
  if (trimmed.startsWith('^')) {
    const m = parseMajor(trimmed.slice(1))
    return m === hostMajor
  }

  // Tilde "~1.2.0" — major + minor must match
  if (trimmed.startsWith('~')) {
    const m = parseMajor(trimmed.slice(1))
    const mn = parseMinor(trimmed.slice(1))
    return m === hostMajor && mn === hostMinor
  }

  // Wildcards "1.x" / "1.*" / "1"
  const wildMatch = /^(\d+)(?:\.[x*])?$/.exec(trimmed)
  if (wildMatch) {
    return parseInt(wildMatch[1]!, 10) === hostMajor
  }

  return false
}

function parseMajor(v: string): number | null {
  const m = /^(\d+)/.exec(v.trim())
  return m ? parseInt(m[1]!, 10) : null
}

function parseMinor(v: string): number | null {
  const m = /^\d+\.(\d+)/.exec(v.trim())
  return m ? parseInt(m[1]!, 10) : null
}
