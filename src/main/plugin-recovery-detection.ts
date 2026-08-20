// 启动失败恢复的**纯检测**模块（v0.3.0，移植 dataelement/dsh-desktop v0.4.0 #94/#96/#98 思路，MIT）。
// 本文件刻意零依赖（不 import electron / fs / child_process），便于 vitest 直接单测。
// 输入 = 最近一次 dsh 启动的 stderr 行数组（由 server.ts 的 lastStartupStderr 提供，已按行拆分）。
// 只做文本提取与过滤，不触碰文件系统；「loader 条目 id → 真实包」的映射见 plugin-recovery.ts。

/** dsh 核心 bundle：用户安装的第三方插件与之无关，永不列为可卸载目标 */
const CORE_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'])

/** 合法 npm 包名形态（@scope/name 或 name） */
const PACKAGE_REFERENCE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/** 是否为合法包名引用（内部标识如 cordis:include 含冒号 → 不是） */
export function isPackageReference(value: string): boolean {
  const candidate = (value ?? '').trim()
  if (!candidate || candidate.includes(':')) return false
  return PACKAGE_REFERENCE_PATTERN.test(candidate)
}

/** 是否为「可操作」的插件引用：合法包名 + 非核心 bundle + 非 @deepseek-ai/* */
export function isActionablePluginReference(value: string): boolean {
  const candidate = (value ?? '').trim()
  return (
    isPackageReference(candidate) &&
    !CORE_BUNDLES.has(candidate) &&
    !candidate.startsWith('@deepseek-ai/')
  )
}

/** 从 stderr 提取失败原因：优先 DSH entry failed / uncaught exception / unhandled rejection，回退错误行 */
export function extractFailureCause(lines: readonly string[]): string | undefined {
  const stderrLines: string[] = []
  let dshEntryError: string | undefined
  let uncaughtError: string | undefined
  for (const raw of lines) {
    const text = cleanLine(raw).trim()
    stderrLines.push(text)
    if (dshEntryError === undefined) {
      const m = text.match(/DSH entry failed:\s*(.+)/)
      if (m?.[1]) dshEntryError = m[1].trim()
    }
    if (uncaughtError === undefined) {
      const m1 = text.match(/uncaught exception:\s*(.+)/)
      if (m1?.[1]) {
        uncaughtError = m1[1].trim()
      } else {
        const m2 = text.match(/unhandled rejection:\s*(.+)/)
        if (m2?.[1]) uncaughtError = m2[1].trim()
      }
    }
  }
  if (dshEntryError) return dshEntryError
  if (uncaughtError) return uncaughtError
  for (let i = stderrLines.length - 1; i >= 0; i--) {
    const line = stderrLines[i]?.trim()
    if (!line) continue
    if (line.length < 200 && /\b(error|Error|ERROR|failed|Failed|FAILED)\b/.test(line)) return line
  }
  if (stderrLines.length > 0) return stderrLines[stderrLines.length - 1]?.trim()
  return undefined
}

/** 容错：strip 掉 `[stderr] ` 之类日志前缀，统一处理裸 stderr 与带前缀的日志 */
function cleanLine(line: string): string {
  return line.replace(/^\[stderr\]\s*/i, '')
}

function extractPluginReferences(
  lines: readonly string[],
  accepts: (value: string) => boolean
): string[] {
  const plugins = new Set<string>()
  // 「Failed to load plugins」全屏错误卡：标题之后的行（直到空行/日志前缀）是候选包名。
  // stderr 按行接收（server.ts 逐行 push），标题与包名分散在不同数组元素，需跨行跟踪。
  let inBootError = false
  const consider = (v: string): void => {
    const c = v.trim()
    if (accepts(c)) plugins.add(c)
  }
  for (const raw of lines) {
    // 单 chunk 可能内嵌整个错误卡（含换行），先拆行
    for (const lineRaw of raw.split(/\r?\n/)) {
      const line = cleanLine(lineRaw).trim()
      if (line === 'Failed to load plugins') {
        inBootError = true
        continue
      }
      if (inBootError) {
        if (!line || line.startsWith('[')) {
          inBootError = false
          continue
        }
        consider(line)
        continue
      }

      const m1 = line.match(/failed to apply loader entry [^\s]+ \((@[^)]+|[^)]+)\)/i)
      if (m1?.[1] && accepts(m1[1])) plugins.add(m1[1].trim())

      const m2 = line.match(/cannot resolve profile bundle ["']([^"']+)["']/i)
      if (m2?.[1] && accepts(m2[1])) plugins.add(m2[1].trim())

      const m3 = line.match(/profile bundle ["']([^"']+)["'] declares no dsh\.bundle/i)
      if (m3?.[1] && accepts(m3[1])) plugins.add(m3[1].trim())

      const m4 = line.match(/failed to import loader entry [^\s]+ \((@[^)]+|[^)]+)\)/i)
      if (m4?.[1] && accepts(m4[1])) plugins.add(m4[1].trim())

      const m5 = line.match(/plugin\(s\) failed to load:\s*([a-zA-Z0-9@/_-]+)/i)
      if (m5?.[1] && accepts(m5[1])) plugins.add(m5[1].trim())
    }
  }
  return [...plugins]
}

/** 提取日志中出现的插件包引用（含核心 bundle，用于完整诊断） */
export function extractPluginFailureReferences(lines: readonly string[]): string[] {
  return extractPluginReferences(lines, isPackageReference)
}

/** 提取「可操作」的问题插件（可安全卸载的第三方插件） */
export function extractOffendingPlugins(lines: readonly string[]): string[] {
  return extractPluginReferences(lines, isActionablePluginReference)
}

export function extractOffendingPlugin(lines: readonly string[]): string | undefined {
  return extractOffendingPlugins(lines)[0]
}

/** 重复 loader 条目 id（如 storage / cordis:include / 自定义 id）。内部标识含冒号，不能直接卸载。 */
export function extractDuplicateLoaderEntryId(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    const m = raw.match(/duplicate loader entry id:\s*["']?([^\s"']+)["']?/i)
    if (m?.[1]) return m[1].trim()
  }
  return undefined
}

/** 插槽冲突名：single slot / UI slot 重复注册 / duplicate prefix route（route 也算插槽冲突） */
export function extractSlotConflictName(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    const m1 = raw.match(/single slot\s+["']([^"']+)["']\s+already has a registration/i)
    if (m1?.[1]) return m1[1].trim()
    const m2 = raw.match(/UI slot\s+["']([^"']+)["']\s+has duplicate registrations/i)
    if (m2?.[1]) return m2[1].trim()
    const m3 = raw.match(/duplicate prefix route\s+["']?([^\s"']+)["']?/i)
    if (m3?.[1]) return m3[1].trim()
  }
  return undefined
}

/** 退出码展示（0xFFFF7003 = Crashpad 不可用，常见于被安全软件拦截） */
export function formatExitCode(code: number): string {
  const unsigned = code >>> 0
  const hexadecimal = `0x${unsigned.toString(16).padStart(8, '0').toUpperCase()}`
  if (unsigned === 0xffff7003) {
    return `exit code ${unsigned} (${hexadecimal}, Crashpad handler unavailable)`
  }
  return `exit code ${code} (${hexadecimal})`
}
