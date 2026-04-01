import { app, BrowserWindow } from 'electron'
import { createServer } from '@dispatch/core'

const UI_DEV_URL = 'http://localhost:5173'

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: new URL('./preload.js', import.meta.url).pathname,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  await win.loadURL(UI_DEV_URL)
}

app.whenReady().then(async () => {
  await createServer()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
