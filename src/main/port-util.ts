// 端口自愈（v0.3.0，需求 1）：端口被占时先尝试释放（仅限本应用残留 dsh），
// 无法释放则自动切换端口并持久化到设置。
// 纯函数 parseNetstatPids 独立导出，便于 vitest 单测。
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { dataDir, loadSettings, saveSettings } from './settings'
import { pushLog } from './log'
import type { AppSettings } from '../shared/types'

export interface PortResolution {
  port: number
  action: 'clean' | 'released' | 'switched'
  detail: string
}

export interface PortSelfHealOptions {
  /** 是否为 WSL 后端（决定持久化字段与释放方式） */
  isWsl: boolean
  /** 释放本应用残留 dsh 占用的回调（WSL 用 forceCleanupWsl；local 不传走内置 taskkill） */
  releaseOwn?: () => Promise<boolean>
}

/** 纯解析：从 netstat -ano 输出中提取监听 <port> 的 PID 列表（可单测） */
export function parseNetstatPids(output: string, port: number): number[] {
  const pids = new Set<number>()
  const localRe = new RegExp(`^(?:\\[?[0-9a-fA-F:.]+\\]?|[0-9.]+):${port}$`, 'i')
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const tokens = line.split(/\s+/)
    if (tokens.length < 5) continue
    if (!/^tcp/i.test(tokens[0] ?? '')) continue
    if (!localRe.test(tokens[1] ?? '')) continue
    if (!/^LISTENING$/i.test(tokens[3] ?? '')) continue
    const pid = Number(tokens[tokens.length - 1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** 127.0.0.1:<port> 是否空闲（连接成功 = 被占） */
export function checkPortFree(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolve(false)
    })
    sock.on('error', () => resolve(true))
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      resolve(true)
    })
  })
}

/** 找出监听 <port> 的 PID（netstat，Windows） */
export function findListeningPids(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', () => { /* ignore */ })
    child.on('error', () => resolve([]))
    child.on('close', () => resolve(parseNetstatPids(out, port)))
  })
}

/** 取进程命令行（PowerShell CIM；失败回退空串） */
export function processCommandLine(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    ps.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    ps.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    ps.on('error', () => resolve(''))
    ps.on('close', (code) => resolve(code === 0 ? out.trim() : err.trim() || ''))
  })
}

/** 命令行是否属于「本应用残留的 dsh」：含 @deepseek-ai/dsh 且路径落在本应用数据目录 */
export function isOurDshProcess(cmdline: string): boolean {
  if (!cmdline) return false
  const lower = cmdline.toLowerCase()
  if (!lower.includes('@deepseek-ai\\dsh') && !lower.includes('@deepseek-ai/dsh')) return false
  const data = dataDir().toLowerCase()
  return lower.includes(data) || lower.includes('dsh-home')
}

/** 强杀本应用残留 dsh 的 PID（taskkill /T /F），完成后等待端口释放窗口 */
function killLocalPids(pids: number[]): Promise<boolean> {
  return new Promise((resolve) => {
    let remaining = pids.length
    if (remaining === 0) {
      resolve(true)
      return
    }
    for (const pid of pids) {
      const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => {
        if (--remaining === 0) setTimeout(() => resolve(true), 800)
      })
      child.on('close', () => {
        if (--remaining === 0) setTimeout(() => resolve(true), 800)
      })
    }
  })
}

/**
 * 端口自愈主流程：
 * 1. 空闲 → clean；
 * 2. 被本应用残留 dsh 占用 → 释放（WSL 走 releaseOwn；local 走 taskkill）→ released；
 * 3. 被其他程序占用 → 自动切换端口（preferred+1 起逐跳，+25 上限），saveSettings 持久化 → switched；
 * 4. 全部被占 → 抛明确错误。
 */
export async function resolvePortWithSelfHeal(preferred: number, opts: PortSelfHealOptions): Promise<PortResolution> {
  if (await checkPortFree(preferred)) {
    return { port: preferred, action: 'clean', detail: '' }
  }
  const pids = await findListeningPids(preferred)
  const infos = await Promise.all(pids.map(async (pid) => ({ pid, cmd: await processCommandLine(pid) })))
  const ours = infos.filter((i) => isOurDshProcess(i.cmd))
  if (infos.length > 0 && ours.length === infos.length) {
    pushLog(`端口 ${preferred} 被本应用残留 dsh 进程占用（PID ${ours.map((o) => o.pid).join(',')}），正在释放`)
    const ok = opts.isWsl ? (opts.releaseOwn ? await opts.releaseOwn() : false) : await killLocalPids(ours.map((o) => o.pid))
    if (ok || (await checkPortFree(preferred))) {
      if (await checkPortFree(preferred)) {
        const detail = `端口 ${preferred} 原被本应用残留进程占用，已自动释放`
        pushLog(detail)
        return { port: preferred, action: 'released', detail }
      }
    }
  }
  // 无法释放 → 自动切换并持久化（URL 稳定）
  const key = (opts.isWsl ? 'wslPort' : 'port') as keyof AppSettings
  for (let p = preferred + 1; p <= preferred + 25; p++) {
    if (await checkPortFree(p)) {
      saveSettings({ [key]: p } as Partial<AppSettings>)
      const detail = `端口 ${preferred} 被其他程序占用，已自动切换到端口 ${p}（已保存到设置）`
      pushLog(detail)
      return { port: p, action: 'switched', detail }
    }
  }
  throw new Error(`端口 ${preferred} 及后续 25 个端口均被占用，无法自动分配。请关闭占用程序后重试，或手动指定端口。`)
}

/** 把自愈结果写入模块级提示（供 buildStatus 的 portNote 使用），返回有效端口 */
export let currentPortNote: string | null = null
export function applyPortResolution(res: PortResolution, isWsl: boolean): number {
  currentPortNote = res.detail || null
  // 持久化已由 resolvePortWithSelfHeal 完成；这里同步本地缓存（settings 已更新，无需额外写）
  return res.port
}
