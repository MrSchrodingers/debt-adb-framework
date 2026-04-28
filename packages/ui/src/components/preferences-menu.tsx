import { useState, useEffect, useRef } from 'react'
import { Settings, Sun, Moon, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type SupportedLang, persistLang } from '../lib/i18n'
import { getStoredTheme, applyTheme, type Theme } from '../lib/theme'

export function PreferencesMenu() {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<Theme>(getStoredTheme)
  const ref = useRef<HTMLDivElement>(null)

  // Apply saved theme on mount
  useEffect(() => {
    applyTheme(theme)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  function handleLangChange(lang: SupportedLang) {
    void i18n.changeLanguage(lang)
    persistLang(lang)
  }

  function handleThemeToggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
  }

  const currentLang = (i18n.language ?? 'pt-BR') as SupportedLang

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('preferences.title')}
        className="flex items-center justify-center rounded-lg bg-zinc-800 border border-zinc-700/40 p-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition min-h-[36px] min-w-[36px]"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-52 rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-zinc-800">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              {t('preferences.title')}
            </span>
          </div>

          {/* Language */}
          <div className="p-2">
            <p className="px-1 text-xs text-zinc-500 mb-1">{t('preferences.language')}</p>
            <div className="flex gap-1">
              {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                <button
                  key={code}
                  onClick={() => handleLangChange(code)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition ${
                    currentLang === code
                      ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                      : 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/40 hover:bg-zinc-700/60'
                  }`}
                >
                  {label}
                  {currentLang === code && (
                    <Check className="inline h-3 w-3 ml-1" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Theme */}
          <div className="p-2 border-t border-zinc-800">
            <p className="px-1 text-xs text-zinc-500 mb-1">{t('preferences.theme')}</p>
            <button
              onClick={handleThemeToggle}
              className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium bg-zinc-800/60 border border-zinc-700/40 text-zinc-300 hover:bg-zinc-700/60 transition"
            >
              {theme === 'dark' ? (
                <Moon className="h-3.5 w-3.5 text-zinc-400" />
              ) : (
                <Sun className="h-3.5 w-3.5 text-yellow-400" />
              )}
              {theme === 'dark' ? t('preferences.dark') : t('preferences.light')}
              <span className="ml-auto text-zinc-600 text-[10px]">
                {theme === 'dark' ? t('preferences.light') : t('preferences.dark')} →
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
