/**
 * Bloatware package list applied during hygienize.
 *
 * Categories:
 *   - SAFE: removable on every profile, no side-effects on WhatsApp/contacts
 *   - RISKY: removing may break sign-in/system services — opt-in via
 *     `DISPATCH_HYGIENE_AGGRESSIVE=true`.
 *
 * Reasoning: `pm uninstall -k --user N <pkg>` returns "Success" when the
 * package was removed for that profile. For pre-installed system apps the
 * call sometimes succeeds but the app is reinstalled at next factory reset.
 * We surface the *runtime* presence at the end of hygienize via
 * `pm list packages --user N` to detect packages that survived (e.g. signed
 * with platform key).
 */
export const BLOAT_PACKAGES_SAFE = [
  // Facebook family
  'com.facebook.appmanager',
  'com.facebook.services',
  'com.facebook.system',

  // Amazon
  'com.amazon.appmanager',

  // Google bloat (heavy, removable per-user)
  'com.google.android.apps.youtube.music',
  'com.google.android.youtube',
  'com.google.android.apps.maps',
  'com.google.android.apps.photosgo',
  'com.google.android.apps.walletnfcrel',
  'com.android.chrome',
  'com.google.android.apps.docs',
  'com.google.android.apps.messaging',
  'com.google.android.apps.nbu.files',
  'com.google.android.apps.restore',
  'com.google.android.apps.safetyhub',
  'com.google.android.apps.searchlite',
  'com.google.android.apps.subscriptions.red',
  'com.google.android.apps.tachyon', // Meet / Google Duo
  'com.google.android.apps.wellbeing',
  'com.google.android.feedback',
  'com.google.android.gm', // Gmail
  'com.google.android.marvin.talkback',
  'com.google.android.videos', // Google TV
  'com.google.android.safetycore',
  'com.google.android.gms.supervision',
  'com.google.android.googlequicksearchbox', // "Google" app + Assistant
  'com.google.android.tts',
  'com.google.android.calendar',

  // MIUI / Xiaomi bloat
  'com.miui.android.fashiongallery',
  'com.miui.gameCenter.overlay',
  'com.miui.calculator.go',
  'com.miui.analytics.go',
  'com.miui.bugreport',
  'com.miui.cleaner.go',
  'com.miui.msa.global',
  'com.miui.qr',
  'com.miui.theme.lite',
  'com.miui.videoplayer',
  'com.miui.player', // "Música"
  'com.miui.notes',
  'com.miui.weather2',
  'com.miui.compass',
  'com.miui.cameratools',
  'com.miui.touchassistant',
  'com.xiaomi.discover',
  'com.xiaomi.mipicks',
  'com.xiaomi.scanner',
  'com.xiaomi.glgm',
  'com.mi.globalminusscreen',

  // Unisoc / generic Android bloat
  'com.unisoc.phone',
  'com.android.mms.service',
  'com.android.calendar.go',
  'com.android.fmradio',
  'com.android.emergency',
  'com.go.browser',
] as const

/**
 * RISKY packages — removed only when DISPATCH_HYGIENE_AGGRESSIVE=true.
 * Some are flagged because they CAN break Google sign-in (gms.auth) or
 * hardware features (securitycenter on POCO C71).
 */
export const BLOAT_PACKAGES_RISKY = [
  'com.miui.securitycenter',
  // gms.auth is intentionally excluded — disabling it kills WA registration
] as const

export interface BloatListOptions {
  aggressive?: boolean
}

export function getBloatPackages(opts: BloatListOptions = {}): string[] {
  if (opts.aggressive) {
    return [...BLOAT_PACKAGES_SAFE, ...BLOAT_PACKAGES_RISKY]
  }
  return [...BLOAT_PACKAGES_SAFE]
}

/**
 * Patterns used by the post-hygiene verification grep. We surface what
 * SHOULD have been removed but is still resolvable via
 * `pm list packages --user N`.
 *
 * NOTE: this is informational — system-signed packages may be reported as
 * still installed even when the per-user uninstall succeeded.
 */
export const BLOAT_GREP_PATTERNS = [
  'youtube',
  'gmail',
  'gms.supervision',
  'tachyon',
  'miui.player',
  'miui.videoplayer',
  'miui.notes',
  'miui.weather',
  'fashiongallery',
  'mipicks',
] as const
