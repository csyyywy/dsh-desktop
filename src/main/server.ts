// dsh web 进程管理：启动/停止/重启 + 端口健康探测
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { dshBin, resolveRuntime } from './dsh-manager'
import { dshHome, loadSettings } from './settings'
import { pushLog } from './log'

let proc: ChildProcess | null = null
let lastExit: { code: number | null; signal: string | null } | null = null

export function isRunning(): boolean {
  return proc != null && proc.exitCode == null && proc.signalCode == null
}

export function getLastExit(): { code: number | null; signal: string | null } | null {
  return lastExit
}

export function currentPid(): number | null {
  return proc?.pid ?? null
}

function waitForPort(port: number, timeoutMs = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (!isRunning()) {
        reject(new Error('dsh 进程已退出，详见日志'))
        return
      }
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
        res.resume()
        resolve()
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        if (!isRunning()) {
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

export async function startServer(onExit?: (code: number | null) => void): Promise<void> {
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
