import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, shell } from 'electron'
import { createServices, type Services } from './bootstrap'
import { registerIpc } from './ipc/handlers'
import { isTrustedSenderUrl, type TrustedOrigins } from './ipc/trust'
import { createLogger, describeError } from './logging/logger'
import { toPlatformId } from './platform'
import { runSmokeTest } from './smoke'

// When ELECTRON_RUN_AS_NODE is set, Electron behaves as plain Node and `app` is undefined.
// Some parent processes (notably other Electron apps' terminals) leak it into the environment.
if (typeof app === 'undefined') {
  console.error(
    'Shokuba must be launched by Electron, but it is running as plain Node.\n' +
      'This usually means ELECTRON_RUN_AS_NODE is set in your environment. Unset it and try again.',
  )
  process.exit(1)
}

const logger = createLogger()
const platform = toPlatformId()

const SMOKE_FLAG = '--shokuba-smoke-test'
const SCREENSHOT_PREFIX = '--shokuba-screenshot='

const rendererEntry = join(__dirname, '../renderer/index.html')
const trusted: TrustedOrigins = {
  // Only honour the dev server in unpackaged builds, never in a shipped app.
  devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
  rendererFileUrl: pathToFileURL(rendererEntry).href,
}

let services: Services | undefined
let disposeIpc: (() => void) | undefined

function createWindow(screenshotPath?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Shokuba',
    backgroundColor: '#14110f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => {
    if (!screenshotPath) window.show()
  })

  // Never let the app window navigate away or spawn new windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    // Same rule the IPC layer uses: only our own renderer page may ever be loaded.
    if (!isTrustedSenderUrl(url, trusted)) event.preventDefault()
  })

  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      // Give the renderer a moment to fetch data over IPC and paint.
      setTimeout(() => {
        void window.webContents.capturePage().then((image) => {
          writeFileSync(screenshotPath, image.toPNG())
          app.quit()
        })
      }, 1500)
    })
  }

  if (trusted.devServerUrl) void window.loadURL(trusted.devServerUrl)
  else void window.loadFile(rendererEntry)
  return window
}

function start(screenshotPath?: string): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(() => {
    if (platform === 'win32') app.setAppUserModelId('com.shokuba.app')

    // No renderer feature needs device or notification permissions.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    )

    try {
      services = createServices({
        dataDir: app.getPath('userData'),
        version: app.getVersion(),
        platform,
        logger,
      })
    } catch (error) {
      logger.error('startup.failed', describeError(error))
      app.exit(1)
      return
    }

    disposeIpc = registerIpc(services, platform, trusted)
    createWindow(screenshotPath)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    disposeIpc?.()
    services?.close()
    services = undefined
  })
}

if (process.argv.includes(SMOKE_FLAG)) {
  void app.whenReady().then(async () => {
    const report = await runSmokeTest()
    process.stdout.write(`SHOKUBA_SMOKE ${JSON.stringify(report)}\n`)
    app.exit(report.ok ? 0 : 1)
  })
} else {
  const screenshotArg = process.argv.find((arg) => arg.startsWith(SCREENSHOT_PREFIX))
  start(screenshotArg?.slice(SCREENSHOT_PREFIX.length))
}
