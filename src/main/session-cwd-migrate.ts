// 会话 cwd 迁移：把从 Windows 侧同步来的会话（header.cwd 为 Windows 路径）
// 改写为 WSL 工作区路径，并把会话目录迁移到匹配的 projectKey 目录。
// 背景（v0.2.0 缺陷）：syncFromWindows 只是 cpSync 原样复制，会话 JSONL 头部
// 的 cwd 字段仍是 `D:\ai\测试` 这类 Windows 路径；dsh 的 workspace 挂载
// （attachSession）要求 realpathNormalize(header.cwd) 解析为真实目录且等于
// 工作区路径，Windows 路径在 WSL 内无法 resolve → 会话被标 invalid → UI 列表
// 不显示。本模块在同步后对 WSL 侧副本做路径适配（Windows 侧原始数据不动）。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** 与 dsh-session-persistence-jsonl 一致的 projectKey 编码（目录名 = `--<key>--`） */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Windows 绝对路径（盘符）判定 */
function isWinAbs(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p)
}

export interface SessionCwdMigrateStats {
  rewritten: number
  moved: number
  skipped: number
  failed: string[]
}

/**
 * 把 <sessionsRoot>（UNC，如 \\wsl.localhost\<distro>\...\dsh-home\sessions）
 * 下所有 header.cwd 为 Windows 路径的会话改写为 workspace，并把会话目录迁到
 * projectKey(workspace) 目录。幂等：cwd 已是 Linux 路径的会话跳过；
 * 单个会话失败不阻断（记入 failed）。首次改写前写 .bak 备份。
 */
export async function migrateSessionCwds(sessionsRoot: string, workspace: string): Promise<SessionCwdMigrateStats> {
  const stats: SessionCwdMigrateStats = { rewritten: 0, moved: 0, skipped: 0, failed: [] }
  if (!existsSync(sessionsRoot)) return stats
  const targetKey = projectKey(workspace)
  for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue
    const projDir = join(sessionsRoot, proj.name)
    for (const sess of readdirSync(projDir, { withFileTypes: true })) {
      if (!sess.isDirectory()) continue
      const sessDir = join(projDir, sess.name)
      try {
        const zstdPath = join(sessDir, 'session.jsonl.zstd')
        const plainPath = join(sessDir, 'session.jsonl')
        const useZstd = existsSync(zstdPath)
        const usePlain = !useZstd && existsSync(plainPath)
        if (!useZstd && !usePlain) { stats.skipped++; continue }
        const raw = readFileSync(useZstd ? zstdPath : plainPath)
        const text = (useZstd ? zstdDecompressSync(raw) : raw).toString('utf8')
        const nl = text.indexOf('\n')
        if (nl < 0) { stats.skipped++; continue }
        let header: { type?: string; cwd?: string } | null = null
        try { header = JSON.parse(text.slice(0, nl)) } catch { /* fallthrough */ }
        if (!header || header.type !== 'session' || typeof header.cwd !== 'string') { stats.skipped++; continue }
        if (!isWinAbs(header.cwd)) { stats.skipped++; continue }
        // 备份原始文件（仅首次）
        const bak = useZstd ? `${zstdPath}.bak` : `${plainPath}.bak`
        if (!existsSync(bak)) writeFileSync(bak, raw)
        // 改写 header cwd → 重压写回
        header.cwd = workspace
        const newText = JSON.stringify(header) + text.slice(nl)
        const newRaw = useZstd
          ? zstdCompressSync(Buffer.from(newText, 'utf8'))
          : Buffer.from(newText, 'utf8')
        if (useZstd) writeFileSync(zstdPath, newRaw)
        else writeFileSync(plainPath, newRaw)
        stats.rewritten++
        // 迁移会话目录到匹配新 cwd 的 project 目录。目标已存在旧副本时覆盖：
        // 同一 session id 出现在多个 project 目录会触发 dsh duplicate id 报错，
        // 而本次复制来的 Windows 副本更新（Windows 侧是权威源）。
        if (proj.name !== targetKey) {
          const dst = join(sessionsRoot, targetKey, sess.name)
          mkdirSync(join(sessionsRoot, targetKey), { recursive: true })
          if (existsSync(dst)) rmSync(dst, { recursive: true })
          renameSync(sessDir, dst)
          stats.moved++
        }
      } catch (e) {
        stats.failed.push(`${proj.name}/${sess.name}: ${(e as Error).message}`)
      }
    }
    // 清掉已搬空的旧 project 目录
    try {
      if (readdirSync(projDir).length === 0) rmSync(projDir, { recursive: true })
    } catch { /* ignore */ }
  }
  return stats
}

/** 同步后的会话目录：存在且为目录（供调用方判定是否值得迁移） */
export function sessionsDirUsable(sessionsRoot: string): boolean {
  try { return existsSync(sessionsRoot) && statSync(sessionsRoot).isDirectory() } catch { return false }
}
