// dsh Web UI launch token（v0.3.4）：
// dsh 0.1.2 起 Web 界面启用「链接中一次性 token + 持久签名 cookie」认证
// （release note：网络访问 Web 界面时启用链接中的一次性 token 认证鉴权），
// 裸地址 GET / 一律 401。`dsh web` 启动后会把带 token 的地址打印到输出
// （本机模式经管道捕获 stdout / WSL 模式落入发行版内日志文件）：
//   dsh web: http://127.0.0.1:<port>/?token=<token>   （行尾可能带 (LAN: …) 等后缀）
// 外壳解析该地址随主窗口首次导航携带；dsh 验证通过后铸造签名 cookie（绑定
// Host authority，默认 30 天），之后的裸地址请求凭 cookie 放行。token 每次进程
// 启动都会更换。本模块为纯逻辑，便于单测（test/launch-url.test.ts）。

/** dsh 打印的 Web UI 地址：锚定 http://127.0.0.1 + /?token=（LAN 地址一律不认），
 *  token 字符集取 base64url / hex / 百分号编码的并集，遇空白与括号等边界字符即停
 *  （防吞掉行尾的 (LAN: …) 后缀）。 */
const LAUNCH_URL_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9._~%=-]+/g

/** 从 dsh 输出文本中提取最后一条 launch URL；无则返回 null。
 *  取「最后一条」：WSL 日志跨启动追加，最新启动的 token 排在后面。 */
export function extractLaunchUrl(text: string): string | null {
  let last: string | null = null
  for (const m of text.matchAll(LAUNCH_URL_RE)) last = m[0]
  return last
}

/**
 * 该版本 dsh 的 Web UI 是否启用了 launch token 认证（0.1.2 引入）。
 * 只比较 major.minor.patch（预发布标签如 -rc.1 归属其三元组），解析失败视为不支持。
 */
export function dshHasWebAuth(version: string | null | undefined): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((version ?? '').trim())
  if (!m) return false
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (maj !== 0) return true
  if (min !== 1) return min > 1
  return pat >= 2
}
