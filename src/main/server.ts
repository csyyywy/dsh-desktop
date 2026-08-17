// dsh web 进程管理：启动/停止/重启 + 端口健康探测。
// 支持两种后端：
//  - local：直接 spawn 本机 node 子进程（原逻辑）；
//  - wsl：在 WSL 发行版内 setsid nohup 启动，pidfile + 进程组停止 + pkill 兜底。
//    Windows 访问 WSL 内 dsh 的唯一通道是 WSL2 localhost 转发（dsh 仅监听
//    127.0.0.1，--host 0.0.0.0 被官方拒绝），因此绝不 terminate 发行版。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import http from 'node:http'
import { dshBin, diag, resolveRuntime } from './dsh-manager'
import { dshHome, loadSettings, windowsApiKey } from './settings'
import { pushLog } from './log'
import {
  bashQuote, checkLocalhostForwarding, checkWinPortFree, currentDistro, hasSetsid,
  pidAlive, readPidfile, runWslBash,
  wslDshBinLinux, wslDshBinWindows, wslDshHomeLinux, wslLogfileLinux, wslNodeBin, wslPidfileLinux, wslWorkspaceLinux
} from './wsl'

let proc: ChildProcess | null = null
let lastExit: { code: number | null; signal: string | null } | null = null

/**
 * 解析 dsh 工作目录（spawn 的 cwd）。
 * 关键修复：若配置的工作目录不存在/不可进入，spawn 会以「spawn <node.exe> ENOENT」
 * 的形式失败（Node 会把无效 cwd 的报错挂到可执行文件路径上），极具迷惑性。
 * 故在此做存在性 + 目录校验，失败时回退到 USERPROFILE / 应用目录并告警。
 */
function resolveWorkspace(preferred: string | undefined): string {
  const candidates = [preferred, process.env.USERPROFILE, process.cwd()].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) {
        if (preferred && c !== preferred) {
          pushLog(`警告: 工作目录 "${preferred}" 不存在或不可访问，已回退到 ${c}`)
        }
        return c
      }
    } catch {
      /* 继续尝试下一个候选 */
    }
  }
  const fallback = process.cwd()
  diag(`resolveWorkspace: 全部候选无效，回退到 ${fallback}`)
  pushLog(`警告: 工作目录 "${preferred}" 无效，已回退到 ${fallback}`)
  return fallback
}

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

// WSL 后端存活检查：不仅看 wslRunning 缓存，还要实时确认 dsh 进程存活
// （pidAlive），进程崩溃时立即失败，避免探测傻等 120s（用户实测卡启动问题）
let wslPidCache: number | null = null

async function wslAliveCheck(): Promise<boolean> {
  if (!wslRunning) return false
  if (wslPidCache == null) return true
  return pidAlive(wslPidCache)
}

function waitForPort(port: number, timeoutMs = 120000, alive: () => boolean | Promise<boolean> = isRunning, verifyDsh = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      void (async () => {
        if (!(await alive())) {
          reject(new Error('dsh 进程已退出，详见日志'))
          return
        }
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
          if (!verifyDsh) {
            res.resume()
            resolve()
            return
          }
          // WSL 模式：必须确认响应是 dsh 页面（防 Windows 侧同端口服务误判为已启动）
          let body = ''
          res.on('data', (b: Buffer) => {
            body += b.toString()
            if (body.length > 65536) req.destroy()
          })
          res.on('end', () => {
            if (/(DeepSeek|Harness|dsh)/i.test(body.slice(0, 65536))) resolve()
            else setTimeout(tick, 500)
          })
        })
        req.on('timeout', () => req.destroy())
        req.on('error', () => {
          void (async () => {
            if (!(await alive())) {
              reject(new Error('dsh 进程已退出，详见日志'))
              return
            }
            if (Date.now() - start > timeoutMs) {
              reject(new Error('等待 dsh 服务启动超时'))
              return
            }
            setTimeout(tick, 500)
          })()
        })
      })()
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
  // WSL 独立端口（settings.wslPort，默认 3081）——与 Windows 侧 port 隔离，
  // 避免与本机 dsh/旧版应用冲突导致状态误判与 localhost 转发混淆
  const port = settings.wslPort || 3081
  const err = await preflightWsl(port)
  if (err) throw new Error(err)
  // 工作区：与会话 cwd 适配共用同一解析（settings.workspace 或 wslHome）
  const ws = wslWorkspaceLinux()
  if (!ws) throw new Error('WSL 工作区未配置')
  pushLog(`启动 WSL dsh: ${node} ${bin} --profile web --port ${port}（${distro}）`)
  // 关键坑（PoC 实测）：wsl 的 bash 是进程组长 → setsid 必然 fork → `$!` 是已退出的
  // 父进程 pid，不能当进程组 id。因此启动后由 pgrep 定位实际 dsh 进程、ps 读取其
  // pgid，pidfile 存 `<pid> <pgid>` 两列，停止时优先按进程组杀。
  const pattern = `@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${port}`
  // 关键坑（实测）：dsh 0.1.0-rc.6 在 WSL 内读 .credentials.yaml 会**卡死启动**
  // （空文件也卡）。对策：启动前把该文件移走（.synced 后缀保留），
  // API Key 从 Windows 侧解析后经环境变量注入。
  const key = windowsApiKey()
  const envPrefix = key ? `DEEPSEEK_API_KEY=${bashQuote(key)} ` : ''
  // 注意：`&` 本身是命令分隔符，其后不能跟 `;`/`&&`（bash 语法错误），
  // 因此 `&` 与 `sleep 1.5` 合并为同一元素；其余用 `; ` 连接
  const script = [
    `mkdir -p ${bashQuote(home)}`,
    `cd ${bashQuote(ws)}`,
    `[ -f ${bashQuote(`${home}/.credentials.yaml`)} ] && mv ${bashQuote(`${home}/.credentials.yaml`)} ${bashQuote(`${home}/.credentials.yaml.synced`)}`,
    `${envPrefix}DSH_HOME=${bashQuote(home)} setsid nohup ${bashQuote(node)} ${bashQuote(bin)} --profile web --port ${port} >> ${bashQuote(logfile)} 2>&1 < /dev/null & sleep 1.5`,
    // grep -vw $$：pgrep -f 会匹配运行本脚本的 bash 自身（命令行含 pattern 文本），必须排除
    `PID=$(pgrep -u $(id -un) -f ${bashQuote(pattern)} | grep -vw $$ | head -1)`,
    `PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')`,
    `echo "$PID $PGID" > ${bashQuote(pidfile)}`
  ].join('; ')
  const res = await runWslBash(script, { timeoutMs: 30000 })
  if (res.code !== 0) {
    pushLog('启动 WSL dsh 失败: ' + (res.stderr || res.stdout).trim())
    throw new Error('启动 WSL dsh 失败，详见日志')
  }
  wslRunning = true
  wslStalePid = null
  lastExit = null
  try {
    // 启动后从 pidfile 取 pid，供存活检查（进程崩溃立即失败，不等 120s 超时）
    const info = await readPidfile(pidfile)
    wslPidCache = info.pid
    await waitForPort(port, 120000, wslAliveCheck, true)
  } catch (e) {
    wslRunning = false
    wslPidCache = null
    throw e
  }
}

async function stopWslServer(): Promise<void> {
  const pidfile = wslPidfileLinux()
  if (!pidfile) return
  const info = await readPidfile(pidfile)
  if (info.pid != null) {
    // 优先按进程组杀（setsid 新会话组），再杀单进程兜底
    const cmds: string[] = []
    if (info.pgid != null) cmds.push(`kill -- -${info.pgid} 2>/dev/null`)
    cmds.push(`kill ${info.pid} 2>/dev/null`)
    await runWslBash(cmds.join('; '), { silent: true })
    for (let i = 0; i < 10; i++) {
      if (!(await pidAlive(info.pid))) break
      await sleep(500)
    }
    if (await pidAlive(info.pid)) {
      // 残留：按命令行精确匹配（限当前用户），不 terminate 发行版
      const settings = loadSettings()
      const pattern = bashQuote(`@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${settings.wslPort || 3081}`)
      await runWslBash(`pkill -u $(id -un) -f ${pattern} 2>/dev/null`, { silent: true })
      await sleep(800)
    }
    wslStalePid = (await pidAlive(info.pid)) ? info.pid : null
  } else {
    wslStalePid = null
  }
  wslRunning = false
  wslPidCache = null
}

/** 强制清理残留进程（UI「强制清理」按钮） */
export async function forceCleanupWsl(): Promise<boolean> {
  const settings = loadSettings()
  const pattern = bashQuote(`@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${settings.wslPort || 3081}`)
  const res = await runWslBash(`pkill -u $(id -un) -f ${pattern} 2>/dev/null`, { silent: true })
  await sleep(500)
  const pidfile = wslPidfileLinux()
  const info = pidfile ? await readPidfile(pidfile) : { pid: null, pgid: null }
  wslStalePid = info.pid != null && (await pidAlive(info.pid)) ? info.pid : null
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
  const workspace = resolveWorkspace(settings.workspace || process.env.USERPROFILE || process.cwd())
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome() }
  if (settings.apiKey) env.DEEPSEEK_API_KEY = settings.apiKey

  pushLog(`启动 dsh: ${dshBin()} --profile web --port ${port}`)
  diag(`startServer: spawning node=${rt.node} label=${rt.label} dshBin=${dshBin()} cwd=${workspace} backend=${loadSettings().backend}`)
  proc = spawn(rt.node, [dshBin(), '--profile', 'web', '--port', String(port)], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.on('error', (e) => {
    const err = e as NodeJS.ErrnoException
    diag(`SPAWN ERROR: node=${rt.node} cwd=${workspace} code=${err.code} errno=${err.errno} syscall=${err.syscall} path=${err.path} message=${err.message}`)
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
