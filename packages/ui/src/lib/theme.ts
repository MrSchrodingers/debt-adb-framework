/**
 * Hand-rolled theme hook — no extra dependency.
 * Toggles `data-theme="light"` on `<html>`. CSS vars in index.css handle
 * the palette swap. Default: dark (current behavior). Persists in localStorage.
 */

export type Theme = 'dark' | 'light'
const STORAGE_KEY = 'dispatch:theme'

export function getStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
  localStorage.setItem(STORAGE_KEY, theme)
}
