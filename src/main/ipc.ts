import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { Controller } from './controller'

export function registerIpc(
  controller: Controller,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean
): void {
  // 统一来源校验：只接受本应用自身窗口 webContents 的调用（纵深防御——
  // 即便未来有内容被导航进窗口，也无法直接驱动这些 handler）
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      if (!isTrustedSender(e)) throw new Error('非法调用来源')
      return (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(e, ...args)
    })
  }
  handle('status:get', () => controller.getStatus())
  handle('server:start', () => controller.start())
  handle('server:stop', () => controller.stop())
  handle('server:restart', () => controller.restart())
  handle('dsh:install', () => controller.install())
  handle('dsh:update', (_e, version?: string) => controller.update(version))
  handle('dsh:versions', () => controller.listVersions())
  handle('settings:get', () => controller.getSettings())
  handle('settings:set', (_e, patch) => controller.setSettings(patch))
  handle('logs:get', () => controller.getLogs())
  handle('app:openWebUI', () => controller.openWebUI())
  handle('app:openDashboard', () => controller.openDashboard())
  handle('app:closeSplash', () => controller.closeSplash())
  handle('app:openBackupsDir', () => controller.openBackupsDir())
  handle('app:openDshHome', () => controller.openDshHome())
  handle('app:openPluginsDir', () => controller.openPluginsDir())
  handle('app:checkUpdate', () => controller.checkAppUpdate())
  handle('app:downloadUpdate', () => controller.downloadAppUpdate())
  handle('app:installUpdate', () => controller.installAppUpdate())
  handle('plugins:list', () => controller.listPlugins())
  handle('plugins:search', (_e, query: string, sort?: string, source?: string) => controller.searchPlugins(query, sort, source))
  handle('plugins:preflight', (_e, name: string, source?: string) => controller.preflightPlugin(name, source))
  handle('plugins:install', (_e, name: string, source?: string, approvedBuilds?: string[]) =>
    controller.installPlugin(name, source, Array.isArray(approvedBuilds) ? approvedBuilds.filter((x) => typeof x === 'string') : undefined))
  handle('plugins:uninstall', (_e, name: string) => controller.uninstallPlugin(name))
  handle('plugins:checkUpdates', () => controller.checkPluginUpdates())
  handle('plugins:update', (_e, name: string, approvedBuilds?: string[]) =>
    controller.updatePlugin(name, Array.isArray(approvedBuilds) ? approvedBuilds.filter((x) => typeof x === 'string') : undefined))
  handle('app:pickBackgroundImage', () => controller.pickBackgroundImage())
  handle('app:openExternal', (_e, url: string) => controller.openExternal(url))
  handle('plugins:backups', () => controller.listBackups())
  handle('plugins:restoreBackup', (_e, name: string) => controller.restoreBackup(name))
  handle('plugins:deleteBackup', (_e, name: string) => controller.deleteBackup(name))
  // v0.3.0：备份独立界面 + 手动存档
  handle('backup:createManual', (_e, label?: string) => controller.backupCreateManual(label))
  handle('backup:listManual', () => controller.backupListManual())
  handle('backup:restoreManual', (_e, name: string) => controller.backupRestoreManual(name))
  handle('backup:deleteManual', (_e, name: string) => controller.backupDeleteManual(name))
  // v0.3.0：启动失败恢复
  handle('recovery:uninstallRetry', (_e, name: string) => controller.recoveryUninstallRetry(name))
  handle('recovery:resetData', () => controller.recoveryResetData())
  handle('recovery:restart', () => controller.recoveryRestart())
  // v0.2.0：WSL 后端
  handle('backend:info', () => controller.backendInfo())
  handle('backend:setMode', (_e, mode: 'local' | 'wsl') => controller.backendSetMode(mode))
  handle('backend:setDistro', (_e, distro: string) => controller.backendSetDistro(distro))
  handle('backend:setup', (_e, distro: string) => controller.backendSetup(distro))
  handle('backend:syncFromWindows', () => controller.backendSyncFromWindows())
  handle('backend:installDistro', (_e, name: string) => controller.backendInstallDistro(name))
  handle('backend:diagnose', () => controller.backendDiagnose())
  handle('backend:forceCleanup', () => controller.backendForceCleanup())
  // v0.2.0：文件桥
  handle('fsb:list', (_e, side: 'win' | 'wsl', path: string) => controller.fsbList(side, path))
  handle('fsb:transfer', (_e, jobs: Parameters<Controller['fsbTransfer']>[0]) => controller.fsbTransfer(jobs))
  handle('fsb:cancel', (_e, id: string) => controller.fsbCancel(id))
  handle('fsb:remove', (_e, side: 'win' | 'wsl', path: string) => controller.fsbRemove(side, path))
  handle('fsb:rename', (_e, side: 'win' | 'wsl', path: string, newName: string) => controller.fsbRename(side, path, newName))
  handle('fsb:mkdir', (_e, side: 'win' | 'wsl', path: string) => controller.fsbMkdir(side, path))
  handle('fsb:translate', (_e, path: string) => controller.fsbTranslate(path))
  handle('fsb:open', (_e, side: 'win' | 'wsl', path: string, terminal?: boolean) => controller.fsbOpen(side, path, terminal))
  handle('app:quit', () => controller.quit())
}
