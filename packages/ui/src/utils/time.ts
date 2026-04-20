/**
 * Formats an ISO timestamp as a relative time string in Portuguese.
 *
 * - < 60s  -> "agora"
 * - < 60m  -> "ha X min"
 * - < 24h  -> "ha X h"
 * - >= 24h -> "DD/MM/YYYY HH:mm"
 */
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = Date.now()
  const diffMs = now - date.getTime()

  if (diffMs < 0) return 'agora'

  const diffSeconds = Math.floor(diffMs / 1000)
  if (diffSeconds < 60) return 'agora'

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) return `h\u00e1 ${diffMinutes} min`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `h\u00e1 ${diffHours} h`

  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = date.getFullYear()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${day}/${month}/${year} ${hours}:${minutes}`
}
