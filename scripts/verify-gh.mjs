// 验证：WSL 网关 IP（Windows 宿主）+ hosts 写入链路 + 443 连通现状
import { spawn } from 'node:child_process'

const DISTRO = 'Ubuntu2404'

function wsl(args) {
  return new Promise((resolve) => {
    const c = spawn('wsl.exe', ['-d', DISTRO, '--', ...args], { env: { ...process.env, WSL_UTF8: '1' }, windowsHide: true })
    let out = ''
    let err = ''
    c.stdout?.on('data', (b) => (out += b.toString()))
    c.stderr?.on('data', (b) => (err += b.toString()))
    c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
}

async function main() {
  // 1. 网关 IP（Windows 宿主）——tr+cut 提取（awk 单引号会被 wsl.exe 外层剥掉）
  const gw = await wsl(['bash', '-lc', `ip route show default | tr -s ' ' | cut -d' ' -f3 | head -1`])
  console.log('gateway:', JSON.stringify(gw.out))

  // 2. 当前从 WSL 访问宿主 443 的状态
  if (gw.out) {
    const r = await wsl(['bash', '-lc', `curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://${gw.out}:443`])
    console.log('host:443 via gateway:', JSON.stringify(r.out), 'exit', r.code)
  }

  // 3. hosts 写入（模拟应用逻辑）后再次探测
  if (gw.out) {
    const hostsLine = `${gw.out} github.com www.github.com api.github.com codeload.github.com raw.githubusercontent.com objects.githubusercontent.com gist.github.com`
    const w = await wsl(['bash', '-lc', `grep -q "github.com" /etc/hosts || echo "${hostsLine}" | sudo tee -a /etc/hosts > /dev/null`])
    console.log('hosts write exit:', w.code, w.err)
    const r2 = await wsl(['bash', '-lc', `curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://github.com`])
    console.log('github after hosts:', JSON.stringify(r2.out), 'exit', r2.code)
    // 显示 hosts 内容确认
    const h = await wsl(['bash', '-lc', `grep github /etc/hosts`])
    console.log('hosts entries:', h.out)
  }
  process.exit(0)
}

main()
