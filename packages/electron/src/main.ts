import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DEV_URL = 'http://localhost:5173'
const isDev = !app.isPackaged

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Dispatch — ADB WhatsApp Orchestrator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    // Dev: UI served by Vite, core started separately via pnpm dev:core
    await win.loadURL(UI_DEV_URL)
    win.webContents.openDevTools()
  } else {
    // Production: core started in-process, load bundled UI
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
