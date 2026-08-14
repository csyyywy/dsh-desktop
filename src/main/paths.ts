import { app } from 'electron'
import { join } from 'node:path'

export function iconPath(name: string): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(app.getAppPath(), 'resources', 'icons')
  return join(base, name)
}
