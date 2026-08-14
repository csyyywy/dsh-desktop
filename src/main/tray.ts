import { Menu, Tray, nativeImage, nativeTheme } from 'electron'
import type { Controller } from './controller'
import { iconPath } from './paths'

let tray: Tray | null = null

interface TrayDeps {
  controller: Controller
  openMain: () => void
  openDashboard: () => void
}

export function createTray(deps: TrayDeps): Tray {
  const dark = nativeTheme.shouldUseDarkColors
  let image = nativeImage.createFromPath(iconPath(dark ? 'tray-white.png' : 'tray.png'))
  if (image.isEmpty()) image = nativeImage.createFromPath(iconPath('tray.png'))
  if (image.isEmpty()) throw new Error('找不到托盘图标，请先运行 npm run icon')
  image = image.resize({ width: 16, height: 16 })

  tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness')
  refreshTrayMenu(deps)
  tray.on('double-click', deps.openMain)
  return tray
}

export function refreshTrayMenu(deps: TrayDeps): void {
  if (!tray) return
  const running = deps.controller.isRunning()
  const menu = Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: deps.openMain },
    { label: '仪表盘 / 设置', click: deps.openDashboard },
    { type: 'separator' },
    running
      ? { label: '停止服务', click: () => void deps.controller.stop() }
      : { label: '启动服务', click: () => void deps.controller.start() },
    { type: 'separator' },
    { label: '退出', click: () => deps.controller.quit() }
  ])
  tray.setContextMenu(menu)
}
