// 验证 bashQuote 双引号方案在 wsl.exe 外层包装下的行为（模拟 runWslBash 的 $ 转义）
import { spawn } from 'node:child_process'

function bashQuote(s) {
  return (
    '"' +
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`') +
    '"'
  )
}

const script = [
  `x=${bashQuote('hello world')}`,
  'echo V=$x',
  `p=${bashQuote('@deepseek-ai/dsh/lib/bin\\.js.*--profile web.*--port 3080')}`,
  'echo P=$p',
  `pgrep -u $(id -un) -f ${bashQuote('sleep 300')} | head -1`,
  'echo END_OK'
].join('; ')

// runWslBash 的 $ 全局转义（外层 sh 会预展开一次，转义后由内层 bash 展开）
const escaped = script.replace(/\$/g, '\\$')
console.log('SCRIPT:', escaped)

const c = spawn('wsl.exe', ['-d', 'Ubuntu2404', '--', 'bash', '-lc', escaped], {
  env: { ...process.env, WSL_UTF8: '1' },
  windowsHide: true
})
let out = ''
let err = ''
c.stdout?.on('data', (b) => (out += b.toString()))
c.stderr?.on('data', (b) => (err += b.toString()))
c.on('close', (code) => {
  console.log('OUT:', out.trim())
  console.log('ERR:', err.trim())
  console.log('exit', code)
})
