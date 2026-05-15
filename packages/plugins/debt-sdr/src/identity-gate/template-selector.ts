import { createHash } from 'node:crypto'

/**
 * Deterministic template picker. Same (phone, salt) → same template
 * index. Used by the identity gate so a given contact always sees the
 * same handshake variation (avoids the spam-tell of swapping wording
 * mid-thread).
 *
 * The salt slot accepts a tenant name when callers want to vary across
 * tenants — without a salt, oralsin and sicoob would otherwise pick
 * the same template index for the same phone.
 */
export function selectTemplate(pool: readonly string[], contactPhone: string, salt = ''): string {
  if (pool.length === 0) throw new Error('selectTemplate: empty template pool')
  const hash = createHash('sha256').update(salt + contactPhone).digest('hex').slice(0, 8)
  const idx = parseInt(hash, 16) % pool.length
  return pool[idx]
}

/**
 * Substitute `{name}` placeholders. Unknown placeholders are left in
 * place so a missing variable shows up in the outbound text (and in
 * audit) as `{whatever}` instead of the literal string `undefined`.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`)
}
