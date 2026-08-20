// dsh 本体生命周期：解析运行时（内置/系统 Node）、安装、版本查询、更新/回滚。
// 只通过 npm 安装官方 @deepseek-ai/dsh，绝不改其源码。
import { app } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dataDir, loadSettings } from './settings'
import { pushLog } from './log'
import { curlJson } from './net'
import { currentDistro, runWsl, runWslBash, toUnc, wslBaseLinux, wslDshBinLinux, wslNpmCli, wslNodeBin, bashQuote } from './wsl'

// 临时诊断：把运行时解析与 spawn 的真实错误落盘到 %TEMP%/dsh-runtime-diag.log，
// 用于排查「文件存在却 spawn ENOENT」类问题（排查完成后可删除）。
const DIAG_PATH = join(tmpdir(), 'dsh-runtime-diag.log')
export function diag(line: string): void {
  try {
    appendFileSync(DIAG_PATH, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 忽略诊断写入失败 */
  }
}

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

/** 探测内置 Node 是否真正可执行：文件存在 ≠ 能跑（安全软件可能拦截/文件损坏） */
function nodeUsable(nodeExe: string): boolean {
  try {
    const r = spawnSync(nodeExe, ['--version'], { timeout: 8000, windowsHide: true })
    const er = r.error as NodeJS.ErrnoException | undefined
    diag(`nodeUsable: status=${r.status} signal=${r.signal} errno=${er?.errno} code=${er?.code} message=${er?.message ?? ''} stdout=${(r.stdout ?? Buffer.alloc(0)).toString().trim()}`)
    return r.status === 0 && !!r.stdout?.toString().trim()
  } catch (e) {
    diag(`nodeUsable throw: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// Q3：resolveRuntime 结果缓存。buildStatus/getStatus 每次调用都会走到 nodeUsable
// （同步 spawnSync，最坏 8s），若内置 node 被安全软件拦截会冻结主进程。
// 内置 node 位置构建期固化、进程生命周期内不变，缓存安全；安装/更新后显式失效。
let runtimeCache: Runtime | null = null

export function invalidateRuntimeCache(): void {
  runtimeCache = null
}

export function resolveRuntime(): Runtime {
  if (runtimeCache) return runtimeCache
  const base = bundledNodeDir()
  const nodeExe = join(base, 'node.exe')
  const npmCli = join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  diag(`resolveRuntime: isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath} arch=${process.arch} platform=${process.platform} execPath=${process.execPath}`)
  diag(`resolveRuntime: nodeExe=${nodeExe} exists=${existsSync(nodeExe)}`)
  if (existsSync(nodeExe)) {
    try {
      const st = statSync(nodeExe)
      diag(`resolveRuntime: nodeExe size=${st.size} isFile=${st.isFile()} mode=0${st.mode.toString(8)}`)
    } catch (e) { diag(`resolveRuntime: stat nodeExe err=${e instanceof Error ? e.message : String(e)}`) }
    try { diag(`resolveRuntime: nodeExe realpath=${realpathSync(nodeExe)}`) }
    catch (e) { diag(`resolveRuntime: realpath nodeExe err=${e instanceof Error ? e.message : String(e)}`) }
  }
  diag(`resolveRuntime: npmCli=${npmCli} exists=${existsSync(npmCli)}`)
  if (existsSync(nodeExe) && existsSync(npmCli) && nodeUsable(nodeExe)) {
    pushLog(`使用内置 Node: ${nodeExe}`)
    runtimeCache = { node: nodeExe, npmCli, useShell: false, label: 'bundled' }
    return runtimeCache
  }
  if (!existsSync(nodeExe)) {
    pushLog(`警告: 内置 Node 不存在: ${nodeExe}，尝试使用系统 Node。若持续失败，请检查安装包是否完整，或手动安装 Node v22。`)
  } else if (!nodeUsable(nodeExe)) {
    pushLog(`警告: 内置 Node 存在但无法执行（可能被安全软件拦截或文件损坏）: ${nodeExe}，尝试使用系统 Node。`)
  } else {
    pushLog(`警告: 内置 npm-cli 不存在: ${npmCli}，尝试使用系统 Node。`)
  }
  diag(`resolveRuntime: 回退到系统 Node`)
  runtimeCache = {
    node: process.platform === 'win32' ? 'node.exe' : 'node',
    npmCli: null,
    useShell: process.platform === 'win32',
    label: 'system'
  }
  return runtimeCache
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
    // 与 listVersions 一致走 curlJson（系统 curl / 系统证书库）：Node fetch/https
    // 在自定义 CA 代理下会 TLS 校验失败（见 net.ts 头部说明），不能用于外部请求。
    const registry = (loadSettings().npmRegistry?.trim() || 'https://registry.npmjs.org').replace(/\/+$/, '')
    const j = (await curlJson(`${registry}/@deepseek-ai/dsh/latest`, {}, 10)) as { version?: string }
    return j.version ?? null
  } catch {
    return null
  }
}

export async function listVersions(): Promise<string[]> {
  try {
    // 用 curl（走系统证书库）绕过自定义 CA 代理的 TLS 校验失败；Accept 简化 metadata 减小体积
    const j = (await curlJson('https://registry.npmjs.org/@deepseek-ai/dsh', {
      Accept: 'application/vnd.npm.install-v1+json'
    }, 60)) as { versions?: Record<string, unknown> }
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
  const args = ['install', '--prefix', dataDir(), '--no-audit', '--no-fund']
  const registry = loadSettings().npmRegistry
  if (registry) args.push('--registry', registry)
  args.push(target)
  return runNpm(args, onLine).then((code) => {
    if (code === 0) invalidateRuntimeCache()
    return code
  })
}

// ---------- WSL 分支（v0.2.0） ----------

/** 内置 bundle 的 dsh 版本（构建期固化；WSL 首次部署/无参更新时与外壳配套） */
export function bundledDshVersion(): string | null {
  try {
    const p = join(bundledDshDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** WSL 内是否已安装 dsh（bin.js 存在性，UNC 只读检查） */
export function wslIsInstalled(): boolean {
  const d = currentDistro()
  const p = wslDshBinLinux()
  return !!(d && p && existsSync(toUnc(d, p)))
}

/** WSL 内 dsh 依赖树是否完整（哨兵包，UNC 只读检查） */
export function wslIsComplete(): boolean {
  if (!wslIsInstalled()) return false
  const d = currentDistro()
  const base = wslBaseLinux()
  if (!d || !base) return false
  for (const pkg of REQUIRED_PKGS) {
    if (!existsSync(toUnc(d, `${base}/node_modules/${pkg}/package.json`))) return false
  }
  return true
}

/** WSL 内已安装的 dsh 版本（UNC 读 package.json） */
export function wslInstalledVersion(): string | null {
  const d = currentDistro()
  const base = wslBaseLinux()
  if (!d || !base) return null
  try {
    const p = toUnc(d, `${base}/node_modules/@deepseek-ai/dsh/package.json`)
    return JSON.parse(readFileSync(p, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * WSL 内安装/升级/回滚 dsh（发行版内 Linux Node 跑 npm-cli）。
 * 注意：必须走发行版内 npm（win32 的内置 bundle/sharp 二进制不通用）。
 * opts 用于部署流程（此时 settings.backend/wslHome 尚未切换），
 * 常规运行（backend 已切到 wsl）可省略。
 */
export function installDshWsl(
  version: string,
  onLine?: (line: string) => void,
  opts: { distro?: string; home?: string } = {}
): Promise<number> {
  const distro = opts.distro ?? currentDistro()
  const base = (opts.home ? `${opts.home}/.dsh-desktop` : null) ?? wslBaseLinux()
  const node = base ? `${base}/node/bin/node` : null
  const npmCli = base ? `${base}/node/lib/node_modules/npm/bin/npm-cli.js` : null
  if (!distro || !node || !npmCli || !base) {
    pushLog('WSL 后端未部署（缺少 node/npm），无法安装 dsh')
    return Promise.resolve(1)
  }
  const target = version === 'latest' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${version}`
  const args = [node, npmCli, 'install', '--prefix', base, '--no-audit', '--no-fund']
  const registry = loadSettings().npmRegistry
  if (registry) args.push('--registry', registry)
  args.push(target)
  pushLog(`$ wsl npm install ${target}`)
  // export PATH：npm 的 postinstall 脚本（koffi/node-pty 等）用 `sh -c node`，
  // 发行版 PATH 必须包含我们的 Linux Node（冒烟实测：缺了会 node: not found）
  const script = `export PATH=${bashQuote(`${base}/node/bin`)}:$PATH; ${args.map(bashQuote).join(' ')}`
  return runWslBash(script, {
    timeoutMs: 10 * 60 * 1000,
    onLine,
    distro,
    // 1.5：超时只杀 wsl.exe 客户端，发行版内 npm 继续跑会占锁；按 node 路径精确清理
    onTimeout: () => {
      pushLog('WSL npm install 超时，尝试终止发行版内的 npm 进程')
      void runWslBash(`pkill -u $(id -un) -f ${bashQuote(node)} 2>/dev/null`, { silent: true, distro })
    }
  }).then(async (r) => {
    if (r.code !== 0) return r.code
    // v0.2.1 兼容性修复：全局安装 + PATH 固化，保证 WSL 终端可直接敲 `dsh`。
    // 应用内部用 --prefix 布局（绝对路径调用），全局布局（<base>/node/bin/dsh）
    // 供用户终端/harness 使用——两者版本一致、互不干扰。best-effort：失败只记
    // 日志，不影响应用内置 dsh 的可用性。
    const gargs = [node, npmCli, 'install', '-g', '--no-audit', '--no-fund']
    if (registry) gargs.push('--registry', registry)
    gargs.push(target)
    // PATH 固化（幂等）：发行版用户 .bashrc/.profile 追加 node/bin。
    // grep 用子串 `dsh-desktop/node/bin` 匹配——兼容既有 `$HOME` 变量形式与
    // 绝对路径形式，避免重复追加；echo 单引号内容保持字面 $PATH，由 bashrc 加载时展开。
    const bashrcLine = `grep -qF 'dsh-desktop/node/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="${base}/node/bin:$PATH"' >> "$HOME/.bashrc"`
    const profileLine = `grep -qF 'dsh-desktop/node/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="${base}/node/bin:$PATH"' >> "$HOME/.profile"`
    const gscript = [
      `export PATH=${bashQuote(`${base}/node/bin`)}:$PATH; ${gargs.map(bashQuote).join(' ')}`,
      bashrcLine,
      profileLine
    ].join('; ')
    const gr = await runWslBash(gscript, { timeoutMs: 10 * 60 * 1000, onLine, distro })
    if (gr.code !== 0) {
      pushLog('WSL 全局 dsh 安装/PATH 固化失败（不影响应用内置 dsh）: ' + (gr.stderr || gr.stdout).trim())
    } else {
      pushLog('WSL 全局 dsh 已就绪，终端可直接使用 `dsh`（PATH 已固化到 .bashrc/.profile）')
    }
    return r.code
  })
}
