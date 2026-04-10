import { useState, useEffect } from 'react'
import { Cpu, Wifi, Smartphone, MessageCircle, RefreshCw } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface DeviceInfoProps {
  serial: string
  profileId?: number | null
}

export function DeviceInfo({ serial, profileId }: DeviceInfoProps) {
  const [info, setInfo] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const fetchInfo = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/info`, { headers: authHeaders() })
      if (res.ok) setInfo(await res.json())
    } catch {
      // offline
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchInfo() }, [serial])

  const waRunning = info.waRunning === 'running'
  const wabRunning = info.wabRunning === 'running'

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-purple-400" />
          <h3 className="text-sm font-medium text-zinc-300">Informacoes do Dispositivo</h3>
        </div>
        <button
          onClick={fetchInfo}
          disabled={loading}
          className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && Object.keys(info).length === 0 ? (
        <div className="p-8 text-center text-zinc-600 text-sm">Carregando informacoes...</div>
      ) : (
        <div className="p-4 space-y-4">
          {/* System */}
          <InfoSection icon={Smartphone} title="Sistema" color="text-blue-400">
            <InfoRow label="Android" value={info.release ? `${info.release} (SDK ${info.sdk})` : '—'} />
            <InfoRow label="Build" value={info.id || '—'} />
            <InfoRow label="Device" value={info.device || '—'} />
            <InfoRow label="Serial" value={info.serialno || serial} mono />
            <InfoRow label="Timezone" value={info.timezone || '—'} />
            <InfoRow label="Uptime" value={info.uptime || '—'} />
          </InfoSection>

          {/* Network */}
          <InfoSection icon={Wifi} title="Rede" color="text-emerald-400">
            <InfoRow label="IP" value={info.ip || '—'} mono />
            <InfoRow label="WiFi" value={info.wifiSsid || '—'} />
          </InfoSection>

          {/* Display */}
          <InfoSection icon={Smartphone} title="Display" color="text-amber-400">
            <InfoRow label="Resolucao" value={info.screenSize?.replace('Physical size: ', '') || '—'} />
            <InfoRow label="Densidade" value={info.screenDensity?.replace('Physical density: ', '') || '—'} />
          </InfoSection>

          {/* WhatsApp */}
          <InfoSection icon={MessageCircle} title="WhatsApp" color="text-emerald-400">
            <div className="grid grid-cols-2 gap-3">
              <AppCard
                name="WhatsApp"
                version={info.waVersion?.replace(/.*versionName=/, '') || '—'}
                running={waRunning}
              />
              <AppCard
                name="WA Business"
                version={info.wabVersion?.replace(/.*versionName=/, '') || '—'}
                running={wabRunning}
              />
            </div>
          </InfoSection>
        </div>
      )}
    </div>
  )
}

function InfoSection({ icon: Icon, title, color, children }: {
  icon: typeof Cpu
  title: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className={`h-3.5 w-3.5 ${color}`} />
        <span className="text-xs font-medium text-zinc-400">{title}</span>
      </div>
      <div className="space-y-1.5 pl-5">{children}</div>
    </div>
  )
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-zinc-300 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function AppCard({ name, version, running }: { name: string; version: string; running: boolean }) {
  return (
    <div className={`rounded-lg p-3 border ${running ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-zinc-800/60 border-zinc-700/30'}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-zinc-300">{name}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-xs ${running ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
          {running ? 'ativo' : 'parado'}
        </span>
      </div>
      <span className="text-xs text-zinc-500 font-mono">{version}</span>
    </div>
  )
}
