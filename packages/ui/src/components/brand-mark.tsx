import logoUrl from '../assets/debt-logo-verde.webp'

interface BrandMarkProps {
  /** Logo height in px. Width auto-scales (logo aspect ratio is ~4:1). */
  size?: number
  /** Show the "ADB DISPATCHER" wordmark next to the logo. */
  withWordmark?: boolean
  /** Layout direction. Default 'row' for sidebar/headers, 'col' for login screen. */
  layout?: 'row' | 'col'
  className?: string
}

/**
 * DEBT brand mark. Uses the official "Logo Verde" with a thin glow ring
 * to lift it from the dark backdrop.
 */
export function BrandMark({ size = 28, withWordmark = true, layout = 'row', className = '' }: BrandMarkProps) {
  const wrapperLayout = layout === 'col'
    ? 'flex flex-col items-center gap-3'
    : 'flex items-center gap-3'

  const wordmarkLayout = layout === 'col'
    ? 'flex flex-col items-center gap-1 mt-1'
    : 'flex flex-col gap-0.5'

  return (
    <div className={`${wrapperLayout} ${className}`}>
      <div
        className="relative inline-flex items-center justify-center"
        style={{ height: size, width: 'auto' }}
      >
        <span
          aria-hidden
          className="absolute inset-0 -m-2 rounded-full bg-brand-500/20 blur-xl"
        />
        <img
          src={logoUrl}
          alt="DEBT"
          height={size}
          style={{ height: size, width: 'auto' }}
          className="relative drop-shadow-[0_0_24px_rgba(60,194,92,0.25)]"
        />
      </div>
      {withWordmark && (
        <div className={wordmarkLayout}>
          <span
            className="font-display text-[0.62rem] uppercase tracking-[0.32em] text-brand-300/90"
          >
            ADB Dispatcher
          </span>
          {layout === 'col' && (
            <span className="font-mono text-[0.65rem] text-white/30">
              v0.1 · headless multi-device
            </span>
          )}
        </div>
      )}
    </div>
  )
}
