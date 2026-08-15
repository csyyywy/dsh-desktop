import type { AppSettings, AppStatus, AppUpdateInfo, AppUpdateResult, BackendInfo, BackendMode, FsEntry, FsSide, FsTransferRequest, FsTranslateResult, PluginInfo, PluginOpResult } from '../shared/types'

/** 外壳对外暴露的操作集合：IPC 与托盘都通过它驱动 */
export interface Controller {
  getStatus(): AppStatus
  start(): Promise<AppStatus>
  stop(): Promise<AppStatus>
  restart(): Promise<AppStatus>
  install(): Promise<AppStatus>
  update(version?: string): Promise<AppStatus>
  listVersions(): Promise<string[]>
  getSettings(): AppSettings
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getLogs(): string[]
  openWebUI(): void
  openDashboard(): void
  openDshHome(): Promise<void>
  openPluginsDir(): Promise<void>
  checkAppUpdate(): Promise<AppUpdateInfo>
  downloadAppUpdate(): Promise<AppUpdateResult & { path?: string }>
  installAppUpdate(): Promise<AppUpdateResult>
  listPlugins(): Promise<PluginInfo[]>
  searchPlugins(query: string, sort?: string, source?: string): Promise<PluginInfo[]>
  installPlugin(name: string, source?: string): Promise<PluginOpResult>
  uninstallPlugin(name: string): Promise<PluginOpResult>
  pickBackgroundImage(): Promise<string | null>
  openExternal(url: string): void
  listBackups(): Promise<string[]>
  restoreBackup(name: string): Promise<PluginOpResult>
  deleteBackup(name: string): PluginOpResult
  // v0.2.0：WSL 后端 + 文件桥
  backendInfo(): Promise<BackendInfo>
  backendSetMode(mode: BackendMode): Promise<BackendInfo>
  backendSetDistro(distro: string): Promise<BackendInfo>
  backendSetup(distro: string): Promise<PluginOpResult>
  backendInstallDistro(name: string): Promise<PluginOpResult>
  backendDiagnose(): Promise<string[]>
  backendForceCleanup(): Promise<PluginOpResult>
  fsbList(side: FsSide, path: string): Promise<FsEntry[]>
  fsbTransfer(jobs: FsTransferRequest[]): Promise<void>
  fsbCancel(id: string): Promise<void>
  fsbRemove(side: FsSide, path: string): Promise<PluginOpResult>
  fsbRename(side: FsSide, path: string, newName: string): Promise<PluginOpResult>
  fsbMkdir(side: FsSide, path: string): Promise<PluginOpResult>
  fsbTranslate(path: string): Promise<FsTranslateResult>
  fsbOpen(side: FsSide, path: string, terminal?: boolean): Promise<PluginOpResult>
  backendSyncFromWindows(): Promise<PluginOpResult>
  quit(): void
  isRunning(): boolean
}
