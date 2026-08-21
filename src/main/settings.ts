import { app, safeStorage } from 'electron'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, BackendMode, Theme } from '../shared/types'
import { pushLog } from './log'

// 密钥静态加密（safeStorage/DPAPI）：settings.json 里的 apiKey/githubToken 不再明文落盘。
// 前缀 enc:v1: 标识密文；解密失败（换用户/损坏）按空处理并告警，不阻断启动。
const ENC_PREFIX = 'enc:v1:'

function encryptSecret(plain: string): string {
  if (!plain || plain.startsWith(ENC_PREFIX)) return plain
  try {
    if (!safeStorage.isEncryptionAvailable()) return plain
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return plain
  }
}

function decryptSecret(stored: unknown): string {
  if (typeof stored !== 'string') return ''
  if (!stored.startsWith(ENC_PREFIX)) return stored // 兼容历史明文，下次保存时加密
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch (e) {
    pushLog('settings.json 中的密文密钥解密失败（可能更换了系统用户），已按空处理')
    return ''
  }
}

/** 渲染层脱敏：密钥不下发，只给「是否已设置」布尔位（write-only 输入语义） */
export function redactSettingsForRenderer(s: AppSettings): AppSettings {
  return { ...s, apiKey: '', githubToken: '', hasApiKey: !!s.apiKey, hasGithubToken: !!s.githubToken }
}

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
  out.apiKey = decryptSecret(p.apiKey)
  if (typeof p.launchOnLogin === 'boolean') out.launchOnLogin = p.launchOnLogin
  if (p.theme === 'dark' || p.theme === 'light') out.theme = p.theme as Theme
  if (typeof p.appUpdateRepo === 'string') out.appUpdateRepo = p.appUpdateRepo
  if (typeof p.background === 'string') out.background = p.background
  out.githubToken = decryptSecret(p.githubToken)
  if (p.backend === 'local' || p.backend === 'wsl') out.backend = p.backend as BackendMode
  if (typeof p.wslDistro === 'string') out.wslDistro = p.wslDistro
  if (typeof p.wslHome === 'string') out.wslHome = p.wslHome
  if (typeof p.wslPort === 'number' && Number.isFinite(p.wslPort)) out.wslPort = p.wslPort
  if (typeof p.npmRegistry === 'string') out.npmRegistry = p.npmRegistry
  return out
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...sanitizePatch(patch) }
  mkdirSync(dataDir(), { recursive: true })
  // 落盘前把密钥加密（内存中的 next 保持明文，供主进程使用）
  const toStore: AppSettings = { ...next, apiKey: encryptSecret(next.apiKey), githubToken: encryptSecret(next.githubToken) }
  const p = settingsPath()
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(toStore, null, 2), 'utf8')
  renameSync(tmp, p)
  return next
}

/** 校验设置补丁（Q6）：只接受已知键 + 正确类型——IPC 的 settings:set 是渲染层直传，
 *  任意键/错误类型（如 port 写成字符串）会污染 settings.json。非法键直接丢弃。 */
function sanitizePatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
  const p = patch as Record<string, unknown>
  const pick = <K extends keyof AppSettings>(key: K, check: (v: unknown) => boolean): void => {
    if (check(p[key])) out[key] = p[key] as AppSettings[K]
  }
  pick('dshVersion', (v) => typeof v === 'string')
  pick('workspace', (v) => typeof v === 'string')
  pick('port', (v) => typeof v === 'number' && Number.isFinite(v))
  pick('apiKey', (v) => typeof v === 'string')
  pick('launchOnLogin', (v) => typeof v === 'boolean')
  pick('theme', (v) => v === 'dark' || v === 'light')
  pick('appUpdateRepo', (v) => typeof v === 'string')
  pick('background', (v) => typeof v === 'string')
  pick('githubToken', (v) => typeof v === 'string')
  pick('backend', (v) => v === 'local' || v === 'wsl')
  pick('wslDistro', (v) => typeof v === 'string')
  pick('wslHome', (v) => typeof v === 'string')
  pick('wslPort', (v) => typeof v === 'number' && Number.isFinite(v))
  pick('npmRegistry', (v) => typeof v === 'string')
  return out
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
