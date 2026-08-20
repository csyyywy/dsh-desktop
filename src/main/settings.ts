import { app } from 'electron'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, BackendMode, Theme } from '../shared/types'
import { pushLog } from './log'

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
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    // B12：settings.json 损坏时备份原文件后回默认，避免静默丢配置且无从排查
    try {
      const bad = settingsPath()
      if (existsSync(bad)) {
        const bak = `${bad}.corrupt-${Date.now()}`
        renameSync(bad, bak)
        pushLog(`settings.json 解析失败，已备份到 ${bak}，使用默认设置`)
      }
    } catch {
      /* 备份失败忽略 */
    }
    return { ...DEFAULTS }
  }
  // B12：逐字段类型校验——port 写成字符串 "abc" 会原样传给 --port、
  // backend 写成任意值会走错分支；非法值一律回默认
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULTS }
  const p = raw as Record<string, unknown>
  const out: AppSettings = { ...DEFAULTS }
  if (typeof p.dshVersion === 'string') out.dshVersion = p.dshVersion
  if (typeof p.workspace === 'string') out.workspace = p.workspace
  if (typeof p.port === 'number' && Number.isFinite(p.port)) out.port = p.port
  if (typeof p.apiKey === 'string') out.apiKey = p.apiKey
  if (typeof p.launchOnLogin === 'boolean') out.launchOnLogin = p.launchOnLogin
  if (p.theme === 'dark' || p.theme === 'light') out.theme = p.theme as Theme
  if (typeof p.appUpdateRepo === 'string') out.appUpdateRepo = p.appUpdateRepo
  if (typeof p.background === 'string') out.background = p.background
  if (typeof p.githubToken === 'string') out.githubToken = p.githubToken
  if (p.backend === 'local' || p.backend === 'wsl') out.backend = p.backend as BackendMode
  if (typeof p.wslDistro === 'string') out.wslDistro = p.wslDistro
  if (typeof p.wslHome === 'string') out.wslHome = p.wslHome
  if (typeof p.wslPort === 'number' && Number.isFinite(p.wslPort)) out.wslPort = p.wslPort
  if (typeof p.npmRegistry === 'string') out.npmRegistry = p.npmRegistry
  return out
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

/**
 * 解析 DEEPSEEK_API_KEY：设置项优先，其次读本机 dsh-home/.credentials.yaml。
 * WSL 模式用：dsh 0.1.0-rc.6 在 WSL 内读 .credentials.yaml 会卡死（实测），
 * 因此该文件在 WSL 启动前被移走，Key 改经环境变量注入。
 */
export function windowsApiKey(): string {
  const s = loadSettings()
  if (s.apiKey) return s.apiKey
  try {
    const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8')
    const m = /DEEPSEEK_API_KEY\s*:\s*["']?([^\s"']+)/.exec(text)
    if (m) return m[1]
  } catch {
    /* 无凭据文件 */
  }
  return ''
}
