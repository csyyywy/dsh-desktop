// 部署冒烟：在 WSL 内启动 dsh → 健康探测 → 进程组停止 → 残留检查
// 模拟应用 server.ts 的启动/停止脚本（含 bashQuote 双引号 + runWslBash $ 转义）
import { spawn } from 'node:child_process'
import http from 'node:http'

const DISTRO = process.argv[2] || 'Ubuntu2404'
const PORT = 3080

function bashQuote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`') + '"'
}

function wsl(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    // 模拟 runWslBash：bash -lc 的脚本做 $ 转义（wsl.exe 外层 sh 会预展开 $）
    const argv = args.map((a) => (args[1] === '-lc' ? a.replace(/\$/g, '\\$') : a))
    const c = spawn('wsl.exe', ['-d', DISTRO, '--', ...argv], { env: { ...process.env, WSL_UTF8: '1' }, windowsHide: true })
    let out = ''
    let err = ''
    const t = setTimeout(() => { try { c.kill() } catch { /* ignore */ } }, timeoutMs)
    c.stdout?.on('data', (b) => (out += b.toString()))
    c.stderr?.on('data', (b) => (err += b.toString()))
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }) })
  })
}

function probe(port, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2500 }, (res) => {
        res.resume()
        resolve(true)
      })
      req.on('timeout', () => req.destroy())
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function main() {
  console.log('=== deployment smoke ===')
  const home = '/home/dsh/.dsh-desktop'
  const node = `${home}/node/bin/node`
  const bin = `${home}/node_modules/@deepseek-ai/dsh/lib/bin.js`
  const dshHome = `${home}/dsh-home`
  const logfile = `${home}/logs/dsh.log`
  const pidfile = `${home}/dsh.pid`
  const pattern = `@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port ${PORT}`

  // 1. 启动（与 server.ts startWslServer 相同的脚本；`&` 后不能接分隔符，故合并 & sleep）
  const script = [
    `mkdir -p ${bashQuote(dshHome)}`,
    `cd ${bashQuote('/home/dsh')}`,
    `DSH_HOME=${bashQuote(dshHome)} setsid nohup ${bashQuote(node)} ${bashQuote(bin)} --profile web --port ${PORT} >> ${bashQuote(logfile)} 2>&1 < /dev/null & sleep 1.5`,
    `PID=$(pgrep -u $(id -un) -f ${bashQuote(pattern)} | grep -vw $$ | head -1)`,
    `PGID=$(ps -o pgid= -p "$PID" | tr -d ' ')`,
    `echo "$PID $PGID" > ${bashQuote(pidfile)}`
  ].join('; ')
  const r = await wsl(['bash', '-lc', script], 30000)
  console.log('  start script exit=' + r.code + (r.err ? ' err=' + r.err : ''))
  const pidInfo = (await wsl(['cat', pidfile])).out.trim()
  console.log('  pidfile=' + pidInfo)

  // 2. 先确认 WSL 内 dsh 进程存活（probe 可能是 Windows 侧服务的假阳性）
  const [pid, pgid] = pidInfo.split(/\s+/).map(Number)
  if (pid) {
    const a = await wsl(['kill', '-0', String(pid)])
    console.log('  wsl dsh alive: ' + (a.code === 0))
  } else {
    console.log('  wsl dsh NOT started (pidfile empty)')
  }

  // 3. 健康探测（若 WSL 进程活着才可信）
  if (pid) {
    const ok = await probe(PORT)
    console.log('  health probe 127.0.0.1:' + PORT + ' -> ' + (ok ? 'OK' : 'FAIL'))
    if (ok) {
      await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => {
          let body = ''
          res.on('data', (b) => (body += b))
          res.on('end', () => {
            console.log('  HTTP status=' + res.statusCode + ' title=' + (/<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? '(no title)').slice(0, 60))
            resolve()
          })
        }).on('error', resolve)
      })
    }
  }

  // 4. 停止（与 stopWslServer 相同：组 kill → 单 pid → 轮询）
  if (pid) {
    const cmds = []
    if (pgid) cmds.push(`kill -- -${pgid} 2>/dev/null`)
    cmds.push(`kill ${pid} 2>/dev/null`)
    await wsl(['bash', '-lc', cmds.join('; ')])
    let alive = true
    for (let i = 0; i < 10; i++) {
      const a = await wsl(['kill', '-0', String(pid)])
      if (a.code !== 0) { alive = false; break }
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('  after kill: alive=' + alive)
    const rest = await wsl(['bash', '-lc', `pgrep -u $(id -un) -f ${bashQuote(pattern)} | grep -vw $$ | wc -l`])
    console.log('  dsh remaining=' + rest.out.trim() + ' (should be 0)')
  }

  console.log('=== smoke done ===')
  process.exit(0)
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e)
  process.exit(1)
})
