// dsh web 进程管理：启动/停止/重启 + 端口健康探测。
// 支持两种后端：
//  - local：直接 spawn 本机 node 子进程（原逻辑）；
//  - wsl：在 WSL 发行版内 setsid nohup 启动，pidfile + 进程组停止 + pkill 兜底。
//    Windows 访问 WSL 内 dsh 的唯一通道是 WSL2 localhost 转发（dsh 仅监听
//    127.0.0.1，--host 0.0.0.0 被官方拒绝），因此绝不 terminate 发行版。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { dshBin, resolveRuntime } from './dsh-manager'
import { dshHome, loadSettings } from './settings'
import { pushLog } from './log'
import {
  bashQuote, checkLocalhostForwarding, checkWinPortFree, currentDistro, hasSetsid,
  pidAlive, readPidfile, runWslBash, validateLinuxPath,
  wslDshBinLinux, wslDshBinWindows, wslDshHomeLinux, wslLogfileLinux, wslNodeBin, wslPidfileLinux
} from './wsl'

let proc: ChildProcess | null = null
let lastExit: { code: number | null; signal: string | null } | null = null

// ---- WSL 后端状态（进程句柄不可用，改用 pidfile + kill -0 实时判定 + 本地缓存） ----
let wslRunning = false
let wslStalePid: number | null = null

export function isRunning(): boolean {
  return proc != null && proc.exitCode == null && proc.signalCode == null
}

/** WSL 后端是否运行（本地缓存，启动/停止时维护） */
export function wslIsRunning(): boolean {
  return wslRunning
}

/** WSL 残留进程 pid（停止失败无法自动清理时非空，交 UI 提示/强制清理） */
export function wslStale(): number | null {
  return wslStalePid
}

export function getLastExit(): { code: number | null; signal: string | null } | null {
  return lastExit
}

export function currentPid(): number | null {
  return proc?.pid ?? null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForPort(port: number, timeoutMs = 120000, alive: () => boolean = isRunning): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (!alive()) {
        reject(new Error('dsh 进程已退出，详见日志'))
        return
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
        res.resume()
        resolve()
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        if (!alive()) {
          reject(new Error('dsh 进程已退出，详见日志'))
          return
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('等待 dsh 服务启动超时'))
          return
        }
        setTimeout(tick, 500)
      })
    }
    tick()
  })
}

// ---------- WSL 后端 ----------

/** WSL 启动前置检查：setsid 可用 / Windows 侧端口空闲 / localhost 转发开启 */
async function preflightWsl(port: number): Promise<string | null> {
  if (!(await hasSetsid())) {
    return '发行版缺少 setsid（util-linux），请先运行: sudo apt install util-linux'
  }
  if (!(await checkWinPortFree(port))) {
    return `Windows 侧 ${port} 端口已被占用，请关闭占用进程或更换端口`
  }
  const lf = checkLocalhostForwarding()
  if (!lf.enabled) {
    return `检测到 .wslconfig 关闭了 localhost 转发（WSL 后端唯一访问通道）。请将 ${lf.configPath} 中的 localhostForwarding 改为 true 或删除该行`
  }
  return null
}

async function startWslServer(): Promise<void> {
  if (wslRunning) return
  const settings = loadSettings()
  const distro = currentDistro()
  if (!distro) throw new Error('未配置 WSL 发行版，请先在仪表盘「运行后端」面板部署')
  const node = wslNodeBin()
  const bin = wslDshBinLinux()
  const home = wslDshHomeLinux()
  const pidfile = wslPidfileLinux()
  const logfile = wslLogfileLinux()
  if (!node || !bin || !home || !pidfile || !logfile) throw new Error('WSL 后端尚未部署，请先一键部署')
  const binWin = wslDshBinWindows()
  if (!binWin || !existsSync(binWin)) throw new Error('WSL 内 dsh 未安装，请先在仪表盘部署')
  const err = await preflightWsl(settings.port)
  if (err) throw new Error(err)
  // 工作区：settings.workspace 为空或非法时回退发行版 HOME
  const ws = settings.workspace && validateLinuxPath(settings.workspace) ? settings.workspace : settings.wslHome
  pushLog(`启动 WSL dsh: ${node} ${bin} --profile web --port ${settings.port}（${distro}）`)
  const script = [
    `mkdir -p ${bashQuote(home)}`,
    `cd ${bashQuote(ws)}`,
    `DSH_HOME=${bashQuote(home)} setsid nohup ${bashQuote(node)} ${bashQuote(bin)} --profile web --port ${settings.port} >> ${bashQuote(logfile)} 2>&1 &`,
    `echo $! > ${bashQuote(pidfile)}`
  ].join(' && ')
  const res = await runWslBash(script, { timeoutMs: 30000 })
  if (res.code !== 0) {
    pushLog('启动 WSL dsh 失败: ' + (res.stderr || res.stdout).trim())
    throw new Error('启动 WSL dsh 失败，详见日志')
  }
  wslRunning = true
  wslStalePid = null
  lastExit = null
  try {
    await waitForPort(settings.port, 120000, () => wslRunning)
  } catch (e) {
    wslRunning = false
    throw e
  }
}

async function stopWslServer(): Promise<void> {
  const pidfile = wslPidfileLinux()
  if (!pidfile) return
  const pid = await readPidfile(pidfile)
  if (pid != null) {
    // setsid 启动后 pid == 进程组 id：先杀整组，再杀单进程兜底
    await runWslBash(`kill -- -${pid} 2>/dev/null; kill ${pid} 2>/dev/null`, { silent: true })
    for (let i = 0; i < 10; i++) {
      if (!(await pidAlive(pid))) break
      await sleep(500)
    }
    if (await pidAlive(pid)) {
      // 残留：按命令行精确匹配（限当前用户），不 terminate 发行版
      const settings = loadSettings()
      const pattern = bashQuote(`@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${settings.port}`)
      await runWslBash(`pkill -u $(id -un) -f ${pattern} 2>/dev/null`, { silent: true })
      await sleep(800)
    }
    wslStalePid = (await pidAlive(pid)) ? pid : null
  } else {
    wslStalePid = null
  }
  wslRunning = false
}

/** 强制清理残留进程（UI「强制清理」按钮） */
export async function forceCleanupWsl(): Promise<boolean> {
  const settings = loadSettings()
  const pattern = bashQuote(`@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${settings.port}`)
  const res = await runWslBash(`pkill -u $(id -un) -f ${pattern} 2>/dev/null`, { silent: true })
  await sleep(500)
  const pidfile = wslPidfileLinux()
  const pid = pidfile ? await readPidfile(pidfile) : null
  wslStalePid = pid != null && (await pidAlive(pid)) ? pid : null
  return res.code === 0
}

// ---------- 统一入口 ----------

export async function startServer(onExit?: (code: number | null) => void): Promise<void> {
  if (loadSettings().backend === 'wsl') {
    await startWslServer()
    return
  }
  if (isRunning()) return
  const settings = loadSettings()
  if (!existsSync(dshBin())) throw new Error('dsh 尚未安装，请先在仪表盘中安装')
  const rt = resolveRuntime()
  const port = settings.port || 3080
  const workspace = settings.workspace || process.env.USERPROFILE || process.cwd()
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome() }
  if (settings.apiKey) env.DEEPSEEK_API_KEY = settings.apiKey

  pushLog(`启动 dsh: ${dshBin()} --profile web --port ${port}`)
  proc = spawn(rt.node, [dshBin(), '--profile', 'web', '--port', String(port)], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  lastExit = null
  proc.stdout?.on('data', (b) => pushLog(b.toString()))
  proc.stderr?.on('data', (b) => pushLog(b.toString()))
  proc.on('exit', (code, signal) => {
    lastExit = { code, signal: signal ?? null }
    pushLog(`dsh 进程退出 (code=${code} signal=${signal})`)
    const p = proc
    proc = null
    if (p) onExit?.(code)
  })
  await waitForPort(port)
}

export async function stopServer(): Promise<void> {
  if (loadSettings().backend === 'wsl') {
    await stopWslServer()
    return
  }
  const p = proc
  proc = null
  if (!p) return
  if (process.platform === 'win32' && p.pid) {
    try {
      spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      p.kill('SIGKILL')
    }
  } else {
    p.kill('SIGTERM')
  }
  await new Promise((r) => setTimeout(r, 700))
}

export async function restartServer(onExit?: (code: number | null) => void): Promise<void> {
  await stopServer()
  await startServer(onExit)
}
