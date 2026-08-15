// WSL 后端基础模块：wsl.exe 执行器、发行版枚举、路径转换（UNC/wslpath）、
// 状态原语（pidfile/kill -0/pgrep）、安全校验与日志。
//
// 关键坑（见 HANDOVER §4.7）：
// - wsl.exe 管道输出默认 UTF-16LE（中文系统乱码）→ spawn 一律带 WSL_UTF8=1，
//   输出仍按 buffer 接收，含 NUL 则按 utf16le 解码（双保险）。
// - 受限令牌（沙箱）下 wsl -l -v 报 E_ACCESSDENIED；应用正常令牌无碍，
//   但枚举调用必须容错并返回结构化错误。
// - 关键状态（pidfile 读取、进程存活）必须走 wsl.exe 实时查询，不用 UNC
//   （9P 在 Windows 侧偶发 EPERM/延迟，状态判定要实时正确）。
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings } from './settings'
import { pushLog } from './log'
import type { WslDistroInfo } from '../shared/types'

/** 可部署的发行版名白名单：官方 Store 发行版均符合；含空格/特殊字符的
 *  （wsl --import 自定义名）只展示不可部署 */
export const VALID_DISTRO_RE = /^[A-Za-z0-9._-]+$/

// ---------- 基本执行 ----------

export interface WslResult {
  code: number
  stdout: string
  stderr: string
}

/** wsl.exe 输出双解码：含 NUL 按 UTF-16LE（兼容未生效的 WSL_UTF8），否则 UTF-8 */
function decode(buf: Buffer): string {
  const s = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
  return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

function wslEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WSL_UTF8: '1' }
}

function spawnWsl(
  argv: string[],
  opts: { timeoutMs?: number; silent?: boolean; onLine?: (line: string) => void }
): Promise<WslResult> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('wsl.exe', argv, { windowsHide: true, env: wslEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: (e as Error).message })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs) : null
    child.stdout?.on('data', (b: Buffer) => {
      out.push(b)
      if (opts.onLine) for (const l of decode(b).split('\n')) { const t = l.trim(); if (t) opts.onLine(t) }
    })
    child.stderr?.on('data', (b: Buffer) => err.push(b))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 1, stdout: decode(Buffer.concat(out)), stderr: e.message })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stdout = decode(Buffer.concat(out))
      const stderr = decode(Buffer.concat(err))
      if (!opts.silent) {
        pushLog(`$ wsl ${argv.join(' ')}`)
        const tail = (stdout + '\n' + stderr).trim().split('\n').slice(-5).join(' | ')
        if (tail) pushLog('  ↳ ' + tail.slice(0, 2000))
      }
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** 全局 wsl.exe 命令（不带 -d <distro> -- 前缀），如 -l -v / --status / --version */
export function runWslGlobal(argv: string[], opts: { timeoutMs?: number; silent?: boolean } = {}): Promise<WslResult> {
  return spawnWsl(argv, opts)
}

/** 当前配置的发行版（backend=wsl 且已配置时非空） */
export function currentDistro(): string | null {
  const s = loadSettings()
  return s.backend === 'wsl' && s.wslDistro ? s.wslDistro : null
}

/** 在指定/当前发行版内执行命令（argv 数组，无 shell 注入面） */
export function runWsl(
  args: string[],
  opts: { timeoutMs?: number; silent?: boolean; onLine?: (line: string) => void; distro?: string } = {}
): Promise<WslResult> {
  const distro = opts.distro ?? currentDistro()
  if (!distro) return Promise.resolve({ code: 1, stdout: '', stderr: '未配置 WSL 发行版' })
  return spawnWsl(['-d', distro, '--', ...args], opts)
}

/** 在发行版内跑一段 bash 脚本（组件必须全部经 bashQuote 拼接） */
export function runWslBash(
  script: string,
  opts: { timeoutMs?: number; silent?: boolean; onLine?: (line: string) => void; distro?: string } = {}
): Promise<WslResult> {
  return runWsl(['bash', '-lc', script], opts)
}

// ---------- 发行版枚举 / 环境信息 ----------

/** wsl -l -v 解析：锚定状态列，容忍发行版名含单个空格 */
export async function listDistros(): Promise<{ distros: WslDistroInfo[]; error: string | null }> {
  const res = await runWslGlobal(['-l', '-v'], { silent: true })
  if (res.code !== 0) {
    // E_ACCESSDENIED / 服务未启动 / 未安装 WSL：把原始错误交给 UI 引导
    const msg = (res.stderr || res.stdout || '').trim()
    return { distros: [], error: msg || `wsl -l -v 退出码 ${res.code}` }
  }
  const distros: WslDistroInfo[] = []
  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  // 跳过标题行（中/英文），数据行形如：* Ubuntu-22.04   Running   2
  const rowRe = /^(\*)?\s*(.+?)\s{2,}(\S+)\s+(\d+)\s*$/
  for (const line of lines) {
    if (/^(名称|NAME)\s/.test(line) || /^\*?\s*(名称|NAME)/.test(line)) continue
    const m = rowRe.exec(line)
    if (!m) continue
    const name = m[2].trim()
    const state = m[3]
    const version = m[4]
    distros.push({ name, state, version, deployable: VALID_DISTRO_RE.test(name) })
  }
  return { distros, error: null }
}

export async function wslVersion(): Promise<string | null> {
  const res = await runWslGlobal(['--version'], { silent: true })
  const m = /WSL (?:版本|version):\s*([0-9.]+)/i.exec(res.stdout) || /WSL\s+([0-9]+\.[0-9.]+)/.exec(res.stdout)
  return m ? m[1] : null
}

export async function kernelVersion(): Promise<string | null> {
  const res = await runWslGlobal(['--version'], { silent: true })
  const m = /(?:内核|Kernel) (?:版本|version):\s*([0-9.]+(?:-\d+)?)/i.exec(res.stdout)
  return m ? m[1] : null
}

/** 发行版就绪探测：首次配置未完成（未创建用户）时命令会失败/超时 */
export async function pingDistro(distro: string, timeoutMs = 60000): Promise<{ ok: boolean; message: string }> {
  const res = await spawnWsl(['-d', distro, '--', 'sh', '-lc', 'echo wsl-ok'], { timeoutMs, silent: true })
  if (res.code === 0 && /wsl-ok/.test(res.stdout)) return { ok: true, message: '' }
  const msg = (res.stderr || res.stdout || '').trim()
  return {
    ok: false,
    message: msg || '发行版未就绪（可能尚未完成首次配置：请先在终端运行 wsl -d ' + distro + ' 创建用户）'
  }
}

/** 发行版内是否可用 setsid（util-linux，主流发行版默认有） */
export async function hasSetsid(distro?: string): Promise<boolean> {
  const res = await runWsl(['sh', '-lc', 'command -v setsid'], { silent: true, distro })
  return res.code === 0 && /setsid/.test(res.stdout)
}

/** 发行版默认用户的 HOME */
export async function wslHomeOf(distro: string): Promise<string | null> {
  const res = await runWsl(['sh', '-lc', 'echo $HOME'], { silent: true, distro })
  const home = res.stdout.trim()
  return res.code === 0 && home.startsWith('/') ? home : null
}

// ---------- 路径映射 ----------

/** Linux 绝对路径 → Windows UNC（\\wsl.localhost\<distro>\...；兼容旧 \\wsl$\） */
export function toUnc(distro: string, linuxPath: string): string {
  const p = linuxPath.startsWith('/') ? linuxPath.slice(1) : linuxPath
  return `\\\\wsl.localhost\\${distro}\\${p.replace(/\//g, '\\')}`
}

/** UNC → Linux 绝对路径（仅支持本机 wsl 前缀，非法输入返回 null） */
export function fromUnc(winPath: string): string | null {
  const m = /^\\\\wsl\.(?:localhost|\$)\\[^\\]+\\?(.*)$/i.exec(winPath)
  if (!m) return null
  return '/' + m[1].replace(/\\/g, '/')
}

/** 经 wslpath 转换：linuxPath → Windows 盘符（wslpath -w），winPath → Linux（wslpath -u） */
export async function wslpath(linuxPath: string): Promise<string | null>
export async function wslpath(linuxPath: string, toWindows: boolean): Promise<string | null>
export async function wslpath(path: string, toWindows = true): Promise<string | null> {
  const res = await runWsl(['wslpath', toWindows ? '-w' : '-u', path], { silent: true })
  const out = res.stdout.trim()
  return res.code === 0 && out.length > 0 ? out : null
}

// ---------- 状态原语（实时性优先，全部走 wsl.exe） ----------

/** 读 pidfile（发行版内 cat） */
export async function readPidfile(linuxPath: string, distro?: string): Promise<number | null> {
  const res = await runWsl(['cat', linuxPath], { silent: true, distro })
  const pid = Number(res.stdout.trim())
  return res.code === 0 && Number.isInteger(pid) && pid > 1 ? pid : null
}

/** 进程存活检测（kill -0，外部 /bin/kill） */
export async function pidAlive(pid: number, distro?: string): Promise<boolean> {
  const res = await runWsl(['kill', '-0', String(pid)], { silent: true, distro })
  return res.code === 0
}

/** 按命令行模式找 dsh 进程（限当前用户；pattern 必须经 bashQuote） */
export async function pgrepDsh(pattern: string, distro?: string): Promise<number[]> {
  const res = await runWslBash(`pgrep -u $(id -un) -f ${pattern}`, { silent: true, distro })
  if (res.code !== 0) return []
  return res.stdout.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 1)
}

// ---------- 端口 / 转发检查 ----------

/** Windows 侧 127.0.0.1:<port> 是否已被占用（WSL 启动前检查，避免 localhost 转发冲突） */
export function checkWinPortFree(port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolve(false) // 连接成功 = 端口被占
    })
    sock.on('error', () => resolve(true))
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      resolve(true)
    })
  })
}

/** 检查 %USERPROFILE%\.wslconfig 是否显式关闭 localhost 转发（默认开启） */
export function checkLocalhostForwarding(): { enabled: boolean; configPath: string | null } {
  const p = join(process.env.USERPROFILE ?? '', '.wslconfig')
  if (!existsSync(p)) return { enabled: true, configPath: null }
  try {
    const text = readFileSync(p, 'utf8')
    return { enabled: !/localhostForwarding\s*=\s*false/i.test(text), configPath: p }
  } catch {
    return { enabled: true, configPath: p }
  }
}

/** 在发行版内打开终端窗口（引导首次配置 / 用户跳转） */
export function openWslTerminal(distro: string, linuxPath?: string): void {
  const argv = linuxPath ? ['-d', distro, '--cd', linuxPath] : ['-d', distro]
  try {
    const child = spawn('wsl.exe', argv, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    pushLog(`$ wsl ${argv.join(' ')}（新窗口）`)
  } catch (e) {
    pushLog('打开 WSL 终端失败: ' + (e as Error).message)
  }
}

// ---------- WSL 后端数据布局（发行版内 <wslHome>/.dsh-desktop，与 Windows dataDir 语义镜像） ----------

/** 发行版内 HOME（settings.wslHome，backendSetup 时解析写入） */
export function wslHomeDir(): string | null {
  const h = loadSettings().wslHome
  return h && h.startsWith('/') ? h : null
}

/** 发行版内数据根：<home>/.dsh-desktop */
export function wslBaseLinux(): string | null {
  const h = wslHomeDir()
  return h ? `${h}/.dsh-desktop` : null
}

/** Windows 侧 UNC 形态的数据根 */
export function wslBaseWindows(): string | null {
  const d = currentDistro()
  const b = wslBaseLinux()
  return d && b ? toUnc(d, b) : null
}

/** 发行版内 Linux Node 可执行文件 */
export function wslNodeBin(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/node/bin/node` : null
}

/** 发行版内 npm-cli.js（Linux Node 自带 npm） */
export function wslNpmCli(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/node/lib/node_modules/npm/bin/npm-cli.js` : null
}

/** 发行版内 pnpm.cjs（从 resources/pnpm 复制，纯 JS） */
export function wslPnpmCjs(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/pnpm/bin/pnpm.cjs` : null
}

/** 发行版内 dsh 入口（npm --prefix 安装布局，与 Windows 侧 dataDir/node_modules 一致） */
export function wslDshBinLinux(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/node_modules/@deepseek-ai/dsh/lib/bin.js` : null
}

/** Windows 侧 UNC 形态的 dsh 入口 */
export function wslDshBinWindows(): string | null {
  const d = currentDistro()
  const p = wslDshBinLinux()
  return d && p ? toUnc(d, p) : null
}

/** 发行版内 $DSH_HOME */
export function wslDshHomeLinux(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/dsh-home` : null
}

/** Windows 侧 UNC 形态的 $DSH_HOME */
export function wslDshHomeWindows(): string | null {
  const d = currentDistro()
  const p = wslDshHomeLinux()
  return d && p ? toUnc(d, p) : null
}

/** 发行版内 dsh 进程 pidfile */
export function wslPidfileLinux(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/dsh.pid` : null
}

/** 发行版内 dsh 日志 */
export function wslLogfileLinux(): string | null {
  const b = wslBaseLinux()
  return b ? `${b}/logs/dsh.log` : null
}

// ---------- 安全校验 ----------

/** Linux 路径校验：绝对路径、禁 .. / NUL / shell 元字符 / 通配符 */
export function validateLinuxPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false
  if (!p.startsWith('/') || p.includes('\0')) return false
  if (/[\x00'"$`;&|<>*?[\]]/.test(p)) return false
  for (const seg of p.split('/')) {
    if (seg === '..' || seg === '') continue
    if (seg === '.') return false
  }
  return true
}

/** Windows 路径校验：绝对路径（盘符或 UNC）、禁 NUL */
export function validateWinPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false
  if (p.includes('\0')) return false
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\\\\/.test(p)) return false
  for (const seg of p.split(/[\\/]/)) {
    if (seg === '..') return false
  }
  return true
}

/** IPC 参数统一校验：必须是字符串、非空、禁 NUL、长度上限 */
export function validateIpcArg(v: unknown, maxLen = 4096): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && !v.includes('\0')
}

/** bash 单引号安全引用：' → '\'' */
export function bashQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
