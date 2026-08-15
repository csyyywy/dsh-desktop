import type { AppSettings, AppStatus, AppUpdateInfo, AppUpdateResult, PluginInfo, PluginOpResult } from '../shared/types'

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
  installAppUpdate(): AppUpdateResult
  listPlugins(): Promise<PluginInfo[]>
  searchPlugins(query: string, sort?: string, source?: string): Promise<PluginInfo[]>
  installPlugin(name: string, source?: string): Promise<PluginOpResult>
  uninstallPlugin(name: string): Promise<PluginOpResult>
  pickBackgroundImage(): Promise<string | null>
  openExternal(url: string): void
  listBackups(): Promise<string[]>
  restoreBackup(name: string): Promise<PluginOpResult>
  quit(): void
  isRunning(): boolean
}
