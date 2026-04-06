import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DEV_URL = 'http://localhost:5173'
const isDev = !app.isPackaged

async function waitForServer(url: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status < 500) return true
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Dispatch — ADB WhatsApp Orchestrator',
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    console.log('Dev mode: waiting for Vite dev server...')
    const viteReady = await waitForServer(UI_DEV_URL, 30)
    if (!viteReady) {
      console.error('Vite dev server not available at', UI_DEV_URL)
      console.error('Start it with: pnpm dev:ui (from project root)')
      app.quit()
      return
    }
    await win.loadURL(UI_DEV_URL)
    win.webContents.openDevTools()
  } else {
    const { createServer } = await import('@dispatch/core')
    await createServer()
    await win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'))
  }
}

app.whenReady().then(async () => {
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
