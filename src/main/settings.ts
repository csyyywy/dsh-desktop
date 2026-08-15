import { app } from 'electron'
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../shared/types'

const DEFAULTS: AppSettings = {
  dshVersion: 'latest',
  workspace: '',
  port: 3080,
  apiKey: '',
  launchOnLogin: false,
  theme: 'dark',
  appUpdateRepo: 'csyyywy/dsh-desktop',
  background: 'radial-gradient(140% 140% at 10% -10%, #1b2547 0%, #0b1020 55%, #0a0d18 100%)',
  githubToken: '',
  backend: 'local',
  wslDistro: '',
  wslHome: '',
  wslPort: 3081,
  npmRegistry: 'https://registry.npmmirror.com'
}

/** 是否为便携/绿色版（数据目录紧邻 exe），而不是安装版（数据在 userData） */
function isPortable(): boolean {
  if (process.env.DSH_DESKTOP_PORTABLE === '1') return true
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true
  try {
    const exeDir = dirname(process.execPath)
    accessSync(exeDir, constants.W_OK)
    // 装在 Program Files 下视为安装版；其余可写目录视为绿色版
    return !/program files/i.test(exeDir)
  } catch {
    return false
  }
}

/** 运行时数据根目录：便携版在 exe 同级 data/，安装版在 userData */
export function dataDir(): string {
  const override = process.env.DSH_DESKTOP_DATA_DIR
  if (override) return override
  if (!app.isPackaged) return join(app.getAppPath(), 'data')
  // 单文件便携版：PORTABLE_EXECUTABLE_FILE 是便携 exe 原始路径，数据放它旁边（而非临时解压目录）
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return join(dirname(process.env.PORTABLE_EXECUTABLE_FILE), 'data')
  }
  if (isPortable()) return join(dirname(process.execPath), 'data')
  return app.getPath('userData')
}

/** dsh 自身的 HOME（$DSH_HOME），配置文件 / 插件 / 会话都在这里 */
export function dshHome(): string {
  return join(dataDir(), 'dsh-home')
}

function settingsPath(): string {
  return join(dataDir(), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  mkdirSync(dataDir(), { recursive: true })
  const p = settingsPath()
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, p)
  return next
}
