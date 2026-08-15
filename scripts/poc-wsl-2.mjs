// PoC 第二部分：取消 + 进程组 + 状态原语（真实发行版验证）
// 用法：node scripts/poc-wsl-2.mjs [distro]
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DISTRO = process.argv[2] || 'Ubuntu2404'
const POC = '/home/dsh/poc'
const UNC = `\\\\wsl.localhost\\${DISTRO}\\home\\dsh\\poc`
const WIN = join(process.env.TEMP || 'C:\\Temp', 'dsh-poc')

function wsl(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    // 模拟应用 runWslBash：$ 全局转义（wsl.exe 外层 sh 会预展开 $，转义后由内层 bash 展开）
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

async function main() {
  console.log('START', new Date().toISOString())
  await wsl(['bash', '-lc', `mkdir -p ${POC}`])
  mkdirSync(WIN, { recursive: true })
  // 重新生成 1GB 测试文件（PoC-1 结束已清理）
  await wsl(['bash', '-lc', `dd if=/dev/zero of=${POC}/big.bin bs=1M count=1024 2>/dev/null`])
  console.log('big.bin regenerated')

  // ---------- ① 取消测试（模拟 fs-bridge：flag + data 轮询，不依赖 destroy 触发 error） ----------
  console.log('[1] cancel test (fs-bridge style)')
  const src = `${UNC}\\big.bin`
  const dst = join(WIN, 'cancel.bin')
  const part = dst + '.dshpart'
  const t0 = Date.now()
  const cancelProbe = await new Promise((resolve) => {
    const rs = createReadStream(src, { highWaterMark: 64 * 1024 })
    const ws = createWriteStream(part)
    let n = 0
    let done = false
    let cancelled = false
    const watchdog = setTimeout(() => {
      console.log('  watchdog fired, n=' + n + ' part=' + existsSync(part))
      resolve('watchdog')
    }, 15000)
    const timer = setTimeout(() => { cancelled = true }, 2000) // 只置 flag，与 fs-bridge 一致
    const cleanup = () => {
      try { rs.destroy() } catch { /* ignore */ }
      try { ws.destroy() } catch { /* ignore */ }
      try { rmSync(part, { force: true }) } catch { /* ignore */ }
    }
    const finish = (ok, errMsg) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      if (ok) { try { rmSync(part, { force: true }) } catch { /* ignore */ } }
      console.log('  result: ok=' + ok + ' copiedMB=' + Math.round(n / 1048576) + ' cancelMs=' + (Date.now() - t0) + (errMsg ? ' err=' + errMsg : ''))
      console.log('  leftover: part=' + existsSync(part) + ' dst=' + existsSync(dst))
      resolve('finished')
    }
    rs.on('data', (c) => {
      if (cancelled) { cleanup(); finish(false, 'cancelled'); return }
      n += c.length
      if (!ws.write(c)) rs.pause()
    })
    ws.on('drain', () => rs.resume())
    rs.on('end', () => ws.end())
    ws.on('finish', () => finish(true, ''))
    rs.on('error', (e) => finish(false, 'rs:' + e.message))
    ws.on('error', (e) => finish(false, 'ws:' + e.message))
  })
  console.log('  cancel probe: ' + cancelProbe)

  // ---------- ② setsid 进程组（pgrep+ps 拿 pgid，模拟应用新方案） ----------
  console.log('[2] process group')
  const r = await wsl(['bash', '-lc', `mkdir -p ${POC}; setsid bash -lc "sleep 300 & sleep 300 &" > /dev/null 2>&1 & sleep 1.5; PID=$(pgrep -f "^sleep 300$" | grep -vw $$ | head -1); PGID=$(ps -o pgid= -p "$PID" | tr -d ' '); echo "$PID $PGID" > ${POC}/pg.pid; cat ${POC}/pg.pid`])
  const [mPid, mPgid] = r.out.trim().split(/\s+/).map(Number)
  console.log('  dsh-pid=' + mPid + ' pgid=' + mPgid)
  if (!mPid) {
    console.log('  FAIL no pid, raw=' + JSON.stringify(r.out) + ' err=' + JSON.stringify(r.err))
  } else {
    const before = await wsl(['bash', '-lc', `kill -0 ${mPid} && echo ALIVE`])
    console.log('  before: ' + (before.out.includes('ALIVE') ? 'alive' : 'dead'))
    const k = await wsl(['bash', '-lc', `kill -- -${mPgid} 2>&1; sleep 0.3; kill -0 ${mPid} 2>/dev/null && echo STILL_ALIVE || echo GROUP_DEAD`])
    console.log('  kill -- -' + mPgid + ' -> ' + (k.out.includes('GROUP_DEAD') ? 'GROUP_DEAD ok' : 'STILL_ALIVE fail') + (k.err ? ' err=' + k.err : ''))
    const rest = await wsl(['bash', '-lc', `pgrep -f "^sleep 300$" | wc -l`])
    console.log('  sleep300 remaining=' + rest.out.trim())
  }

  // ---------- ③ 状态原语 ----------
  console.log('[3] primitives')
  const sl = await wsl(['bash', '-lc', `sleep 30 & echo $!`])
  const sleepPid = Number(sl.out.trim())
  console.log('  sleep pid=' + sleepPid)
  let t = Date.now()
  const a = await wsl(['kill', '-0', String(sleepPid)])
  console.log('  kill -0 alive(' + sleepPid + ') exit=' + a.code + ' ms=' + (Date.now() - t))
  t = Date.now()
  const d = await wsl(['kill', '-0', '999999'])
  console.log('  kill -0 dead exit=' + d.code + ' ms=' + (Date.now() - t))
  t = Date.now()
  const p = await wsl(['cat', `${POC}/pg.pid`])
  console.log('  wsl cat pidfile=' + (p.out.trim() || '(empty)') + ' ms=' + (Date.now() - t))
  t = Date.now()
  try {
    const unc = readFileSync(`${UNC}\\pg.pid`, 'utf8').trim()
    console.log('  UNC read pidfile=' + unc + ' ms=' + (Date.now() - t))
  } catch (e) {
    console.log('  UNC read FAIL: ' + e.message)
  }

  await wsl(['bash', '-lc', `rm -rf ${POC}`])
  rmSync(WIN, { recursive: true, force: true })
  console.log('DONE', new Date().toISOString())
  process.exit(0)
}

main().catch((e) => {
  console.error('ERR', e)
  process.exit(1)
})
