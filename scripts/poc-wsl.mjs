// PoC：WSL 后端三项关键机制验证（v0.2.0 开发前验证，真实发行版）
// ① UNC 可中断流式复制：1GB 双向耗时 + 取消延迟 + .dshpart 清理
// ② setsid 进程组：kill -- -pid 是否杀掉整组（含子进程）
// ③ 状态原语：wsl.exe cat pidfile / kill -0 的实时性与可靠性（对照 UNC 直读）
// 用法：node scripts/poc-wsl.mjs [distro]
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DISTRO = process.argv[2] || 'Ubuntu2404'
const POC = `/home/${DISTRO === 'Ubuntu2404' ? 'dsh' : 'dsh'}/poc`
const UNC = `\\\\wsl.localhost\\${DISTRO}\\home\\dsh\\poc`
const WIN = join(process.env.TEMP || 'C:\\Temp', 'dsh-poc')

function wsl(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const c = spawn('wsl.exe', ['-d', DISTRO, '--', ...args], {
      env: { ...process.env, WSL_UTF8: '1' },
      windowsHide: true
    })
    let out = ''
    let err = ''
    const t = setTimeout(() => { try { c.kill() } catch { /* ignore */ } }, timeoutMs)
    c.stdout?.on('data', (b) => (out += b.toString()))
    c.stderr?.on('data', (b) => (err += b.toString()))
    c.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }) })
  })
}

function fmt(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
  return n + ' B'
}

// ---------- ① 可中断流式复制（模拟 fs-bridge 实现） ----------
async function streamCopy(src, dst, cancelAfterMs) {
  const part = dst + '.dshpart'
  const start = Date.now()
  let cancelled = false
  let written = 0
  let lastError = ''
  return new Promise((resolve) => {
    const rs = createReadStream(src, { highWaterMark: 64 * 1024 })
    const ws = createWriteStream(part)
    const timer = cancelAfterMs ? setTimeout(() => { cancelled = true; rs.destroy() }, cancelAfterMs) : null
    const done = (ok, extra = {}) => {
      if (timer) clearTimeout(timer)
      try { rmSync(part, { force: true }) } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - start, written, cancelled, leftover: existsSync(part), lastError, ...extra })
    }
    rs.on('data', (chunk) => { written += chunk.length; if (!ws.write(chunk)) rs.pause() })
    ws.on('drain', () => rs.resume())
    rs.on('end', () => ws.end())
    ws.on('finish', () => {
      try {
        rmSync(dst, { force: true }) // overwrite 语义（PoC 简化）
        renameSync(part, dst)
        done(true)
      } catch (e) {
        lastError = 'rename: ' + e.message
        done(false)
      }
    })
    rs.on('error', (e) => { lastError = 'rs: ' + e.message; done(false) })
    ws.on('error', (e) => { lastError = 'ws: ' + e.message; done(false) })
  })
}

// ---------- ② 进程组 kill 验证 ----------
async function testProcessGroup() {
  console.log('\n[②] setsid 进程组测试')
  // 启动 setsid 进程（内含两个子进程），pid 写文件
  const r = await wsl(['bash', '-lc', `mkdir -p ${POC} && setsid bash -lc 'sleep 300 & sleep 300 &' & echo $! > ${POC}/pg.pid && sleep 0.5 && cat ${POC}/pg.pid`])
  const pid = Number(r.out.split('\n').pop())
  console.log(`  启动进程组 pid=${pid}（输出: ${r.out.split('\n').join(' / ')}）`)
  if (!pid) { console.log('  失败：未拿到 pid'); return }
  const alive = await wsl(['bash', '-lc', `kill -0 ${pid} && echo ALIVE`])
  console.log(`  杀前: ${alive.out.includes('ALIVE') ? '存活' : '已死'}`)
  // 子进程数量
  const children = await wsl(['bash', '-lc', `pgrep -P ${pid} | wc -l`])
  console.log(`  直接子进程数: ${children.out}`)
  // kill 进程组
  const k = await wsl(['bash', '-lc', `kill -- -${pid} 2>&1; sleep 0.3; if kill -0 ${pid} 2>/dev/null; then echo STILL_ALIVE; else echo GROUP_DEAD; fi`])
  console.log(`  kill -- -${pid} → ${k.out.includes('GROUP_DEAD') ? '整组已死 ✓' : '仍存活 ✗'}`)
  // 残留子进程检查
  const rest = await wsl(['bash', '-lc', `pgrep -f 'sleep 300' | wc -l`])
  console.log(`  sleep 300 残留进程数: ${rest.out}（应为 0）`)
}

// ---------- ③ 状态原语可靠性 ----------
async function testStatusPrimitives() {
  console.log('\n[③] pidfile / kill -0 可靠性（wsl.exe vs UNC 直读）')
  const pid = 999999
  // wsl.exe 读不存在的 pidfile
  let t = Date.now()
  let r = await wsl(['cat', `${POC}/nope.pid`])
  console.log(`  wsl cat 不存在文件: exit=${r.code} 耗时=${Date.now() - t}ms`)
  // 写一个 pidfile
  await wsl(['bash', '-lc', `echo ${pid} > ${POC}/test.pid`])
  t = Date.now()
  r = await wsl(['cat', `${POC}/test.pid`])
  console.log(`  wsl cat 存在文件: 值=${r.out.trim()} 耗时=${Date.now() - t}ms`)
  t = Date.now()
  const unc = readUnc(`${UNC}\\test.pid`)
  console.log(`  UNC 直读: 值=${unc.trim()} 耗时=${Date.now() - t}ms`)
  // kill -0 存活/死亡
  t = Date.now()
  const alivePid = Number((await wsl(['bash', '-lc', 'echo $$'])).out)
  r = await wsl(['kill', '-0', String(alivePid)])
  console.log(`  kill -0 存活(${alivePid}): exit=${r.code} 耗时=${Date.now() - t}ms`)
  t = Date.now()
  r = await wsl(['kill', '-0', '999999'])
  console.log(`  kill -0 死亡: exit=${r.code} 耗时=${Date.now() - t}ms`)
}

function readUnc(p) {
  const fs = require('node:fs')
  return fs.readFileSync(p, 'utf8')
}

// ---------- 主流程 ----------
async function main() {
  console.log(`PoC 发行版: ${DISTRO}  POC=${POC}`)
  console.log(`UNC: ${UNC}`)
  // 准备
  await wsl(['bash', '-lc', `mkdir -p ${POC}`])
  mkdirSync(WIN, { recursive: true })

  console.log('\n[①] UNC 流式复制（1GB）')
  await wsl(['bash', '-lc', `dd if=/dev/zero of=${POC}/big.bin bs=1M count=1024 2>/dev/null && ls -l ${POC}/big.bin`])
  const bigUnc = `${UNC}\\big.bin`
  const bigWin = join(WIN, 'big.bin')

  let t = Date.now()
  let r = await streamCopy(bigUnc, bigWin, 0)
  console.log(`  UNC→本地: ${r.ok ? '完成' : '失败'} ${fmt(r.written)} 耗时=${r.ms}ms 速度=${fmt(Math.round(r.written / (r.ms / 1000)))}/s${r.lastError ? '  err=' + r.lastError : ''}`)

  t = Date.now()
  r = await streamCopy(bigWin, `${UNC}\\back.bin`, 0)
  console.log(`  本地→UNC: ${r.ok ? '完成' : '失败'} ${fmt(r.written)} 耗时=${r.ms}ms 速度=${fmt(Math.round(r.written / (r.ms / 1000)))}/s${r.lastError ? '  err=' + r.lastError : ''}`)
  console.log(`  本地源存在: ${existsSync(bigWin)}`)

  // 取消测试：2 秒后取消
  t = Date.now()
  r = await streamCopy(bigUnc, join(WIN, 'cancel.bin'), 2000)
  const cancelMs = Date.now() - t
  const leftover = existsSync(join(WIN, 'cancel.bin.dshpart')) || existsSync(join(WIN, 'cancel.bin'))
  console.log(`  取消测试: 取消延迟=${r.ms}ms 已复制=${fmt(r.written)} 残留=${leftover ? '有 ✗' : '无 ✓'}`)

  await testProcessGroup()
  await testStatusPrimitives()

  // 清理
  await wsl(['bash', '-lc', `rm -rf ${POC}`])
  rmSync(WIN, { recursive: true, force: true })
  console.log('\nPoC 完成，已清理测试文件')
}

main().catch((e) => {
  console.error('PoC 失败:', e)
  process.exit(1)
})
