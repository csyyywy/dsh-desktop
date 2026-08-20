import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AppSettings, AppStatus, AppUpdateProgress, BackendMode, BackendSetupProgress, DshApi, FsSide, FsTransferProgress, FsTransferRequest, InstallProgress } from '../shared/types'

const api: DshApi = {
  getStatus: () => ipcRenderer.invoke('status:get'),
  start: () => ipcRenderer.invoke('server:start'),
  stop: () => ipcRenderer.invoke('server:stop'),
  restart: () => ipcRenderer.invoke('server:restart'),
  install: () => ipcRenderer.invoke('dsh:install'),
  update: (version?: string) => ipcRenderer.invoke('dsh:update', version),
  listVersions: () => ipcRenderer.invoke('dsh:versions'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', patch),
  getLogs: () => ipcRenderer.invoke('logs:get'),
  openWebUI: () => ipcRenderer.invoke('app:openWebUI'),
  openDashboard: () => ipcRenderer.invoke('app:openDashboard'),
  openDshHome: () => ipcRenderer.invoke('app:openDshHome'),
  openPluginsDir: () => ipcRenderer.invoke('app:openPluginsDir'),
  checkAppUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  downloadAppUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
  installAppUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  searchPlugins: (query: string, sort?: string, source?: string) => ipcRenderer.invoke('plugins:search', query, sort, source),
  preflightPlugin: (name: string, source?: string) => ipcRenderer.invoke('plugins:preflight', name, source),
  installPlugin: (name: string, source?: string) => ipcRenderer.invoke('plugins:install', name, source),
  uninstallPlugin: (name: string) => ipcRenderer.invoke('plugins:uninstall', name),
  checkPluginUpdates: () => ipcRenderer.invoke('plugins:checkUpdates'),
  updatePlugin: (name: string) => ipcRenderer.invoke('plugins:update', name),
  pickBackgroundImage: () => ipcRenderer.invoke('app:pickBackgroundImage'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  listBackups: () => ipcRenderer.invoke('plugins:backups'),
  restoreBackup: (name: string) => ipcRenderer.invoke('plugins:restoreBackup', name),
  deleteBackup: (name: string) => ipcRenderer.invoke('plugins:deleteBackup', name),
  backupCreateManual: (label?: string) => ipcRenderer.invoke('backup:createManual', label),
  backupListManual: () => ipcRenderer.invoke('backup:listManual'),
  backupRestoreManual: (name: string) => ipcRenderer.invoke('backup:restoreManual', name),
  backupDeleteManual: (name: string) => ipcRenderer.invoke('backup:deleteManual', name),
  recoveryUninstallRetry: (name: string) => ipcRenderer.invoke('recovery:uninstallRetry', name),
  recoveryResetData: () => ipcRenderer.invoke('recovery:resetData'),
  quit: () => ipcRenderer.invoke('app:quit'),
  onStatusChanged: (cb) => {
    const h = (_e: IpcRendererEvent, s: AppStatus): void => cb(s)
    ipcRenderer.on('status:changed', h)
    return () => ipcRenderer.removeListener('status:changed', h)
  },
  onLogLine: (cb) => {
    const h = (_e: IpcRendererEvent, line: string): void => cb(line)
    ipcRenderer.on('log:line', h)
    return () => ipcRenderer.removeListener('log:line', h)
  },
  onInstallProgress: (cb) => {
    const h = (_e: IpcRendererEvent, p: InstallProgress): void => cb(p)
    ipcRenderer.on('install:progress', h)
    return () => ipcRenderer.removeListener('install:progress', h)
  },
  onAppUpdateProgress: (cb) => {
    const h = (_e: IpcRendererEvent, p: AppUpdateProgress): void => cb(p)
    ipcRenderer.on('app:updateProgress', h)
    return () => ipcRenderer.removeListener('app:updateProgress', h)
  },
  // v0.2.0：WSL 后端
  backendInfo: () => ipcRenderer.invoke('backend:info'),
  backendSetMode: (mode: BackendMode) => ipcRenderer.invoke('backend:setMode', mode),
  backendSetDistro: (distro: string) => ipcRenderer.invoke('backend:setDistro', distro),
  backendSetup: (distro: string) => ipcRenderer.invoke('backend:setup', distro),
  backendSyncFromWindows: () => ipcRenderer.invoke('backend:syncFromWindows'),
  backendInstallDistro: (name: string) => ipcRenderer.invoke('backend:installDistro', name),
  backendDiagnose: () => ipcRenderer.invoke('backend:diagnose'),
  backendForceCleanup: () => ipcRenderer.invoke('backend:forceCleanup'),
  onBackendSetupProgress: (cb) => {
    const h = (_e: IpcRendererEvent, p: BackendSetupProgress): void => cb(p)
    ipcRenderer.on('backend:setupProgress', h)
    return () => ipcRenderer.removeListener('backend:setupProgress', h)
  },
  // v0.2.0：文件桥
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  fsbList: (side: FsSide, path: string) => ipcRenderer.invoke('fsb:list', side, path),
  fsbTransfer: (jobs: FsTransferRequest[]) => ipcRenderer.invoke('fsb:transfer', jobs),
  fsbCancel: (id: string) => ipcRenderer.invoke('fsb:cancel', id),
  fsbRemove: (side: FsSide, path: string) => ipcRenderer.invoke('fsb:remove', side, path),
  fsbRename: (side: FsSide, path: string, newName: string) => ipcRenderer.invoke('fsb:rename', side, path, newName),
  fsbMkdir: (side: FsSide, path: string) => ipcRenderer.invoke('fsb:mkdir', side, path),
  fsbTranslate: (path: string) => ipcRenderer.invoke('fsb:translate', path),
  fsbOpen: (side: FsSide, path: string, terminal?: boolean) => ipcRenderer.invoke('fsb:open', side, path, terminal),
  onFsbProgress: (cb) => {
    const h = (_e: IpcRendererEvent, p: FsTransferProgress): void => cb(p)
    ipcRenderer.on('fsb:progress', h)
    return () => ipcRenderer.removeListener('fsb:progress', h)
  }
}

contextBridge.exposeInMainWorld('dsh', api)
