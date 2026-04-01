declare global {
  interface Window {
    __DISPATCH_CORE_URL__?: string
  }
}

export const CORE_URL =
  window.__DISPATCH_CORE_URL__
  ?? import.meta.env.VITE_CORE_URL
  ?? 'http://localhost:7890'
