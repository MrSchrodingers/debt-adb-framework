import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import ptBR from '../locales/pt-BR.json'
import en from '../locales/en.json'

export const SUPPORTED_LANGUAGES = [
  { code: 'pt-BR', label: 'PT' },
  { code: 'en', label: 'EN' },
] as const

export type SupportedLang = (typeof SUPPORTED_LANGUAGES)[number]['code']

const STORAGE_KEY = 'dispatch:lang'

function detectInitialLang(): SupportedLang {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'pt-BR' || stored === 'en') return stored
  return 'pt-BR'
}

export function persistLang(lang: SupportedLang): void {
  localStorage.setItem(STORAGE_KEY, lang)
}

void i18n
  .use(initReactI18next)
  .init({
    lng: detectInitialLang(),
    fallbackLng: 'pt-BR',
    interpolation: {
      escapeValue: false, // React handles XSS
    },
    resources: {
      'pt-BR': { translation: ptBR },
      en:      { translation: en },
    },
  })

export default i18n
