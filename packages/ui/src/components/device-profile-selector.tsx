import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, Smartphone, Users } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import type { DeviceRecord } from '../types'

interface Profile {
  id: number
  name: string
  running: boolean
  whatsapp: { installed: boolean; phone: string | null }
  whatsappBusiness: { installed: boolean; phone: string | null }
}

interface ProfilesResponse {
  serial: string
  profiles: Profile[]
}

export interface DeviceProfileSelection {
  serial: string | null
  profileId: number | null
  senderNumber: string | null
}

interface DeviceProfileSelectorProps {
  devices: DeviceRecord[]
  selection: DeviceProfileSelection
  onSelect: (selection: DeviceProfileSelection) => void
}

export function DeviceProfileSelector({ devices, selection, onSelect }: DeviceProfileSelectorProps) {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loadingProfiles, setLoadingProfiles] = useState(false)
  const [deviceOpen, setDeviceOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)

  const fetchProfiles = useCallback(async (serial: string) => {
    setLoadingProfiles(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/profiles`, { headers: authHeaders() })
      if (!res.ok) return
      const data: ProfilesResponse = await res.json()
      setProfiles(data.profiles)
    } catch {
      setProfiles([])
    } finally {
      setLoadingProfiles(false)
    }
  }, [])

  useEffect(() => {
    if (selection.serial) {
      fetchProfiles(selection.serial)
    } else {
      setProfiles([])
    }
  }, [selection.serial, fetchProfiles])

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = () => {
      setDeviceOpen(false)
      setProfileOpen(false)
    }
    if (deviceOpen || profileOpen) {
      document.addEventListener('click', handleClick)
      return () => document.removeEventListener('click', handleClick)
    }
  }, [deviceOpen, profileOpen])

  const selectedDevice = devices.find(d => d.serial === selection.serial)
  const selectedProfile = profiles.find(p => p.id === selection.profileId)

  const deviceLabel = selectedDevice
    ? `${selectedDevice.brand ?? ''} ${selectedDevice.model ?? selectedDevice.serial.slice(0, 8)}`.trim()
    : 'Todos Devices'

  const profileLabel = selectedProfile
    ? `P${selectedProfile.id} — ${selectedProfile.name}`
    : 'Todos Profiles'

  const getPhoneForProfile = (profile: Profile): string | null => {
    return profile.whatsapp.phone ?? profile.whatsappBusiness.phone ?? null
  }

  return (
    <div className="flex items-center gap-2">
      {/* Device Selector */}
      <div className="relative">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setDeviceOpen(!deviceOpen)
            setProfileOpen(false)
          }}
          className="flex items-center gap-2 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700/80 transition min-h-[36px]"
        >
          <Smartphone className="h-3.5 w-3.5 text-zinc-500" />
          <span className="max-w-[140px] truncate">{deviceLabel}</span>
          <ChevronDown className="h-3 w-3 text-zinc-500" />
        </button>

        {deviceOpen && (
          <div className="absolute z-50 mt-1 w-56 rounded-lg border border-zinc-700/60 bg-zinc-800 shadow-xl">
            <button
              onClick={() => {
                onSelect({ serial: null, profileId: null, senderNumber: null })
                setDeviceOpen(false)
              }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-700/60 transition ${
                !selection.serial ? 'text-emerald-400' : 'text-zinc-300'
              }`}
            >
              Todos Devices
            </button>
            {devices.map(device => (
              <button
                key={device.serial}
                onClick={() => {
                  onSelect({ serial: device.serial, profileId: null, senderNumber: null })
                  setDeviceOpen(false)
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-700/60 transition flex items-center gap-2 ${
                  selection.serial === device.serial ? 'text-emerald-400' : 'text-zinc-300'
                }`}
              >
                <div className={`h-1.5 w-1.5 rounded-full ${
                  device.status === 'online' ? 'bg-emerald-500' : 'bg-zinc-500'
                }`} />
                <span className="truncate">
                  {device.brand ?? ''} {device.model ?? ''}
                </span>
                <span className="text-zinc-600 font-mono ml-auto">{device.serial.slice(0, 8)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Profile Selector — only visible when a device is selected */}
      {selection.serial && (
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setProfileOpen(!profileOpen)
              setDeviceOpen(false)
            }}
            disabled={loadingProfiles}
            className="flex items-center gap-2 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700/80 transition min-h-[36px] disabled:opacity-50"
          >
            <Users className="h-3.5 w-3.5 text-zinc-500" />
            <span className="max-w-[160px] truncate">
              {loadingProfiles ? 'Carregando...' : profileLabel}
            </span>
            <ChevronDown className="h-3 w-3 text-zinc-500" />
          </button>

          {profileOpen && !loadingProfiles && (
            <div className="absolute z-50 mt-1 w-64 rounded-lg border border-zinc-700/60 bg-zinc-800 shadow-xl">
              <button
                onClick={() => {
                  onSelect({ ...selection, profileId: null, senderNumber: null })
                  setProfileOpen(false)
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-700/60 transition ${
                  selection.profileId === null ? 'text-emerald-400' : 'text-zinc-300'
                }`}
              >
                Todos Profiles
              </button>
              {profiles.map(profile => {
                const phone = getPhoneForProfile(profile)
                return (
                  <button
                    key={profile.id}
                    onClick={() => {
                      onSelect({
                        ...selection,
                        profileId: profile.id,
                        senderNumber: phone,
                      })
                      setProfileOpen(false)
                    }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-zinc-700/60 transition ${
                      selection.profileId === profile.id ? 'text-emerald-400' : 'text-zinc-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div className={`h-1.5 w-1.5 rounded-full ${profile.running ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
                      <span>P{profile.id} — {profile.name}</span>
                    </div>
                    {phone && (
                      <span className="text-zinc-500 font-mono text-[10px] ml-4">{phone}</span>
                    )}
                    <div className="flex gap-1 ml-4 mt-0.5">
                      {profile.whatsapp.installed && (
                        <span className="text-[10px] text-emerald-600">WA</span>
                      )}
                      {profile.whatsappBusiness.installed && (
                        <span className="text-[10px] text-blue-600">WAB</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Active filter indicator */}
      {(selection.serial || selection.senderNumber) && (
        <button
          onClick={() => onSelect({ serial: null, profileId: null, senderNumber: null })}
          className="rounded-full px-2 py-0.5 text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition"
          title="Limpar filtro"
        >
          Limpar
        </button>
      )}
    </div>
  )
}
