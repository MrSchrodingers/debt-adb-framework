import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const CORE = 'http://localhost:7890'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
