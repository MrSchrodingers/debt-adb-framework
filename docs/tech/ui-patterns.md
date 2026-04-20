# UI Patterns & Component Guide — Dispatch

> Stack: React 19, Vite 6, Tailwind 4, Recharts 3, lucide-react, socket.io-client

## Project Structure

```
packages/ui/src/
├── App.tsx              # Main layout: sidebar + header + stats + content
├── config.ts            # CORE_URL resolution
├── types.ts             # Shared TypeScript interfaces
├── main.tsx             # React entry point
├── index.css            # Tailwind import only
└── components/
    ├── sidebar.tsx       # Sidebar nav (Dispositivos, Fila, Sessoes)
    ├── stats-bar.tsx     # 4 stat cards (devices, sent, pending, alerts)
    ├── device-grid.tsx   # Clickable device cards with status
    ├── device-detail.tsx # Health metrics + charts + WA accounts + actions
    ├── device-card.tsx   # Single device card (legacy, used in grid)
    ├── device-info.tsx   # System info panel (Android, IP, WA versions)
    ├── live-screen.tsx   # Auto-refreshing device screenshot
    ├── shell-terminal.tsx # Interactive ADB shell
    ├── message-list.tsx  # Message queue list with status icons
    ├── send-form.tsx     # WhatsApp message send form
    ├── alert-panel.tsx   # Severity-sorted alert list
    └── session-manager.tsx # WAHA sessions with search/filter
```

## Core URL

```typescript
// packages/ui/src/config.ts
export const CORE_URL =
  (window as any).__DISPATCH_CORE_URL__  // Electron preload
  ?? import.meta.env.VITE_CORE_URL       // Vite env
  ?? 'http://localhost:7890'              // Default
```

## Data Flow

```
API (REST)           Socket.IO (real-time)
    │                       │
    ▼                       ▼
App.tsx (state)      App.tsx (event listeners)
    │                       │
    ▼                       ▼
Components (props)   setMessages/setDevices/setAlerts
```

## Component Patterns

### Fetching Data
```typescript
const fetchDevices = useCallback(() => {
  fetch(`${CORE_URL}/api/v1/monitor/devices`)
    .then((r) => r.json())
    .then(setDevices)
    .catch(() => {})
}, [])
```

### Socket.IO Events
```typescript
useEffect(() => {
  const socket = io(CORE_URL)
  socket.on('message:sent', (data) => { ... })
  return () => { socket.disconnect() }
}, [deps])
```

### Icon Usage (lucide-react)
```typescript
import { Smartphone, Send, Clock, AlertTriangle } from 'lucide-react'
<Smartphone className="h-4 w-4 text-emerald-400" />
```

### Status Colors
```typescript
const statusConfig = {
  queued:  { color: 'text-zinc-400',    bg: 'bg-zinc-800' },
  locked:  { color: 'text-blue-400',    bg: 'bg-blue-500/10' },
  sending: { color: 'text-amber-400',   bg: 'bg-amber-500/10' },
  sent:    { color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed:  { color: 'text-red-400',     bg: 'bg-red-500/10' },
}
```

### Card Pattern
```tsx
<div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
  <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-blue-400" />
      <h3 className="text-sm font-medium text-zinc-300">Title</h3>
    </div>
    {/* Actions */}
  </div>
  <div className="p-4">
    {/* Content */}
  </div>
</div>
```

### Form Input Pattern
```tsx
<input
  className="w-full rounded-lg bg-zinc-800/80 px-4 py-2.5 text-sm text-zinc-100 border border-zinc-700/60 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 placeholder:text-zinc-600 transition-colors"
/>
```

### Button Variants
```tsx
// Primary (green)
<button className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40">

// Secondary (dark)
<button className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-700">

// Danger (hover red)
<button className="bg-zinc-800 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 border border-zinc-700/40">
```

### Filter Chip Pattern
```tsx
<button className={`rounded-full px-2.5 py-1 text-xs border ${
  active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
         : 'border-zinc-700/40 text-zinc-500 hover:text-zinc-300'
}`}>
```

### Search Bar Pattern
```tsx
<div className="relative flex-1">
  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600" />
  <input className="w-full rounded-lg bg-zinc-800/80 pl-10 pr-3 py-2.5 text-sm ..." />
</div>
```

## Theme

- **Background**: zinc-950 (body), zinc-900/60 (cards), zinc-800/60 (inputs)
- **Text**: zinc-100 (primary), zinc-300 (secondary), zinc-500 (muted), zinc-600 (disabled)
- **Borders**: zinc-800/60 (cards), zinc-700/60 (inputs), zinc-700/40 (buttons)
- **Accent**: emerald (success/online), amber (warning), red (error/critical), blue (info/selected)
- **Selection glow**: `shadow-[0_0_15px_rgba(59,130,246,0.1)]` on selected cards

## Types (packages/ui/src/types.ts)

```typescript
interface DeviceInfo { serial, type, brand?, model? }
interface DeviceRecord { serial, brand, model, status, lastSeenAt, alertThresholds }
interface HealthSnapshot { serial, batteryPercent, temperatureCelsius, ramAvailableMb, storageFreeBytes, wifiConnected, collectedAt }
interface Alert { id, deviceSerial, severity, type, message, resolved, resolvedAt, createdAt }
interface WhatsAppAccount { deviceSerial, profileId, packageName, phoneNumber }
interface Message { id, to, body, idempotencyKey, priority, senderNumber, status, lockedBy, lockedAt, createdAt, updatedAt }
```

## Adding New Tabs

1. Add tab ID to `type Tab = 'devices' | 'queue' | 'sessions' | 'NEW'`
2. Add button in `sidebar.tsx` tabs array
3. Add content branch in `App.tsx` main render
4. Create component in `components/`

## Adding New Stat Cards

Edit `stats-bar.tsx` — add another `<StatCard>` in the grid. Grid auto-adjusts.

## Recharts Usage

Already installed. Import from 'recharts':
```typescript
import { LineChart, Line, BarChart, Bar, PieChart, Pie, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts'
```

Current usage: spark charts in `device-detail.tsx` (battery, temp, RAM over time).
