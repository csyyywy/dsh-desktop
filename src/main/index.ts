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
import { listBackups, listInstalledPlugins, restoreBackup, runPnpm, searchPlugins, installPlugin, uninstallPlugin, deleteBackup as deleteBackupFile } from './plugin-manager'
import { registerIpc } from './ipc'
import { createTray, refreshTrayMenu } from './tray'
import { iconPath } from './paths'
import {
  bashQuote, currentDistro, hasSetsid, listDistros, pingDistro, runWsl, runWslBash, runWslGlobal, toUnc,
  validateIpcArg, VALID_DISTRO_RE, wslDshHomeLinux, wslDshHomeWindows,
  wslHomeOf, wslVersion, kernelVersion, wslNodeBin, wslWorkspaceLinux
} from './wsl'
import { migrateSessionCwds } from './session-cwd-migrate'
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
    void startDsh()
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

function broadcastBackendSetupProgress(p: BackendSetupProgress): void {
  for (const w of notifyWindows()) w.webContents.send('backend:setupProgress', p)
}

function broadcastFsbProgress(p: FsTransferProgress): void {
  for (const w of notifyWindows()) w.webContents.send('fsb:progress', p)
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

// ---------- WSL 后端（v0.2.0） ----------

async function buildBackendInfo(): Promise<BackendInfo> {
  const s = loadSettings()
  const { distros, error } = await listDistros()
  const [wv, kv] = await Promise.all([wslVersion(), kernelVersion()])
  return {
    mode: s.backend,
    distro: s.backend === 'wsl' ? s.wslDistro : null,
    distros,
    ready: s.backend === 'wsl' && !!s.wslDistro && wslIsComplete(),
    wslVersion: wv,
    kernelVersion: kv,
    error
  }
}

/** backend:setup 主流程：就绪检查 → 目录 → Node(tar) → pnpm → npm install dsh → 校验 */
async function runBackendSetup(distro: string): Promise<PluginOpResult> {  if (!validateIpcArg(distro) || !VALID_DISTRO_RE.test(distro)) {
    return { ok: false, message: '发行版名称含特殊字符，暂不支持部署' }
  }
  const emit = (stage: BackendSetupProgress['stage'], percent: number, message: string): void =>
    broadcastBackendSetupProgress({ stage, percent, message })
  emit('ready', 0, `正在检查发行版 ${distro} …`)
  const ping = await pingDistro(distro)
  if (!ping.ok) return { ok: false, message: ping.message }
  // 旧后端（本机或其它发行版）运行中先停止
  if (isRunning() || wslIsRunning()) await stopServer()

  emit('mkdir', 5, '创建目录结构 …')
  const home = await wslHomeOf(distro)
  if (!home) return { ok: false, message: '无法解析发行版 HOME' }
  const base = `${home}/.dsh-desktop`
  const mk = await runWslBash(`mkdir -p ${bashQuote(`${base}/node`)} ${bashQuote(`${base}/pnpm`)} ${bashQuote(`${base}/logs`)}`, { silent: true, distro })
  if (mk.code !== 0) return { ok: false, message: '创建目录失败: ' + (mk.stderr || mk.stdout).trim() }

  emit('node', 15, '拷贝 Linux Node（约 25MB）…')
  const tarSrc = app.isPackaged
    ? join(process.resourcesPath, 'node-linux.tar.xz')
    : join(app.getAppPath(), 'resources', 'node-linux.tar.xz')
  if (!existsSync(tarSrc)) return { ok: false, message: '缺少内置 Linux Node 资源（node-linux.tar.xz），请重新构建应用' }
  try {
    await fsp.copyFile(tarSrc, toUnc(distro, `${base}/node.tar.xz`))
  } catch (e) {
    return { ok: false, message: '拷贝 Node 失败: ' + (e as Error).message }
  }
  emit('node', 30, '解压 Node（tar 保留执行权限）…')
  const x = await runWslBash(`cd ${bashQuote(base)} && tar -xJf node.tar.xz --strip-components=1 -C node && chmod +x node/bin/node && rm -f node.tar.xz`, { timeoutMs: 180000, distro })
  if (x.code !== 0) return { ok: false, message: '解压 Node 失败: ' + (x.stderr || x.stdout).trim() }

  emit('pnpm', 45, '拷贝 pnpm（约 36MB）…')
  const pnpmSrc = app.isPackaged
    ? join(process.resourcesPath, 'pnpm')
    : join(app.getAppPath(), 'resources', 'pnpm')
  try {
    cpSync(pnpmSrc, toUnc(distro, `${base}/pnpm`), { recursive: true })
  } catch (e) {
    return { ok: false, message: '拷贝 pnpm 失败: ' + (e as Error).message }
  }

  const target = resolveDshTarget()
  // 编译工具链（g++/make/python3）：dsh 依赖 node-pty/koffi 等原生包，npm install
  // 时 node-gyp 编译必需（冒烟实测缺失会 node-gyp 失败）。自动换阿里 apt 源（失败容忍）+ 安装。
  emit('npm-install', 55, '检查编译工具链（build-essential/python3）…')
  const toolsCheck = await runWslBash('command -v g++ >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && echo TOOLS_OK || echo TOOLS_MISSING', { silent: true, distro })
  if (!toolsCheck.stdout.includes('TOOLS_OK')) {
    emit('npm-install', 56, '缺少编译工具链，自动安装（阿里镜像源，约 2-3 分钟）…')
    pushLog('WSL 发行版缺少编译工具链，自动安装 build-essential/python3 …')
    // 自动换阿里源（仅替换 Ubuntu 默认域名，失败容忍），再安装
    await runWslBash(
      'sudo sed -i "s|//archive.ubuntu.com/ubuntu|//mirrors.aliyun.com/ubuntu|g; s|//security.ubuntu.com/ubuntu|//mirrors.aliyun.com/ubuntu|g" /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list 2>/dev/null; sudo apt-get update -qq',
      { silent: true, distro, timeoutMs: 180000 }
    )
    const tools = await runWslBash('sudo apt-get install -y -qq build-essential python3', { silent: true, distro, timeoutMs: 10 * 60 * 1000 })
    if (tools.code !== 0) {
      return { ok: false, message: '编译工具链安装失败，请手动执行: sudo apt install -y build-essential python3 后重试' }
    }
    const re = await runWslBash('command -v g++ >/dev/null && command -v make >/dev/null && command -v python3 >/dev/null && echo TOOLS_OK || echo TOOLS_MISSING', { silent: true, distro })
    if (!re.stdout.includes('TOOLS_OK')) {
      return { ok: false, message: '编译工具链安装后仍不可用（g++/make/python3）' }
    }
  }
  emit('npm-install', 60, `安装 @deepseek-ai/dsh@${target}（发行版内 npm，首次需联网）…`)
  // 部署期间 settings 尚未切换：显式传 distro/home，不走 currentDistro()/wslBaseLinux()
  const code = await installDshWsl(target, (line) => emit('npm-install', 60, line), { distro, home })
  if (code !== 0) return { ok: false, message: 'dsh 安装失败，详见日志（检查网络/代理）' }

  emit('verify', 95, '校验安装 …')
  // 先保存配置再校验（wslIsComplete 依赖 backend 配置）
  const prev = loadSettings()
  saveSettings({ ...prev, backend: 'wsl', wslDistro: distro, wslHome: home })
  if (!wslIsComplete()) {
    saveSettings({ ...prev })
    return { ok: false, message: '安装校验失败（依赖不完整），请重试' }
  }
  const setsid = await hasSetsid(distro)
  if (!setsid) {
    return { ok: false, message: '发行版缺少 setsid（util-linux），请先运行: sudo apt install util-linux（部署已完成，修复后即可启动）' }
  }
  emit('verify', 98, '从本机同步插件/预设/会话（尽力而为，失败不阻断）…')
  const sync = await syncFromWindows((m) => emit('verify', 98, '同步: ' + m), false)
  if (!sync.ok) pushLog('部署后自动同步失败: ' + sync.message)
  emit('verify', 100, sync.ok ? '部署完成' : '部署完成（同步失败，服务仍可启动）')
  broadcastStatus()
  return { ok: true, message: `WSL 后端部署完成（${distro}），dsh@${target}${sync.ok ? '。' + sync.message : '（同步失败: ' + sync.message + '）'}` }
}

/**
 * 确保 WSL 内可访问 GitHub（pnpm 的 git 依赖需要 clone）。
 * 本机场景（实测）：hosts 把 github.com 劫持到 127.0.0.1（#S302，steamcommunity_302
 * 本地 443 转发），WSL 的 DNS 转发继承该结果，但 WSL 内 127.0.0.1 是自己的回环
 * → 连接被拒；真实 IP 直连也被墙。对策：
 * 1. 探测 WSL 内 github 连通性；
 * 2. 不通且 Windows 侧 127.0.0.1:443 有转发服务（302）→ UAC 配置
 *    portproxy 0.0.0.0:443 → 127.0.0.1:443 + 防火墙放行（一次性，持久化）；
 * 3. WSL /etc/hosts 写入 Windows 宿主 IP（ip route 网关）的 github 映射。
 */
async function ensureWslGithubAccess(distro: string, allowUac = false): Promise<{ ok: boolean; message: string }> {
  const probe = await runWslBash('curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://github.com', { silent: true, distro })
  if (['200', '301', '302'].includes(probe.stdout.trim())) return { ok: true, message: '' }
  // Windows 宿主 IP（WSL 网关；tr+cut 提取，避免 awk 单引号被外层剥掉的问题）
  const winIp = (await runWslBash("ip route show default | tr -s ' ' | cut -d' ' -f3 | head -1", { silent: true, distro })).stdout.trim()
  if (!winIp) return { ok: false, message: '无法获取 Windows 宿主 IP，git 依赖可能安装失败' }
  const hostsLine = `${winIp} github.com www.github.com api.github.com codeload.github.com raw.githubusercontent.com objects.githubusercontent.com gist.github.com`
  // 宿主 443 已可达（portproxy 已配置过）→ 直接写 hosts 验证，不再弹 UAC
  const hostProbe = await runWslBash(`curl -sS -o /dev/null -w "%{http_code}" --max-time 3 https://${winIp}:443`, { silent: true, distro })
  if (!['200', '301', '302'].includes(hostProbe.stdout.trim())) {
    // Windows 侧是否有 302 类本地转发（127.0.0.1:443）
    const hasLocal443 = await new Promise<boolean>((r) => {
      const s = connect({ host: '127.0.0.1', port: 443 }, () => {
        s.destroy()
        r(true)
      })
      s.on('error', () => r(false))
    })
    if (!hasLocal443) {
      return { ok: false, message: 'WSL 内无法访问 GitHub，且本机 127.0.0.1:443 无本地转发服务（steamcommunity_302 未运行？），git 依赖将安装失败' }
    }
    // 自动同步不弹 UAC（用户要求：做不到先跳过，服务先启动）；手动同步才提权配置
    if (!allowUac) {
      return { ok: false, message: 'WSL 内 GitHub 不可达（本机 hosts 劫持），自动同步跳过插件依赖重建；可在「从本机同步」时授权 UAC 打通' }
    }
    // 配置 portproxy + 防火墙（UAC 一次，幂等：先 delete 忽略错误再 add）
    const netshScript =
      "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=443 2>$null; " +
      'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=443; ' +
      "netsh advfirewall firewall delete rule name='dsh-wsl-gh443' 2>$null; " +
      "netsh advfirewall firewall add rule name='dsh-wsl-gh443' dir=in action=allow protocol=TCP localport=443"
    pushLog('WSL 内 GitHub 不可达（本机 hosts 劫持 127.0.0.1），请求提权配置 0.0.0.0:443 → 127.0.0.1:443 转发（请在弹出的 UAC 中允许）')
    try {
      const psCmd = `Start-Process powershell -ArgumentList '-NoProfile','-Command',${JSON.stringify(netshScript)} -Verb RunAs -Wait`
      await new Promise<void>((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true })
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    } catch {
      /* 用户拒绝 UAC 或失败，继续尝试直连 */
    }
  }
  // WSL hosts 写入 Windows 宿主 IP
  const res = await runWslBash(`grep -q "github.com" /etc/hosts || echo "${hostsLine}" | sudo tee -a /etc/hosts > /dev/null`, { distro })
  if (res.code !== 0) return { ok: false, message: '写入 /etc/hosts 失败: ' + (res.stderr || res.stdout).trim() }
  // 验证
  const re = await runWslBash('curl -sS -o /dev/null -w "%{http_code}" --max-time 10 https://github.com', { silent: true, distro })
  if (['200', '301', '302'].includes(re.stdout.trim())) {
    pushLog(`WSL 内 GitHub 已可达（经 Windows 宿主 ${winIp}:443 转发）`)
    return { ok: true, message: '' }
  }
  return { ok: false, message: 'GitHub 转发配置后仍不可达（请确认已允许 UAC），git 依赖可能安装失败' }
}

/**
 * 从本机 dsh-home 同步配置/插件/预设/会话到 WSL dsh-home（v0.2.0）：
 * 1. 复制配置层（排除 node_modules / pnpm 快照）：.agent-presets、sessions、storages、
 *    super-injector、profiles/web 的 package.json/pnpm-workspace.yaml/pnpm-lock.yaml/cordis*.yml、凭据散文件
 * 2. WSL 内 pnpm install 重建插件依赖（平台正确的二进制）
 * 调用方保证：同步在服务停止状态下进行（与备份同原子性规则）。
 */
async function syncFromWindows(emit?: (msg: string) => void, allowUac = false): Promise<PluginOpResult> {
  const s = loadSettings()
  const d = currentDistro()
  const winHome = dshHome()
  const wslHomeU = wslDshHomeWindows()
  const wslHomeL = wslDshHomeLinux()
  if (s.backend !== 'wsl' || !d || !wslHomeU || !wslHomeL) return { ok: false, message: '需要先切换到 WSL 后端并完成部署' }
  if (!existsSync(winHome)) return { ok: false, message: '本机 dsh-home 不存在' }
  const log = (m: string): void => {
    pushLog('同步: ' + m)
    emit?.(m)
  }
  // 配置层排除规则：node_modules 由 WSL 内 pnpm install 重建（平台不同），快照文件冗余，
  // .credentials.yaml 不同步——dsh 0.1.0-rc.6 在 WSL 内读它会卡死启动（实测），
  // API Key 由启动时从本机凭据解析并经环境变量注入
  const isSyncable = (rel: string): boolean => !/node_modules/.test(rel) && !/\.mkts-snapshot/.test(rel) && rel !== '.credentials.yaml'
  let copied = 0
  try {
    for (const entry of readdirSync(winHome, { withFileTypes: true })) {
      const rel = entry.name
      if (!isSyncable(rel)) continue
      const src = join(winHome, rel)
      const dst = toUnc(d, `${wslHomeL}/${rel}`)
      log(`${entry.isDirectory() ? '目录' : '文件'} ${rel} …`)
      if (entry.isDirectory()) {
        mkdirSync(dst, { recursive: true })
        cpSync(src, dst, { recursive: true, filter: isSyncable })
      } else {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
      copied++
    }
  } catch (e) {
    // 配置层复制失败才视为同步失败（不影响已复制部分）
    return { ok: false, message: '同步失败: ' + (e as Error).message }
  }
  // 会话 cwd 适配（v0.2.1 缺陷修复）：Windows 侧会话 header.cwd 是 Windows 路径
  // （如 D:\ai\测试），dsh 的 workspace 挂载要求 cwd 解析为真实目录且等于工作区，
  // 否则同步来的会话在 WSL 内不可见。复制后把 cwd 改写为 WSL 工作区路径并迁移
  // 会话目录到匹配的 projectKey 目录（Windows 侧原始数据不动）。best-effort：
  // 失败仅记日志，不阻断同步与服务启动。
  try {
    const ws = wslWorkspaceLinux()
    const wslSessions = wslDshHomeWindows()
    if (ws && wslSessions && existsSync(join(wslSessions, 'sessions'))) {
      const st = await migrateSessionCwds(join(wslSessions, 'sessions'), ws)
      if (st.rewritten > 0 || st.failed.length > 0) {
        log(`会话 cwd 适配 WSL 工作区（${ws}）：改写 ${st.rewritten}，迁移 ${st.moved}，跳过 ${st.skipped}${st.failed.length ? '，失败 ' + st.failed.length + '：' + st.failed.join('；') : ''}`)
      }
    }
  } catch (e) {
    pushLog('同步: 会话 cwd 适配失败: ' + (e as Error).message)
  }
  // 插件依赖重建（尽力而为：失败不阻断，服务可直接启动，稍后可手动重试）
  log('WSL 内 pnpm install 重建插件依赖（平台正确）…')
  const gh = await ensureWslGithubAccess(d, allowUac)
  if (!gh.ok) {
    pushLog('同步: GitHub 不可达 - ' + gh.message)
    await degradeToPureProfile(d)
    return { ok: true, message: `配置/预设/会话已同步（${copied} 项）；插件依赖重建跳过（${gh.message}）。WSL 服务以纯净模式启动，稍后可在「从本机同步」时授权打通 GitHub 后重试` }
  }
  const r = await runPnpm(['install'])
  if (r.code !== 0) {
    const last = r.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    await degradeToPureProfile(d)
    return { ok: true, message: `配置/预设/会话已同步（${copied} 项）；插件依赖重建失败（${last || 'exit ' + r.code}）。WSL 服务以纯净模式启动，稍后可手动重试同步` }
  }
  return { ok: true, message: `已从本机同步插件/预设/会话到 WSL（${copied} 项，依赖已重建）` }
}

/**
 * 插件依赖重建失败时，把 WSL profile 的 package.json 降级为**标准默认形态**
 * （备份原声明到 package.json.syncbak）——否则 dsh 启动时解析缺失的 bundle
 * 直接崩溃（cannot resolve profile bundle）；也不能写成空壳（实测 dsh 对
 * name≠dsh-profile-web 且无默认 bundles 的 package.json 会启动卡死）。
 * 标准形态 = dsh 首次启动自动生成的默认 web 组合（dsh-base + dsh-web-app）。
 * 手动同步成功（pnpm install 重写依赖）后自动恢复插件。
 */
const PURE_PROFILE_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    },
    null,
    2
  ) + '\n'

async function degradeToPureProfile(d: string): Promise<void> {
  const wslHomeL = wslDshHomeLinux()
  const profileL = wslHomeL ? `${wslHomeL}/profiles/web` : null
  if (!profileL) return
  const pkgPath = toUnc(d, `${profileL}/package.json`)
  try {
    if (existsSync(pkgPath)) {
      const bak = toUnc(d, `${profileL}/package.json.syncbak`)
      if (!existsSync(bak)) copyFileSync(pkgPath, bak)
    }
    writeFileSync(pkgPath, PURE_PROFILE_PACKAGE_JSON, 'utf8')
    pushLog('同步: 插件依赖重建失败，WSL profile 已降级为默认 web 组合（原声明备份为 package.json.syncbak）')
  } catch (e) {
    pushLog('同步: 纯净模式降级失败: ' + (e as Error).message)
  }
}

async function backendDiagnose(): Promise<string[]> {
  const lines: string[] = []
  const status = await runWslGlobal(['--status'], { silent: true })
  lines.push('--- wsl --status ---')
  lines.push(status.stdout.trim() || status.stderr.trim() || '(空)')
  const { distros, error } = await listDistros()
  lines.push('--- wsl -l -v ---')
  if (error) lines.push('枚举失败: ' + error)
  for (const d of distros) lines.push(`${d.name}  ${d.state}  WSL${d.version}${d.deployable ? '' : '（名称含特殊字符，不可部署）'}`)
  const distro = currentDistro()
  if (distro) {
    const ping = await pingDistro(distro, 15000)
    lines.push(`--- ping ${distro} ---`)
    lines.push(ping.ok ? 'ok' : ping.message)
    const node = wslNodeBin()
    if (node) {
      const nv = await runWsl([node, '--version'], { silent: true })
      lines.push(`node: ${(nv.stdout.trim().split('\n')[0]) || '不可用'}`)
    }
    lines.push(`dsh: ${wslInstalledVersion() ?? '未安装'}`)
  }
  return lines
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
  backendSetup: (distro: string) => runBackendSetup(distro),
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
