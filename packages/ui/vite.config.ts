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
      registerType: 'autoUpdate',
      // Generates sw.js via workbox-build; keep the manifest separate.
      manifest: false, // We provide our own manifest.webmanifest in public/
      workbox: {
        // Network-first for API and socket calls; cache-first for static assets.
        runtimeCaching: [
          {
            // All API requests — network-first with fallback
            urlPattern: /\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'dispatch-api-cache',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 5, // 5 minutes
              },
            },
          },
          {
            // Static font resources — stale-while-revalidate
            urlPattern: /fonts\.(googleapis|gstatic)\.com/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'dispatch-fonts-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
            },
          },
        ],
        // Skip caching socket.io and API routes in the precache manifest
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,ico,png,webp,svg,woff2}'],
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
