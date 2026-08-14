import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppSettings, AppStatus, DshApi, InstallProgress } from '../shared/types'

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
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  searchPlugins: (query: string, sort?: string, source?: string) => ipcRenderer.invoke('plugins:search', query, sort, source),
  installPlugin: (name: string, source?: string) => ipcRenderer.invoke('plugins:install', name, source),
  uninstallPlugin: (name: string) => ipcRenderer.invoke('plugins:uninstall', name),
  pickBackgroundImage: () => ipcRenderer.invoke('app:pickBackgroundImage'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  listBackups: () => ipcRenderer.invoke('plugins:backups'),
  restoreBackup: (name: string) => ipcRenderer.invoke('plugins:restoreBackup', name),
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
  }
}

contextBridge.exposeInMainWorld('dsh', api)
