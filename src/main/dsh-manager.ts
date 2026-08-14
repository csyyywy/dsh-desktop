// dsh 本体生命周期：解析运行时（内置/系统 Node）、安装、版本查询、更新/回滚。
// 只通过 npm 安装官方 @deepseek-ai/dsh，绝不改其源码。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './settings'
import { pushLog } from './log'

export interface Runtime {
  node: string
  npmCli: string | null
  useShell: boolean
  label: 'bundled' | 'system'
}

function bundledNodeDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'node')
    : join(app.getAppPath(), 'resources', 'node')
}

export function resolveRuntime(): Runtime {
  const base = bundledNodeDir()
  const nodeExe = join(base, 'node.exe')
  const npmCli = join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(nodeExe)) {
    return { node: nodeExe, npmCli, useShell: false, label: 'bundled' }
  }
  return {
    node: process.platform === 'win32' ? 'node.exe' : 'node',
    npmCli: null,
    useShell: process.platform === 'win32',
    label: 'system'
  }
}

export function dshBin(): string {
  return join(dataDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

export function isInstalled(): boolean {
  return existsSync(dshBin())
}

/** dsh 依赖树的哨兵包：任一缺失即视为安装不完整（防止 cpSync 部分复制被误判为已安装） */
const REQUIRED_PKGS = ['zod', 'yaml', 'sharp', 'typebox']

export function isComplete(): boolean {
  if (!isInstalled()) return false
  const nm = join(dataDir(), 'node_modules')
  for (const pkg of REQUIRED_PKGS) {
    if (!existsSync(join(nm, pkg, 'package.json'))) return false
  }
  return true
}

function bundledDshDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'dsh-bundle')
    : join(app.getAppPath(), 'resources', 'dsh-bundle')
}

export function hasBundledDsh(): boolean {
  return existsSync(join(bundledDshDir(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
}

/** 从内置 bundle 复制到 data/，避免首次联网安装；无 bundle 或失败返回 false */
export function restoreBundledDsh(): boolean {
  if (isComplete()) return true
  if (!hasBundledDsh()) return false
  const src = bundledDshDir()
  const dest = dataDir()
  mkdirSync(dest, { recursive: true })
  // 先清理不完整/残留的 node_modules，避免旧数据干扰复制与校验
  rmSync(join(dest, 'node_modules'), { recursive: true, force: true })
  try {
    for (const entry of ['node_modules', 'package.json', 'package-lock.json']) {
      const s = join(src, entry)
      if (existsSync(s)) cpSync(s, join(dest, entry), { recursive: true })
    }
  } catch (e) {
    pushLog('恢复内置 dsh 失败: ' + (e as Error).message)
    rmSync(join(dest, 'node_modules'), { recursive: true, force: true })
    return false
  }
  // 完整性校验：cpSync 可能因长路径/文件占用而部分复制，缺依赖却仍留下 bin.js
  if (!isComplete()) {
    pushLog('恢复内置 dsh 不完整，清理后改用在线安装')
    rmSync(join(dest, 'node_modules'), { recursive: true, force: true })
    return false
  }
  return true
}

export function installedVersion(): string | null {
  try {
    const p = join(dataDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch {
    return null
  }
}

export async function latestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
        signal: controller.signal
      })
      if (!res.ok) return null
      const j = (await res.json()) as { version?: string }
      return j.version ?? null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

export async function listVersions(): Promise<string[]> {
  try {
    const res = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh')
    if (!res.ok) return []
    const j = (await res.json()) as { versions?: Record<string, unknown> }
    // registry 以发布顺序列出，倒序即最新在前
    return Object.keys(j.versions ?? {}).reverse()
  } catch {
    return []
  }
}

/** 运行 npm（内置 node 直接跑 npm-cli.js；系统回退走 shell） */
export function runNpm(args: string[], onLine?: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const rt = resolveRuntime()
    const useShell = rt.npmCli == null && process.platform === 'win32'
    const cmd = rt.npmCli ? rt.node : useShell ? 'npm.cmd' : 'npm'
    const argv = rt.npmCli ? [rt.npmCli, ...args] : args
    pushLog(`$ ${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, argv, { shell: useShell, windowsHide: true, env: process.env })
    const emit = (buf: Buffer): void => {
      for (const l of buf.toString().split(/\r?\n/)) {
        if (l.trim()) {
          pushLog(l)
          onLine?.(l)
        }
      }
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/** 安装/升级/回滚 dsh 到指定版本（'latest' 或具体 semver） */
export function installDsh(version: string, onLine?: (line: string) => void): Promise<number> {
  const target = version === 'latest' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${version}`
  return runNpm(['install', '--prefix', dataDir(), '--no-audit', '--no-fund', target], onLine)
}
