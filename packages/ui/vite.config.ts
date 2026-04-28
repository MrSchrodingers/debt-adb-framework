import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

const CORE = 'http://localhost:7890'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // SELF-DESTRUCT MODE — generates a kill-switch SW that unregisters itself
      // and clears all caches on activate. After every client visits once, no
      // SW remains. Re-enable PWA later with `selfDestroying: false` once cache
      // semantics are tuned (binary endpoints, JWT auth flows, etc.) so users
      // don't get stuck on stale assets.
      selfDestroying: true,
      registerType: 'autoUpdate',
      manifest: false, // We provide our own manifest.webmanifest in public/
      workbox: {
        // Order matters — first match wins. Bypass binary/streaming endpoints
        // BEFORE the generic /api/ NetworkFirst rule, otherwise NS_BINDING_ABORTED
        // happens when SW caches a partial PNG/stream response.
        runtimeCaching: [
          // Screenshot images (PNG bytes) — never cache, bypass SW
          {
            urlPattern: /\/api\/v1\/messages\/[^/]+\/screenshot/,
            handler: 'NetworkOnly',
          },
          // Live device screen — periodic refresh, no cache
          {
            urlPattern: /\/api\/v1\/devices\/[^/]+\/screen/,
            handler: 'NetworkOnly',
          },
          // Health/metrics — no cache (stale data is misleading)
          {
            urlPattern: /\/(healthz|metrics)/,
            handler: 'NetworkOnly',
          },
          // Socket.IO long-poll/upgrade — must NEVER be cached or buffered
          {
            urlPattern: /\/socket\.io\//,
            handler: 'NetworkOnly',
          },
          // JSON API — network-first with short timeout + small cache
          {
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'dispatch-api-cache',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 5 },
            },
          },
          // Static font resources — stale-while-revalidate
          {
            urlPattern: /fonts\.(googleapis|gstatic)\.com/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'dispatch-fonts-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
        navigateFallback: 'index.html',
        // Don't precache the dynamic API JSON or any large binary
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//, /^\/admin\/jaeger/],
        globPatterns: ['**/*.{js,css,html,ico,png,webp,svg,woff2}'],
        // Drop any cache built by an older SW version. Combined with skipWaiting
        // (already in registerType: 'autoUpdate'), this clears stale screenshot
        // /image entries the previous SW may have stored.
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
      },
      devOptions: {
        // Enable SW in dev for local testing
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5174,
    host: true,
    allowedHosts: true,
    // When served behind Tailscale Funnel (HTTPS :443), HMR must dial the
    // public port over WSS. Override via VITE_HMR_CLIENT_PORT for local-only dev.
    hmr: {
      clientPort: Number(process.env.VITE_HMR_CLIENT_PORT) || 443,
      protocol: process.env.VITE_HMR_PROTOCOL === 'ws' ? 'ws' : 'wss',
    },
    proxy: {
      '/api':       { target: CORE, changeOrigin: true },
      '/healthz':   { target: CORE, changeOrigin: true },
      '/metrics':   { target: CORE, changeOrigin: true },
      '/socket.io': { target: CORE, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 5174,
    host: '127.0.0.1',
    allowedHosts: true,
  },
})
