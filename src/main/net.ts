// 网络请求：用系统 curl 请求 JSON（走 Windows 系统证书库与系统代理）。
// Node 的 fetch/https 用内置 Mozilla CA，遇到带自定义 CA 的代理会 TLS 校验失败。
import { spawn } from 'node:child_process'

export function curlJson(url: string, headers: Record<string, string> = {}, maxTime = 25): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--max-time', String(maxTime)]
    // 头名/头值净化换行：CRLF 可向 curl 注入额外 HTTP 头（如 token 含换行时）
    const clean = (s: string): string => s.replace(/[\r\n]+/g, ' ')
    for (const [k, v] of Object.entries(headers)) {
      if (v) args.push('-H', `${clean(k)}: ${clean(v)}`)
    }
    args.push(url)
    const child = spawn('curl', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => (out += b.toString()))
    child.stderr.on('data', (b) => (err += b.toString()))
    child.on('error', (e) => reject(e))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `curl exit ${code}`))
        return
      }
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(e as Error)
      }
    })
  })
}
