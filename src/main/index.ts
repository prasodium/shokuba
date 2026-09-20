import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, session, shell } from 'electron'
import { createAgentServices, type AgentServices } from './agents'
import { createServices, type Services } from './bootstrap'
import { readCapturePlan, runCapturePlan, type CapturePlan } from './devtools/capture'
import { GhCli } from './github/gh'
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
const CAPTURE_PREFIX = '--shokuba-capture='
/** Time for the renderer to load data over IPC and paint before a screenshot is taken. */
const SCREENSHOT_DELAY_MS = Number(process.env['SHOKUBA_SCREENSHOT_DELAY_MS'] ?? 2500)

const rendererEntry = join(__dirname, '../renderer/index.html')
const trusted: TrustedOrigins = {
  // Only honour the dev server in unpackaged builds, never in a shipped app.
  devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
  rendererFileUrl: pathToFileURL(rendererEntry).href,
}

let services: Services | undefined
let agents: AgentServices | undefined
let disposeIpc: (() => void) | undefined
let shuttingDown = false

/** Development-only ways of running the app unattended, for verification and screenshots. */
interface DevRun {
  screenshotPath?: string
  capturePlan?: CapturePlan
}

function createWindow(dev?: DevRun): BrowserWindow {
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
      // An unattended run never shows its window; without this Chromium would pause animation.
      backgroundThrottling: dev === undefined,
    },
  })

  window.once('ready-to-show', () => {
    if (!dev) window.show()
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

  if (dev) {
    // Renderer problems (a CSP violation, a failed WebGL context) would otherwise be invisible here.
    window.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') {
        logger.warn('renderer.console', { level: event.level, message: event.message })
      }
    })
    window.webContents.once('did-finish-load', () => {
      const { screenshotPath, capturePlan } = dev
      if (capturePlan) {
        void runCapturePlan(window, capturePlan, (line) =>
          process.stdout.write(`SHOKUBA_CAPTURE ${line}\n`),
        )
          .catch((error: unknown) => logger.error('capture.failed', describeError(error)))
          .finally(() => app.quit())
      } else if (screenshotPath) {
        // Give the renderer a moment to fetch data over IPC and paint.
        setTimeout(() => {
          void window.webContents.capturePage().then((image) => {
            writeFileSync(screenshotPath, image.toPNG())
            app.quit()
          })
        }, SCREENSHOT_DELAY_MS)
      }
    })
  }

  if (trusted.devServerUrl) void window.loadURL(trusted.devServerUrl)
  else void window.loadFile(rendererEntry)
  return window
}

function start(dev?: DevRun): void {
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

  void app.whenReady().then(async () => {
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
      agents = await createAgentServices(services, {
        platform,
        env: process.env,
        home: homedir(),
        version: app.getVersion(),
        // A stand-in for `gh` for development and demos only; a packaged app never reads this.
        ...(!app.isPackaged &&
          process.env['SHOKUBA_PUSH_TO'] && { pushTo: process.env['SHOKUBA_PUSH_TO'] }),
        ...(!app.isPackaged &&
          process.env['SHOKUBA_GH'] && {
            github: new GhCli({
              platform,
              env: process.env,
              home: homedir(),
              executable: process.env['SHOKUBA_GH'],
            }),
          }),
      })
    } catch (error) {
      logger.error('startup.failed', describeError(error))
      app.exit(1)
      return
    }

    disposeIpc = registerIpc(services, agents, platform, trusted)
    createWindow(dev)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (platform !== 'darwin') app.quit()
  })

  // Running agents are child processes; stop them (gracefully, then forcefully) before the
  // app goes away, instead of orphaning them.
  app.on('will-quit', (event) => {
    if (!shuttingDown) {
      shuttingDown = true
      event.preventDefault()
      void (async () => {
        try {
          await agents?.close()
        } catch (error) {
          logger.error('shutdown.agents.failed', describeError(error))
        }
        disposeIpc?.()
        services?.close()
        services = undefined
        agents = undefined
        app.quit()
      })()
    }
  })
}

if (process.argv.includes(SMOKE_FLAG)) {
  void app.whenReady().then(async () => {
    try {
      const report = await runSmokeTest()
      process.stdout.write(`SHOKUBA_SMOKE ${JSON.stringify(report)}\n`)
      app.exit(report.ok ? 0 : 1)
    } catch (error) {
      // Whatever went wrong, end the run: a smoke test that hangs hides the real problem.
      process.stderr.write(`smoke: the run failed: ${describeError(error).message}\n`)
      app.exit(1)
    }
  })
} else {
  const screenshotArg = process.argv.find((arg) => arg.startsWith(SCREENSHOT_PREFIX))
  const captureArg = process.argv.find((arg) => arg.startsWith(CAPTURE_PREFIX))
  const dev: DevRun = {}
  if (screenshotArg) dev.screenshotPath = screenshotArg.slice(SCREENSHOT_PREFIX.length)
  // A capture plan can run arbitrary script in the renderer, so a shipped app never honours it.
  if (captureArg && !app.isPackaged) {
    dev.capturePlan = readCapturePlan(captureArg.slice(CAPTURE_PREFIX.length))
  }
  start(Object.keys(dev).length > 0 ? dev : undefined)
}
