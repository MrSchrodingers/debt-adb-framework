/**
 * Task 10.4 — Replay film-strip.
 *
 * Renders inside the MessageTimeline drawer (below the event list).
 * The Phase 7.1 API provides a single screenshot per message (screenshotPath /
 * screenshot.url). There is no per-event screenshot yet — the limitation is
 * documented in the component and a NOTE comment at the bottom.
 *
 * When a message has a screenshot, it is shown as the only "frame".
 * Navigation buttons are present but only advance within the available frames.
 * Auto-play ticks at 1 Hz across frames.
 *
 * TODO (future): once the backend records per-event screenshots, replace the
 * `frames` array with event-keyed URLs and remove the limitation notice.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Play, Pause, ChevronLeft, ChevronRight, Maximize2, X, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CORE_URL } from '../config'

export interface FilmStripFrame {
  /** Absolute URL (already includes CORE_URL) or null if unavailable. */
  url: string | null
  /** Human-readable label shown below the thumbnail. */
  label: string
}

interface FilmStripProps {
  frames: FilmStripFrame[]
  /** Shown in the strip header. */
  messageId: string
}

export function FilmStrip({ frames, messageId }: FilmStripProps) {
  const { t } = useTranslation()
  const [activeIdx, setActiveIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const availableFrames = frames.filter((f) => f.url !== null)

  // Auto-play tick
  useEffect(() => {
    if (!playing || availableFrames.length <= 1) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    intervalRef.current = setInterval(() => {
      setActiveIdx((prev) => {
        const next = (prev + 1) % availableFrames.length
        if (next === 0) setPlaying(false) // stop at end
        return next
      })
    }, 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [playing, availableFrames.length])

  const goTo = useCallback((idx: number) => {
    setActiveIdx(Math.max(0, Math.min(idx, availableFrames.length - 1)))
    setPlaying(false)
  }, [availableFrames.length])

  if (availableFrames.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-500">
        <Info className="h-4 w-4 shrink-0" />
        <span>{t('filmStrip.noScreenshots')}</span>
      </div>
    )
  }

  const current = availableFrames[activeIdx]
  const frameCount = availableFrames.length

  return (
    <>
      <div className="space-y-3">
        {/* Limitation notice (per-event screenshots not yet in API) */}
        {frames.length === 1 && (
          <div className="flex items-start gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2">
            <Info className="h-3.5 w-3.5 shrink-0 text-zinc-500 mt-0.5" />
            <span className="text-xs leading-relaxed text-zinc-500">{t('filmStrip.limitationNote')}</span>
          </div>
        )}

        {/* Thumbnail strip — only show when there are multiple frames */}
        {frameCount > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {availableFrames.map((frame, idx) => (
              <button
                key={idx}
                onClick={() => goTo(idx)}
                className={`group shrink-0 flex flex-col items-center gap-1 transition ${
                  activeIdx === idx ? 'opacity-100' : 'opacity-60 hover:opacity-100'
                }`}
                title={frame.label}
              >
                <div
                  className={`overflow-hidden rounded-md border-2 transition ${
                    activeIdx === idx
                      ? 'border-emerald-500/70 shadow-[0_0_0_2px_rgba(16,185,129,0.15)]'
                      : 'border-zinc-700/40 group-hover:border-zinc-600'
                  }`}
                >
                  <img
                    src={frame.url!}
                    alt={`${t('filmStrip.frame')} ${idx + 1}`}
                    className="h-24 w-[54px] object-cover bg-zinc-800"
                  />
                </div>
                <span className="block max-w-[60px] truncate text-[10px] text-zinc-500 font-mono">
                  {frame.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Main preview */}
        <div className="relative rounded-xl border border-zinc-700/40 overflow-hidden bg-zinc-950/60">
          <img
            src={current.url!}
            alt={`${t('filmStrip.frame')} ${activeIdx + 1} ${t('filmStrip.of')} ${frameCount}`}
            className="block w-full object-contain max-h-80 mx-auto"
          />

          {/* Expand button */}
          <button
            onClick={() => setExpanded(true)}
            className="absolute top-2 right-2 rounded-lg bg-black/50 border border-white/10 p-1.5 text-white/70 hover:text-white transition"
            title={t('filmStrip.expand')}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>

          {/* Frame counter overlay (only when >1 frame) */}
          {frameCount > 1 && (
            <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/80 font-mono">
              {activeIdx + 1} / {frameCount}
            </div>
          )}
        </div>

        {/* Frame meta line (separated from controls so labels never overlap) */}
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-zinc-400 font-medium truncate">
            {frameCount > 1
              ? `${t('filmStrip.frame')} ${activeIdx + 1} / ${frameCount}`
              : t('filmStrip.singleFrame')}
          </span>
          <span className="text-zinc-500 font-mono truncate" title={messageId}>
            {messageId.slice(0, 12)}…
          </span>
        </div>

        {/* Controls — only render when navigation is meaningful (>1 frame) */}
        {frameCount > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo(activeIdx - 1)}
              disabled={activeIdx === 0}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 p-2 text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
              title={t('filmStrip.prev')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            <button
              onClick={() => setPlaying((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 transition"
            >
              {playing ? (
                <><Pause className="h-3.5 w-3.5" />{t('filmStrip.pause')}</>
              ) : (
                <><Play className="h-3.5 w-3.5" />{t('filmStrip.play')}</>
              )}
            </button>

            <button
              onClick={() => goTo(activeIdx + 1)}
              disabled={activeIdx >= frameCount - 1}
              className="rounded-lg bg-zinc-800 border border-zinc-700/40 p-2 text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition"
              title={t('filmStrip.next')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Expanded modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setExpanded(false)}
        >
          <div className="relative max-w-2xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setExpanded(false)}
              className="absolute -top-10 right-0 text-white/60 hover:text-white transition"
              title={t('filmStrip.close')}
            >
              <X className="h-6 w-6" />
            </button>
            <img
              src={current.url!}
              alt={`Screenshot ${activeIdx + 1} — ${messageId}`}
              className="w-full rounded-xl border border-zinc-700/40 shadow-2xl"
            />
            <p className="text-center text-xs text-white/40 mt-2">{current.label}</p>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Helper: builds FilmStripFrame[] from a MessageTimeline screenshot.
 *
 * Today the API returns one screenshot per message. If the URL is set, we
 * produce a single frame labelled "final". When per-event captures are added
 * to the timeline API, this helper will need to be extended.
 */
export function buildFramesFromScreenshot(
  screenshotUrl: string | null | undefined,
  messageId: string,
): FilmStripFrame[] {
  if (!screenshotUrl) return []
  return [
    {
      url: `${CORE_URL}${screenshotUrl}`,
      label: 'final',
    },
  ]
}
