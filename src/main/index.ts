// 应用入口：窗口/托盘/生命周期编排 + 启动流程
import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import type { AppSettings, AppStatus, AppUpdateProgress, BackendInfo, BackendMode, BackendSetupProgress, FsSide, FsTransferProgress, FsTransferRequest, InstallProgress, PluginOpResult, ServerPhase } from '../shared/types'
import type { Controller } from './controller'
import { loadSettings, saveSettings, dshHome } from './settings'
import { pushLog, getLogs, onLog } from './log'
import { hasBundledDsh, installDsh, isComplete, isInstalled, installedVersion, latestVersion, listVersions, resolveRuntime, restoreBundledDsh, bundledDshVersion, installDshWsl, wslIsComplete, wslInstalledVersion } from './dsh-manager'
import { startServer, stopServer, restartServer, isRunning, wslIsRunning, wslStale, forceCleanupWsl } from './server'
import { checkAppUpdate, downloadedUpdatePath, downloadAppUpdate as downloadAppUpdateFile } from './updater'
import { listBackups, listInstalledPlugins, restoreBackup, runPnpm, searchPlugins, installPlugin, uninstallPlugin, checkPluginUpdates, updatePlugin, deleteBackup as deleteBackupFile } from './plugin-manager'
import { registerIpc } from './ipc'
import { createTray, refreshTrayMenu } from './tray'
import { iconPath } from './paths'
import {
  currentDistro, toUnc, validateIpcArg, VALID_DISTRO_RE,
  wslDshHomeLinux, wslDshHomeWindows, wslHomeOf
} from './wsl'
import { backendDiagnose, buildBackendInfo, runBackendSetup, syncFromWindows } from './wsl-backend'
import {
  cancelTransfer as fsbCancel, enqueueTransfer as fsbEnqueue, listEntries as fsbList,
  mkdirEntry as fsbMkdir, openEntry as fsbOpen, removeEntry as fsbRemove,
  renameEntry as fsbRename, translatePath as fsbTranslate
} from './fs-bridge'

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
      reloadMain()
    }
  })
  void win.loadURL(`http://127.0.0.1:${webPort()}`)
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

/** 主窗口目标 URL（按当前后端端口动态计算） */
function mainTargetUrl(): string {
  return `http://127.0.0.1:${webPort()}`
}

/**
 * 主窗口重新导航到当前后端端口（不是原地 reload！）。
 * 关键坑（用户实测）：窗口 URL 是创建时写死的——本机模式为 3080，
 * 切到 WSL（3081）后原地 reload 仍请求旧端口 → 连接失败 → 窗口空白；
 * 必须重新 loadURL(当前 webPort())。服务未运行时不动窗口（等下次启动/打开）。
 */
function reloadMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!isRunning() && !wslIsRunning()) return
  webUIStale = false
  void mainWindow.loadURL(mainTargetUrl())
}

function openMain(): void {
  // WSL 模式没有本机 proc 句柄，isRunning() 恒 false——必须同时看 wslIsRunning()，
  // 否则启动成功后这里会误判"未运行"而递归 startDsh（被互斥锁挡住）→ 主窗口不弹出
  if (!isRunning() && !wslIsRunning()) {
    // B5：startDsh 已保证不 reject；再加 .catch 兜底防未来改动
    void startDsh().catch((e) => pushLog(`openMain: 启动失败 ${(e as Error).message}`))
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMain()
  } else {
    // 服务重启过（webUIStale）或手动改了端口/后端导致 URL 与当前端口不一致时，
    // 重新导航（用户诉求：URL 随手动选择的窗口/端口变动）
    const cur = mainWindow.webContents.getURL()
    if (webUIStale || !cur.startsWith(mainTargetUrl())) {
      reloadMain()
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

/** 统一广播：窗口 close→closed 之间 webContents 可能已销毁，send 会抛异常（B9）。
 *  集中做 isDestroyed 检查 + try/catch，替代 5 处散落的裸 send。 */
function sendToWindows(channel: string, payload: unknown): void {
  for (const w of notifyWindows()) {
    try {
      if (w.webContents.isDestroyed()) continue
      w.webContents.send(channel, payload)
    } catch {
      /* 窗口销毁竞态，忽略 */
    }
  }
}

/** 当前后端生效的 dsh 端口（WSL 独立端口，与 Windows 侧隔离） */
function webPort(): number {
  const s = loadSettings()
  return s.backend === 'wsl' ? s.wslPort || 3081 : s.port || 3080
}

function buildStatus(): AppStatus {
  const s = loadSettings()
  const rt = resolveRuntime()
  const wslMode = s.backend === 'wsl'
  return {
    phase,
    running: wslMode ? wslIsRunning() : isRunning(),
    port: webPort(),
    url: `http://127.0.0.1:${webPort()}`,
    installedVersion: wslMode ? wslInstalledVersion() : installedVersion(),
    latestVersion: latestVersionCache,
    workspace: wslMode ? (s.workspace || s.wslHome || '') : (s.workspace || process.env.USERPROFILE || process.cwd()),
    dshHome: wslMode ? (wslDshHomeWindows() ?? dshHome()) : dshHome(),
    appVersion: app.getVersion(),
    nodeLabel: rt.label,
    error,
    backend: s.backend,
    wslDistro: wslMode ? s.wslDistro : null,
    wslReady: wslMode && !!s.wslDistro && wslIsComplete(),
    stalePid: wslMode ? wslStale() : null
  }
}

function broadcastStatus(): void {
  sendToWindows('status:changed', buildStatus())
  if (tray) refreshTrayMenu({ controller, openMain, openDashboard: showDashboard })
}

function broadcastProgress(p: InstallProgress): void {
  sendToWindows('install:progress', p)
}

function broadcastAppUpdateProgress(p: AppUpdateProgress): void {
  sendToWindows('app:updateProgress', p)
}

function broadcastBackendSetupProgress(p: BackendSetupProgress): void {
  sendToWindows('backend:setupProgress', p)
}

function broadcastFsbProgress(p: FsTransferProgress): void {
  sendToWindows('fsb:progress', p)
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
  const wslMode = loadSettings().backend === 'wsl'
  const code = wslMode
    ? await installDshWsl(targetVersion, (line) => {
        broadcastProgress({ phase: 'installing', message: line })
      })
    : await installDsh(targetVersion, (line) => {
        broadcastProgress({ phase: 'installing', message: line })
      })
  if (code !== 0) {
    phase = 'error'
    error = `${wslMode ? 'WSL 内' : 'npm'} 安装失败 (exit ${code})，详见日志`
    broadcastProgress({ phase: 'error', message: error })
    broadcastStatus()
    throw new Error(error)
  }
  latestVersionCache = await latestVersion()
  phase = 'stopped'
  broadcastStatus()
}

/** dsh 安装目标版本：显式配置优先，否则 WSL 用内置 bundle 版本（与外壳配套），本机用 latest */
function resolveDshTarget(): string {
  const s = loadSettings()
  if (s.dshVersion && s.dshVersion !== 'latest') return s.dshVersion
  if (s.backend === 'wsl') return bundledDshVersion() ?? 'latest'
  return 'latest'
}

async function ensureInstalled(): Promise<void> {
  if (loadSettings().backend === 'wsl') {
    // WSL：无内置 bundle 恢复（win32 产物不通用），直接发行版内 npm 安装
    if (wslIsComplete()) return
    await doInstall(resolveDshTarget())
    return
  }
  if (isComplete()) return
  if (hasBundledDsh()) {
    broadcastProgress({ phase: 'installing', message: '正在恢复内置 DeepSeek Harness …' })
    broadcastStatus()
    if (restoreBundledDsh()) return
  }
  await doInstall(loadSettings().dshVersion || 'latest')
}

// 启动互斥：boot()/托盘/按钮可能并发触发 startDsh，重复启动会导致
// 多个 dsh 进程抢端口、状态在 starting/error 间横跳（用户实测问题）
let starting = false

async function startDsh(): Promise<AppStatus> {
  if (starting) return buildStatus()
  if (isRunning() || wslIsRunning()) return buildStatus()
  starting = true
  try {
    phase = 'starting'
    error = null
    broadcastStatus()
    broadcastProgress({ phase: 'starting', message: '正在启动服务…' })
    try {
      // B5：ensureInstalled 纳入 try —— 安装失败时走统一 phase='error'，
      // 不再向外 throw，避免 openMain/托盘等 `void startDsh()` 出现未处理拒绝
      await ensureInstalled()
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
  } finally {
    starting = false
  }
}

async function restartForPluginChange(): Promise<void> {
  try {
    await restartServer(onServerExit)
    phase = 'running'
    error = null
    // 插件变更后 dsh 已重启（web UI 的 __DSH_BOOT__ 已包含新客户端），
    // 重新导航主窗口到当前端口让新面板立即生效（原地 reload 会停留在旧端口 URL）
    webUIStale = true
    reloadMain()
  } catch (e) {
    phase = 'error'
    error = (e as Error).message
  }
  broadcastStatus()
}

async function updateDsh(version?: string): Promise<AppStatus> {
  const target = version ?? resolveDshTarget()
  const wasRunning = isRunning() || wslIsRunning()
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
      reloadMain()
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
    if (loadSettings().backend === 'wsl') {
      const win = wslDshHomeWindows()
      if (win) {
        mkdirSync(win, { recursive: true })
        await shell.openPath(win)
        return
      }
    }
    mkdirSync(dshHome(), { recursive: true })
    await shell.openPath(dshHome())
  },
  openPluginsDir: async () => {
    if (loadSettings().backend === 'wsl') {
      const home = wslDshHomeLinux()
      const d = currentDistro()
      if (home && d) {
        const web = toUnc(d, `${home}/profiles/web`)
        const target = existsSync(web) ? web : wslDshHomeWindows() ?? web
        mkdirSync(target, { recursive: true })
        await shell.openPath(target)
        return
      }
    }
    const web = join(dshHome(), 'profiles', 'web')
    const target = existsSync(web) ? web : dshHome()
    mkdirSync(target, { recursive: true })
    await shell.openPath(target)
  },
  checkAppUpdate,
  downloadAppUpdate: () => downloadAppUpdateFile((p) => broadcastAppUpdateProgress(p)),
  installAppUpdate: async () => {
    const installer = downloadedUpdatePath()
    if (!installer) {
      return { ok: false, message: '没有已下载的更新包，请先下载' }
    }
    // WSL 后端运行时先停止，避免安装器拉起的新实例与旧实例端口冲突
    if (loadSettings().backend === 'wsl' && (isRunning() || wslIsRunning())) {
      pushLog('应用自更新：先停止 WSL 后端')
      await stopServer()
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
    if (loadSettings().backend === 'wsl') {
      // WSL：停服 → 安装（备份在停止期间快照，保证一致）→ 恢复原运行状态
      const wasRunning = wslIsRunning()
      if (wasRunning) await stopServer()
      const r = await installPlugin(name, source)
      if (r.ok && wasRunning) await restartServer(onServerExit)
      return r
    }
    const r = await installPlugin(name, source)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  uninstallPlugin: async (name) => {
    if (loadSettings().backend === 'wsl') {
      const wasRunning = wslIsRunning()
      if (wasRunning) await stopServer()
      const r = await uninstallPlugin(name)
      if (r.ok && wasRunning) await restartServer(onServerExit)
      return r
    }
    const r = await uninstallPlugin(name)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  checkPluginUpdates: () => checkPluginUpdates(),
  updatePlugin: async (name) => {
    if (loadSettings().backend === 'wsl') {
      // WSL：停服 → 更新（备份在停止期间快照）→ 恢复原运行状态
      const wasRunning = wslIsRunning()
      if (wasRunning) await stopServer()
      const r = await updatePlugin(name)
      if (r.ok && wasRunning) await restartServer(onServerExit)
      return r
    }
    const r = await updatePlugin(name)
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
    if (loadSettings().backend === 'wsl') {
      // 回退在停服期间执行（profile 快照一致性），完成后恢复原运行状态
      const wasRunning = wslIsRunning()
      if (wasRunning) await stopServer()
      const r = await restoreBackup(name)
      if (r.ok && wasRunning) await restartServer(onServerExit)
      return r
    }
    const r = await restoreBackup(name)
    if (r.ok && isRunning()) await restartForPluginChange()
    return r
  },
  deleteBackup: (name) => deleteBackupFile(name),
  // ---------- v0.2.0：WSL 后端 ----------
  backendInfo: () => buildBackendInfo(),
  backendSetMode: async (mode: BackendMode) => {
    const info = await buildBackendInfo()
    if (mode !== 'local' && mode !== 'wsl') return { ...info, error: '非法后端模式' }
    if (isRunning() || wslIsRunning()) return { ...info, error: '服务运行中，请先停止再切换后端' }
    if (mode === 'wsl' && !loadSettings().wslDistro) return { ...info, error: 'WSL 后端未部署，请先一键部署' }
    saveSettings({ backend: mode })
    broadcastStatus()
    return buildBackendInfo()
  },
  backendSetDistro: async (distro: string) => {
    const info = await buildBackendInfo()
    if (!validateIpcArg(distro) || !VALID_DISTRO_RE.test(distro)) return { ...info, error: '发行版名称含特殊字符，暂不支持' }
    if (isRunning() || wslIsRunning()) return { ...info, error: '服务运行中，请先停止再切换发行版' }
    const exists = info.distros.some((d) => d.name === distro)
    if (!exists) return { ...info, error: '发行版不存在: ' + distro }
    const home = await wslHomeOf(distro)
    if (!home) return { ...info, error: '发行版未就绪（可能尚未完成首次配置），请先在终端运行 wsl -d ' + distro }
    saveSettings({ backend: 'wsl', wslDistro: distro, wslHome: home })
    broadcastStatus()
    return buildBackendInfo()
  },
  backendSetup: (distro: string) =>
    runBackendSetup(distro, {
      emit: (stage, percent, message) => broadcastBackendSetupProgress({ stage, percent, message }),
      broadcastStatus,
      stopIfRunning: async () => {
        if (isRunning() || wslIsRunning()) await stopServer()
      },
      resolveDshTarget
    }),
  backendSyncFromWindows: async () => {
    // 与备份同原子性规则：停服 → 同步 → 恢复原运行状态；手动同步允许弹 UAC 打通 GitHub
    const wasRunning = wslIsRunning()
    if (wasRunning) await stopServer()
    const r = await syncFromWindows(undefined, true)
    if (wasRunning) await restartServer(onServerExit)
    return r
  },
  backendInstallDistro: async (name: string) => {
    if (!validateIpcArg(name) || !VALID_DISTRO_RE.test(name)) return { ok: false, message: '非法发行版名' }
    try {
      // 经 PowerShell 触发 UAC 提权安装（wsl --install -d <name>），安装后需用户完成首次配置
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process wsl.exe -ArgumentList '--install','-d','${name}' -Verb RunAs`],
        { detached: true, stdio: 'ignore', windowsHide: true }
      )
      child.unref()
      pushLog(`请求安装 WSL 发行版 ${name}（UAC）`)
      return { ok: true, message: '已请求安装（可能弹出 UAC 确认窗口），安装完成后请回到此处刷新并部署' }
    } catch (e) {
      return { ok: false, message: '请求安装失败: ' + (e as Error).message }
    }
  },
  backendDiagnose,
  backendForceCleanup: async () => {
    const ok = await forceCleanupWsl()
    broadcastStatus()
    return { ok, message: ok ? '已清理残留进程' : '清理失败，请手动处理（见日志）' }
  },
  // ---------- v0.2.0：文件桥 ----------
  fsbList: (side: FsSide, path: string) => {
    // path === '' = Windows 盘符列表虚拟根（文件桥「主页」按钮）
    if (!(path === '' || validateIpcArg(path))) return Promise.reject(new Error('非法路径参数'))
    try {
      return Promise.resolve(fsbList(side, path))
    } catch (e) {
      return Promise.reject(e)
    }
  },
  fsbTransfer: (jobs: FsTransferRequest[]) => {
    if (!Array.isArray(jobs)) return Promise.reject(new Error('非法传输参数'))
    for (const j of jobs) {
      if (!j || typeof j.id !== 'string' || !validateIpcArg(j.srcPath) || !validateIpcArg(j.dstPath)) {
        return Promise.reject(new Error('非法传输参数'))
      }
    }
    fsbEnqueue(jobs, (p) => broadcastFsbProgress(p))
    return Promise.resolve()
  },
  fsbCancel: (id: string) => {
    if (typeof id === 'string' && id) fsbCancel(id)
    return Promise.resolve()
  },
  fsbRemove: (side: FsSide, path: string) =>
    validateIpcArg(path) ? Promise.resolve(fsbRemove(side, path)) : Promise.reject(new Error('非法路径参数')),
  fsbRename: (side: FsSide, path: string, newName: string) =>
    validateIpcArg(path) && validateIpcArg(newName, 255)
      ? Promise.resolve(fsbRename(side, path, newName))
      : Promise.reject(new Error('非法参数')),
  fsbMkdir: (side: FsSide, path: string) =>
    validateIpcArg(path) ? Promise.resolve(fsbMkdir(side, path)) : Promise.reject(new Error('非法路径参数')),
  fsbTranslate: (path: string) =>
    validateIpcArg(path) ? fsbTranslate(path) : Promise.reject(new Error('非法路径参数')),
  fsbOpen: (side: FsSide, path: string, terminal?: boolean) =>
    validateIpcArg(path) ? fsbOpen(side, path, terminal) : Promise.reject(new Error('非法路径参数')),
  quit: () => {
    quitting = true
    app.quit()
  },
  isRunning: () => isRunning() || wslIsRunning()
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
    onLog((line) => sendToWindows('log:line', line))

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
