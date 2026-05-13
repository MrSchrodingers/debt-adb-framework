import { DeckGL } from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { interpolateViridis, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import { useMemo } from 'react'
import type { DddTopology, GeoPalette } from './geo.types.js'

export interface BrazilMapDDDProps {
  topology: DddTopology
  buckets: Record<string, number>
  palette: GeoPalette
  onDddClick: (ddd: string) => void
  max?: number
}

const INITIAL_VIEW_STATE = {
  longitude: -53, latitude: -14, zoom: 3.4,
  minZoom: 2, maxZoom: 8, pitch: 0, bearing: 0,
}

export function BrazilMapDDD(props: BrazilMapDDDProps) {
  const { topology, buckets, palette, onDddClick } = props
  const max = props.max ?? Math.max(1, ...Object.values(buckets))
  const colorFn = paletteToColorFn(palette)

  /**
   * Quantile rank scale: DDDs are ranked by count; color t = rank / (n-1).
   * This gives full color spread regardless of distribution skew. With linear
   * scaling, a few DDDs dominate (~82) while the rest sit near 0, washing
   * out as near-purple. Quantile makes every DDD visually distinct.
   */
  const tForCount = useMemo(() => {
    const sorted = Object.values(buckets).filter(c => c > 0).sort((a, b) => a - b)
    if (sorted.length === 0) return () => 0
    const rankOf = new Map<number, number>()
    for (let i = 0; i < sorted.length; i++) {
      // Average rank for ties — denominator = n-1 so max maps to 1.0
      const value = sorted[i]!
      if (!rankOf.has(value)) {
        const t = sorted.length === 1 ? 1 : i / (sorted.length - 1)
        rankOf.set(value, t)
      }
    }
    return (count: number) => rankOf.get(count) ?? 0
  }, [buckets])

  const layer = useMemo(() => new GeoJsonLayer({
    id: 'br-ddd-choropleth',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: topology.features as any,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthMinPixels: 1.2,
    getLineColor: [180, 180, 195, 220] as [number, number, number, number],
    getFillColor: (f: object) => {
      const feat = f as { properties?: { description?: number | string } }
      const rawDdd = feat?.properties?.description
      if (rawDdd === undefined || rawDdd === null) return [60, 60, 70, 140]
      const ddd = String(Math.trunc(Number(rawDdd)))
      const count = buckets[ddd] ?? 0
      if (count === 0) return [50, 52, 60, 130] as [number, number, number, number]
      const t = tForCount(count)
      const [r, g, b] = parseRgb(colorFn(t))
      return [r, g, b, 230] as [number, number, number, number]
    },
    updateTriggers: { getFillColor: [buckets, max, palette, tForCount] },
    onClick: (info) => {
      const f = info.object as { properties?: { description?: number | string } } | undefined
      const rawDdd = f?.properties?.description
      if (rawDdd === undefined || rawDdd === null) return
      onDddClick(String(Math.trunc(Number(rawDdd))))
    },
  }), [topology, buckets, max, palette, onDddClick, colorFn, tForCount])

  return (
    <div className="relative w-full h-[620px] rounded-lg border border-zinc-800 overflow-hidden bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={[layer]}
        style={{ position: 'absolute', inset: '0' }}
        getTooltip={({ object }) => {
          const f = object as { properties?: { description?: number | string } } | undefined
          const rawDdd = f?.properties?.description
          if (rawDdd === undefined || rawDdd === null) return null
          const ddd = String(Math.trunc(Number(rawDdd)))
          const count = buckets[ddd] ?? 0
          return {
            html: `<div style="padding:8px 12px;font-size:12px;line-height:1.4"><div style="opacity:.7;font-size:10px">DDD</div><div style="font-size:18px;font-weight:600;letter-spacing:.5px">${ddd}</div><div style="margin-top:4px"><b>${count.toLocaleString('pt-BR')}</b> ${count === 1 ? 'registro' : 'registros'}</div></div>`,
            style: { background: 'rgba(15,15,18,0.97)', color: '#fff', border: '1px solid #555', borderRadius: '6px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)' },
          }
        }}
      />
    </div>
  )
}

function paletteToColorFn(p: GeoPalette): (t: number) => string {
  if (p === 'rate') return interpolateRdYlGn
  if (p === 'diverging') return interpolatePuOr
  return interpolateViridis
}

/**
 * Parse d3-scale-chromatic's color output. Newer versions return hex
 * (#rrggbb), some interpolators / older versions return rgb(r,g,b).
 * Support both — falling through to magenta makes any future format
 * change obvious instead of silently rendering everything as black.
 */
function parseRgb(input: string): [number, number, number] {
  // Hex form: "#rrggbb"
  const hex = input.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hex) {
    return [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)]
  }
  // Shorthand hex: "#rgb"
  const hex3 = input.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (hex3) {
    return [
      parseInt(hex3[1]! + hex3[1]!, 16),
      parseInt(hex3[2]! + hex3[2]!, 16),
      parseInt(hex3[3]! + hex3[3]!, 16),
    ]
  }
  // rgb()/rgba() form
  const rgb = input.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (rgb) {
    return [parseInt(rgb[1]!, 10), parseInt(rgb[2]!, 10), parseInt(rgb[3]!, 10)]
  }
  // Loud fallback (magenta) — never silently render as black again.
  return [255, 0, 255]
}
