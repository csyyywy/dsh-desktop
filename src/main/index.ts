// 应用入口：窗口/托盘/生命周期编排 + 启动流程
import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { AppSettings, AppStatus, AppUpdateProgress, InstallProgress, ServerPhase } from '../shared/types'
import type { Controller } from './controller'
import { loadSettings, saveSettings, dshHome } from './settings'
import { pushLog, getLogs, onLog } from './log'
import { hasBundledDsh, installDsh, isComplete, isInstalled, installedVersion, latestVersion, listVersions, resolveRuntime, restoreBundledDsh } from './dsh-manager'
import { startServer, stopServer, restartServer, isRunning } from './server'
import { checkAppUpdate, downloadedUpdatePath, downloadAppUpdate as downloadAppUpdateFile } from './updater'
import { listBackups, listInstalledPlugins, restoreBackup, searchPlugins, installPlugin, uninstallPlugin } from './plugin-manager'
import { registerIpc } from './ipc'
import { createTray, refreshTrayMenu } from './tray'
import { iconPath } from './paths'

const PRELOAD = join(__dirname, '../preload/index.js')

let mainWindow: BrowserWindow | null = null
let dashboardWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let tray: ReturnType<typeof createTray> | null = null
let phase: ServerPhase = 'stopped'
let error: string | null = null
// dsh 服务重启后，已存在的主窗口内容会过期；下次从托盘打开时需刷新
let webUIStale = true
let latestVersionCache: string | null = null
let quitting = false

// ---------- 渲染层加载 ----------
function loadRenderer(win: BrowserWindow, query: Record<string, string>): void {
  if (process.env['ELECTRON_RENDERER_URL']) {
    const qs = new URLSearchParams(query).toString()
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${qs}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

// ---------- 窗口 ----------
function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  loadRenderer(win, { view: 'splash' })
  win.on('closed', () => {
    splashWindow = null
  })
  return win
}

function createDashboard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    title: 'DeepSeek Harness 仪表盘',
    icon: iconPath('icon.png'),
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(win, { view: 'dashboard' })
  win.on('closed', () => {
    dashboardWindow = null
  })
  return win
}

function createMain(): BrowserWindow {
  const s = loadSettings()
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'DeepSeek Harness',
    icon: iconPath('icon.png'),
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 主窗口就是 dsh Web UI，给 F5 / Ctrl+R 绑定刷新（Electron 默认不绑）
  win.webContents.on('before-input-event', (event, input) => {
    const isReloadKey = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')
    if (input.type === 'keyDown' && isReloadKey) {
      event.preventDefault()
      win.webContents.reload()
    }
  })
  void win.loadURL(`http://127.0.0.1:${s.port || 3080}`)
  win.webContents.on('did-finish-load', () => {
    webUIStale = false
  })
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function openMain(): void {
  if (!isRunning()) {
    void startDsh()
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMain()
  } else {
    // 服务重启过则刷新旧窗口，避免从托盘打开时仍是过期页面
    if (webUIStale) {
      webUIStale = false
      mainWindow.webContents.reload()
    }
    mainWindow.show()
    mainWindow.focus()
  }
}

function showDashboard(): void {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = createDashboard()
  } else {
    dashboardWindow.show()
    dashboardWindow.focus()
  }
}

// ---------- 状态与广播 ----------
function notifyWindows(): BrowserWindow[] {
  const list: BrowserWindow[] = []
  if (dashboardWindow && !dashboardWindow.isDestroyed()) list.push(dashboardWindow)
  if (splashWindow && !splashWindow.isDestroyed()) list.push(splashWindow)
  return list
}

function buildStatus(): AppStatus {
  const s = loadSettings()
  const rt = resolveRuntime()
  return {
    phase,
    running: isRunning(),
    port: s.port || 3080,
    url: `http://127.0.0.1:${s.port || 3080}`,
    installedVersion: installedVersion(),
    latestVersion: latestVersionCache,
    workspace: s.workspace || process.env.USERPROFILE || process.cwd(),
    dshHome: dshHome(),
    appVersion: app.getVersion(),
    nodeLabel: rt.label,
    error
  }
}

function broadcastStatus(): void {
  const s = buildStatus()
  for (const w of notifyWindows()) w.webContents.send('status:changed', s)
  if (tray) refreshTrayMenu({ controller, openMain, openDashboard: showDashboard })
}

function broadcastProgress(p: InstallProgress): void {
  for (const w of notifyWindows()) w.webContents.send('install:progress', p)
}

function broadcastAppUpdateProgress(p: AppUpdateProgress): void {
  for (const w of notifyWindows()) w.webContents.send('app:updateProgress', p)
}

// ---------- 服务 / 安装编排 ----------
function onServerExit(code: number | null): void {
  if (quitting) return
  phase = code != null && code !== 0 ? 'error' : 'stopped'
  error = phase === 'error' ? `dsh 进程异常退出 (code=${code})` : null
  broadcastStatus()
}

async function doInstall(targetVersion: string): Promise<void> {
  phase = 'installing'
  error = null
  broadcastProgress({ phase: 'installing', message: `正在安装 @deepseek-ai/dsh@${targetVersion} …` })
  broadcastStatus()
  const code = await installDsh(targetVersion, (line) => {
    broadcastProgress({ phase: 'installing', message: line })
  })
  if (code !== 0) {
    phase = 'error'
    error = `npm 安装失败 (exit ${code})，详见日志`
    broadcastProgress({ phase: 'error', message: error })
    broadcastStatus()
    throw new Error(error)
  }
  latestVersionCache = await latestVersion()
  phase = 'stopped'
  broadcastStatus()
}

async function ensureInstalled(): Promise<void> {
  if (isComplete()) return
  if (hasBundledDsh()) {
    broadcastProgress({ phase: 'installing', message: '正在恢复内置 DeepSeek Harness …' })
    broadcastStatus()
    if (restoreBundledDsh()) return
  }
  await doInstall(loadSettings().dshVersion || 'latest')
}

async function startDsh(): Promise<AppStatus> {
  await ensureInstalled()
  phase = 'starting'
  error = null
  broadcastStatus()
  broadcastProgress({ phase: 'starting', message: '正在启动服务…' })
  try {
    await startServer(onServerExit)
    phase = 'running'
    error = null
    openMain()
  } catch (e) {
    phase = 'error'
    error = (e as Error).message
    broadcastProgress({ phase: 'error', message: error })
  }
  broadcastStatus()
  return buildStatus()
}

async function restartForPluginChange(): Promise<void> {
  try {
    await restartServer(onServerExit)
    phase = 'running'
    error = null
    // 插件变更后 dsh 已重启（web UI 的 __DSH_BOOT__ 已包含新客户端），
    // 刷新主窗口让新面板立即生效，否则窗口停留在旧页面看不到效果
    webUIStale = true
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
  } catch (e) {
    phase = 'error'
    error = (e as Error).message
  }
  broadcastStatus()
}

async function updateDsh(version?: string): Promise<AppStatus> {
  const target = version ?? loadSettings().dshVersion ?? 'latest'
  const wasRunning = isRunning()
  await doInstall(target)
  if (wasRunning) await startDsh()
  return buildStatus()
}

async function applySettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const prev = loadSettings()
  const next = saveSettings(patch)
  if (patch.launchOnLogin != null && patch.launchOnLogin !== prev.launchOnLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!next.launchOnLogin })
    } catch {
      /* 便携版可能不支持，忽略 */
    }
  }
  broadcastStatus()
  return next
}

const controller: Controller = {
  getStatus: () => buildStatus(),
  start: () => startDsh(),
  stop: async () => {
    await stopServer()
    phase = 'stopped'
    error = null
    broadcastStatus()
    return buildStatus()
  },
  restart: async () => {
    try {
      await restartServer(onServerExit)
      phase = 'running'
      error = null
      webUIStale = true
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload()
    } catch (e) {
      phase = 'error'
      error = (e as Error).message
    }
    broadcastStatus()
    return buildStatus()
  },
  install: async () => {
    await doInstall(loadSettings().dshVersion || 'latest')
    return buildStatus()
  },
  update: (version?: string) => updateDsh(version),
  listVersions,
  getSettings: () => loadSettings(),
  setSettings: (patch) => applySettings(patch),
  getLogs: () => getLogs(),
  openWebUI: () => openMain(),
  openDashboard: () => showDashboard(),
  openDshHome: async () => {
    mkdirSync(dshHome(), { recursive: true })
    await shell.openPath(dshHome())
  },
  openPluginsDir: async () => {
    const web = join(dshHome(), 'profiles', 'web')
    const target = existsSync(web) ? web : dshHome()
    mkdirSync(target, { recursive: true })
    await shell.openPath(target)
  },
  checkAppUpdate,
  downloadAppUpdate: () => downloadAppUpdateFile((p) => broadcastAppUpdateProgress(p)),
  installAppUpdate: () => {
    const installer = downloadedUpdatePath()
    if (!installer) {
      return { ok: false, message: '没有已下载的更新包，请先下载' }
    }
    pushLog(`应用自更新：启动安装器 ${installer}`)
    try {
      // detached + unref：安装器独立于本进程运行，应用退出后继续安装
      const child = spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      child.on('error', (e) => pushLog('应用自更新：启动安装器失败 ' + e.message))
    } catch (e) {
      return { ok: false, message: `无法启动安装器：${(e as Error).message}` }
    }
    // 安装器已接管：先正常退出本进程（before-quit 会停掉 dsh 服务），
    // NSIS 模板会等待旧进程退出后替换文件，完成后 --force-run 自动拉起新版本
    setTimeout(() => {
      quitting = true
      app.quit()
    }, 1000)
    return { ok: true, message: '正在安装更新，应用将自动重启…' }
  },
  listPlugins: () => listInstalledPlugins(),
  searchPlugins: (query, sort, source) => searchPlugins(query, sort, source),
  installPlugin: async (name, source) => {
    const r = await installPlugin(name, source)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  uninstallPlugin: async (name) => {
    const r = await uninstallPlugin(name)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  pickBackgroundImage: async () => {
    const result = await dialog.showOpenDialog({
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    let img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) throw new Error('无法读取该图片文件')
    const maxDim = 1920
    const { width, height } = img.getSize()
    if (width > maxDim || height > maxDim) {
      const scale = Math.min(maxDim / width, maxDim / height)
      img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
    }
    const jpeg = img.toJPEG(85)
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  },
  openExternal: (url) => {
    const normalized = url
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '')
    if (/^https?:\/\//.test(normalized)) void shell.openExternal(normalized)
  },
  listBackups: async () => listBackups(),
  restoreBackup: async (name) => {
    const r = restoreBackup(name)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  quit: () => {
    quitting = true
    app.quit()
  },
  isRunning
}

// ---------- 启动流程 ----------
async function boot(): Promise<void> {
  broadcastProgress({ phase: 'checking', message: '正在启动 DeepSeek Harness …' })
  // 后台拉取最新版本，不阻塞启动
  void latestVersion().then((v) => {
    latestVersionCache = v
    broadcastStatus()
  })
  try {
    await startDsh()
  } catch {
    // 安装失败时 doInstall 已置 phase='error'，splash 显示错误 + 打开仪表盘按钮
    return
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()
}

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => openMain())

  void app.whenReady().then(() => {
    registerIpc(controller)
    onLog((line) => {
      for (const w of notifyWindows()) w.webContents.send('log:line', line)
    })

    splashWindow = createSplash()
    try {
      tray = createTray({ controller, openMain, openDashboard: showDashboard })
    } catch (e) {
      pushLog('托盘创建失败: ' + (e as Error).message)
    }

    void boot()
  })

  // 关闭所有窗口时保持托盘运行（退出走托盘「退出」）
  app.on('window-all-closed', () => {
    /* no-op：托盘常驻 */
  })

  app.on('before-quit', () => {
    quitting = true
    void stopServer()
  })
}
