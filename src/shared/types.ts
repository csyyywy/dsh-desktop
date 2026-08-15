// 主进程 / 预加载 / 渲染层共享的类型定义（仅类型，无运行时耦合）

export type Theme = 'dark' | 'light'

export interface AppSettings {
  /** dsh 锁定版本，'latest' 或具体 semver（如 0.1.0-rc.6） */
  dshVersion: string
  /** dsh 进程的默认工作区（cwd） */
  workspace: string
  /** dsh web 监听端口 */
  port: number
  /** 可选：通过 DEEPSEEK_API_KEY 环境变量注入 */
  apiKey: string
  /** 开机自启 */
  launchOnLogin: boolean
  /** 外壳主题 */
  theme: Theme
  /** 应用自更新仓库（owner/repo，空 = 禁用） */
  appUpdateRepo: string
  /** 仪表盘/启动页背景（CSS background 值：渐变或 url(...)） */
  background: string
  /** GitHub Personal Access Token，用于解除搜索频率限制（可选） */
  githubToken: string
}

export interface PluginInfo {
  name: string
  repo?: string
  version: string
  description: string
  installed: boolean
  stars: number
  updatedAt?: string
  npmUrl?: string
  repoUrl?: string
}

export interface PluginOpResult {
  ok: boolean
  message: string
}

export type ServerPhase = 'stopped' | 'installing' | 'starting' | 'running' | 'error'

export interface AppStatus {
  phase: ServerPhase
  running: boolean
  port: number
  url: string
  installedVersion: string | null
  latestVersion: string | null
  workspace: string
  dshHome: string
  appVersion: string
  /** 使用内置便携 Node 还是系统 Node */
  nodeLabel: 'bundled' | 'system'
  error: string | null
}

export interface InstallProgress {
  phase: string
  message: string
}

export interface AppUpdateInfo {
  enabled: boolean
  current: string
  latest: string | null
  hasUpdate: boolean
  url: string | null
  /** 最新版 NSIS 安装包（setup.exe）的下载直链（GitHub release 资产） */
  assetUrl: string | null
  /** 安装包大小（字节） */
  assetSize: number | null
}

/** 应用自更新（下载安装包）的结果 */
export interface AppUpdateResult {
  ok: boolean
  message: string
}

/** 应用自更新下载进度（主进程 → 渲染层推送） */
export interface AppUpdateProgress {
  phase: 'downloading' | 'verifying' | 'done' | 'error'
  /** 0-100 */
  percent: number
  receivedBytes: number
  totalBytes: number
  message: string
}

/** preload 暴露给渲染层（window.dsh）的 API 形状 */
export interface DshApi {
  getStatus(): Promise<AppStatus>
  start(): Promise<AppStatus>
  stop(): Promise<AppStatus>
  restart(): Promise<AppStatus>
  install(): Promise<AppStatus>
  update(version?: string): Promise<AppStatus>
  listVersions(): Promise<string[]>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getLogs(): Promise<string[]>
  openWebUI(): Promise<void>
  openDashboard(): Promise<void>
  openDshHome(): Promise<void>
  openPluginsDir(): Promise<void>
  checkAppUpdate(): Promise<AppUpdateInfo>
  downloadAppUpdate(): Promise<AppUpdateResult>
  installAppUpdate(): Promise<AppUpdateResult>
  onAppUpdateProgress(cb: (p: AppUpdateProgress) => void): () => void
  listPlugins(): Promise<PluginInfo[]>
  searchPlugins(query: string, sort?: string, source?: string): Promise<PluginInfo[]>
  installPlugin(name: string, source?: string): Promise<PluginOpResult>
  uninstallPlugin(name: string): Promise<PluginOpResult>
  pickBackgroundImage(): Promise<string | null>
  openExternal(url: string): Promise<void>
  listBackups(): Promise<string[]>
  restoreBackup(name: string): Promise<PluginOpResult>
  quit(): Promise<void>
  onStatusChanged(cb: (s: AppStatus) => void): () => void
  onLogLine(cb: (line: string) => void): () => void
  onInstallProgress(cb: (p: InstallProgress) => void): () => void
}
