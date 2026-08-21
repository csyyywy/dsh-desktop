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
  /** 运行后端：本机（默认）或 WSL 发行版内 */
  backend: BackendMode
  /** WSL 发行版名（backend=wsl 时生效；空 = 未配置） */
  wslDistro: string
  /** 发行版内默认用户的 HOME（backendSetup 时解析写入） */
  wslHome: string
  /** WSL 后端 dsh 监听端口（独立于本机 port，避免与 Windows 侧服务冲突） */
  wslPort: number
  /** WSL 内 npm 镜像 registry（可选，空 = 官方源） */
  npmRegistry: string
  /** 仅回传渲染层：是否已保存 API Key（密钥本身不再下发渲染层，write-only 输入） */
  hasApiKey?: boolean
  /** 仅回传渲染层：是否已保存 GitHub Token（同上） */
  hasGithubToken?: boolean
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

/** 插件更新检查结果（installed 版本 vs 最新可用版本） */
export interface PluginUpdateInfo {
  name: string
  /** 已装版本（git 依赖为当前锁定 commit 短哈希） */
  current: string
  /** 最新可用版本（git 依赖为远端 HEAD 短哈希） */
  latest: string
  updateAvailable: boolean
  /** 检查失败原因（网络/限流等），有值时 updateAvailable 恒为 false */
  error?: string
  /** 非失败的中性说明（如"本地链接依赖"），UI 用灰色徽标展示，不算错误 */
  note?: string
}

export interface PluginOpResult {
  ok: boolean
  message: string
  /** 安装前预检检测到的冲突明细（v0.3.0：先检测再安装） */
  conflicts?: string[]
  /** 安装前预检的提示（非阻断） */
  warnings?: string[]
  /** 非空 = 安装被 pnpm 拦截的构建脚本包清单；用户确认后原样传回 install/update 重试 */
  buildApprovals?: string[]
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
  /** 当前运行后端 */
  backend: BackendMode
  /** WSL 发行版名（backend=wsl 时非空） */
  wslDistro: string | null
  /** WSL 后端是否已部署就绪 */
  wslReady: boolean
  /** WSL 内 dsh 残留进程 pid（无法自动清理时） */
  stalePid: number | null
  /** 端口自愈提示（v0.3.0：如"端口 3080 被占用，已自动切换到 3085"） */
  portNote: string | null
  /** 启动失败时的插件冲突恢复信息（v0.3.0：#81/#94/#96/#98 移植） */
  recovery: PluginRecoveryInfo | null
}

/** 可执行的恢复目标（问题插件） */
export interface PluginRecoveryTarget {
  /** 真实 npm 包名（可执行卸载；内部标识无法映射时为 null） */
  name: string | null
  /** 界面展示名（内部标识时用友好名） */
  displayName: string
  /** 冲突/失败原因 */
  reason: string
}

/** 启动失败恢复信息（v0.3.0） */
export interface PluginRecoveryInfo {
  /** 可卸载的目标；为空表示无法定位到可卸载插件（仍提供重置数据） */
  offending: PluginRecoveryTarget[]
  /** 失败原因摘要（面向用户） */
  message: string
  /** 是否提供「重置数据」恢复选项 */
  canReset: boolean
}

/** 手动备份存档（v0.3.0，独立界面） */
export interface ManualBackupInfo {
  /** 存档文件名（含扩展名，用于回退/删除） */
  name: string
  size: number
  createdAt: number
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
  /** 安装包 SHA256 摘要（GitHub API digest 字段，格式 "sha256:<hex>"，可能缺失） */
  assetDigest?: string | null
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
  /** v0.3.0：服务运行后由 Splash 自关闭（含恢复成功后） */
  closeSplash(): Promise<void>
  /** 打开备份根目录（dataDir/backups，含自动快照与手动存档） */
  openBackupsDir(): Promise<void>
  openDshHome(): Promise<void>
  openPluginsDir(): Promise<void>
  checkAppUpdate(): Promise<AppUpdateInfo>
  downloadAppUpdate(): Promise<AppUpdateResult>
  installAppUpdate(): Promise<AppUpdateResult>
  onAppUpdateProgress(cb: (p: AppUpdateProgress) => void): () => void
  listPlugins(): Promise<PluginInfo[]>
  searchPlugins(query: string, sort?: string, source?: string): Promise<PluginInfo[]>
  installPlugin(name: string, source?: string, approvedBuilds?: string[]): Promise<PluginOpResult>
  /** 安装前冲突预检（v0.3.0：先检测再安装） */
  preflightPlugin(name: string, source?: string): Promise<PluginOpResult>
  uninstallPlugin(name: string): Promise<PluginOpResult>
  /** 检查所有已安装插件的可用更新（npm 包查 registry latest；git 依赖查远端 HEAD） */
  checkPluginUpdates(): Promise<PluginUpdateInfo[]>
  /** 更新指定已安装插件到最新版本 */
  updatePlugin(name: string, approvedBuilds?: string[]): Promise<PluginOpResult>
  pickBackgroundImage(): Promise<string | null>
  openExternal(url: string): Promise<void>
  listBackups(): Promise<string[]>
  restoreBackup(name: string): Promise<PluginOpResult>
  deleteBackup(name: string): Promise<PluginOpResult>
  // ---------- v0.3.0：备份独立界面 + 手动存档 ----------
  backupCreateManual(label?: string): Promise<PluginOpResult>
  backupListManual(): Promise<ManualBackupInfo[]>
  backupRestoreManual(name: string): Promise<PluginOpResult>
  backupDeleteManual(name: string): Promise<PluginOpResult>
  // ---------- v0.3.0：启动失败恢复 ----------
  recoveryUninstallRetry(name: string): Promise<PluginOpResult>
  recoveryResetData(): Promise<PluginOpResult>
  quit(): Promise<void>
  onStatusChanged(cb: (s: AppStatus) => void): () => void
  onLogLine(cb: (line: string) => void): () => void
  onInstallProgress(cb: (p: InstallProgress) => void): () => void
  // ---------- v0.2.0：WSL 后端 + 文件桥 ----------
  backendInfo(): Promise<BackendInfo>
  backendSetMode(mode: BackendMode): Promise<BackendInfo>
  backendSetDistro(distro: string): Promise<BackendInfo>
  backendSetup(distro: string): Promise<PluginOpResult>
  /** 从本机 dsh-home 同步插件/预设/会话到 WSL（停服执行，完成后恢复原状态） */
  backendSyncFromWindows(): Promise<PluginOpResult>
  backendInstallDistro(name: string): Promise<PluginOpResult>
  backendDiagnose(): Promise<string[]>
  backendForceCleanup(): Promise<PluginOpResult>
  onBackendSetupProgress(cb: (p: BackendSetupProgress) => void): () => void
  /** 拖拽文件 → 本地绝对路径（Electron webUtils） */
  getPathForFile(file: File): string
  fsbList(side: FsSide, path: string): Promise<FsEntry[]>
  fsbTransfer(jobs: FsTransferRequest[]): Promise<void>
  fsbCancel(id: string): Promise<void>
  fsbRemove(side: FsSide, path: string): Promise<PluginOpResult>
  fsbRename(side: FsSide, path: string, newName: string): Promise<PluginOpResult>
  fsbMkdir(side: FsSide, path: string): Promise<PluginOpResult>
  fsbTranslate(path: string): Promise<FsTranslateResult>
  fsbOpen(side: FsSide, path: string, terminal?: boolean): Promise<PluginOpResult>
  onFsbProgress(cb: (p: FsTransferProgress) => void): () => void
}

// ---------- v0.2.0：WSL 后端 ----------

export type BackendMode = 'local' | 'wsl'

/** wsl -l -v 解析出的发行版信息 */
export interface WslDistroInfo {
  name: string
  state: string
  version: string
  /** 名称是否满足部署白名单（^[A-Za-z0-9._-]+$，不含空格/特殊字符） */
  deployable: boolean
}

export interface BackendInfo {
  mode: BackendMode
  distro: string | null
  distros: WslDistroInfo[]
  /** WSL 后端是否已部署就绪（bin/pidfile 可寻址） */
  ready: boolean
  wslVersion: string | null
  kernelVersion: string | null
  error: string | null
}

/** backend:setup 的阶段进度（主进程 → 渲染层） */
export interface BackendSetupProgress {
  stage: 'ready' | 'mkdir' | 'node' | 'pnpm' | 'npm-install' | 'verify'
  percent: number
  message: string
}

// ---------- v0.2.0：文件桥 ----------

export type FsSide = 'win' | 'wsl'

export interface FsEntry {
  name: string
  /** 所在侧路径：win = Windows 路径；wsl = Linux 路径（不含 UNC 前缀） */
  path: string
  isDir: boolean
  size: number
  mtime: number
}

export interface FsTransferRequest {
  id: string
  srcSide: FsSide
  /** 源文件（win = Windows 路径；wsl = Linux 路径） */
  srcPath: string
  dstSide: FsSide
  /** 目标目录（win = Windows 路径；wsl = Linux 路径） */
  dstPath: string
  move: boolean
  overwrite?: boolean
}

export interface FsTransferProgress {
  id: string
  name: string
  srcPath: string
  dstPath: string
  srcSide: FsSide
  dstSide: FsSide
  phase: 'queued' | 'copying' | 'done' | 'error' | 'cancelled'
  /** 已复制字节 */
  done: number
  /** 源文件总字节 */
  total: number
  bytesPerSec: number
  message?: string
}

export interface FsTranslateResult {
  /** Windows 侧可访问的 UNC 路径（\\wsl.localhost\<distro>\...），对任意 WSL 路径有效 */
  windows: string
  /** Windows 盘符映射（wslpath -w，仅对 /mnt/* 等 automount 路径有效），不可用时为 null */
  windowsLocal: string | null
  /** Linux 侧绝对路径 */
  linux: string
  /** 输入路径的判定类别 */
  kind: 'win' | 'wsl-unc' | 'linux'
}
