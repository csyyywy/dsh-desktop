// 会话 cwd 迁移：把从 Windows 侧同步来的会话（header.cwd 为 Windows 路径）
// 改写为 WSL 工作区路径，并把会话目录迁移到匹配的 projectKey 目录。
// 背景（v0.2.0 缺陷）：syncFromWindows 只是 cpSync 原样复制，会话 JSONL 头部
// 的 cwd 字段仍是 `D:\ai\测试` 这类 Windows 路径；dsh 的 workspace 挂载
// （attachSession）要求 realpathNormalize(header.cwd) 解析为真实目录且等于
// 工作区路径，Windows 路径在 WSL 内无法 resolve → 会话被标 invalid → UI 列表
// 不显示。本模块在同步后对 WSL 侧副本做路径适配（Windows 侧原始数据不动）。
//
// v0.2.2 修复（两处）：
// 1) 帧保留式重写：.jsonl.zstd 是「首帧 = header 行 + 每批事件一帧」的
//    拼接帧容器；zstdDecompressSync 只解出第一帧，旧实现把整个文件重压成
//    单帧 header 文件，事件内容全部丢失。现按 dsh-session-persistence-jsonl
//    的 scanZstdFrames 算法解析首帧字节边界，只替换首帧、尾部事件帧原样保留。
// 2) workspace 记录改写：storages/workspace.json 中 path 仍为旧 Windows 路径
//    的记录改写为新工作区，否则会话被 accounted 却匹配不上 record.path，
//    GUI 列表直接隐藏（连 Ungrouped 都不显示）。
import {
  constants,
  zstdCompressSync,
  zstdDecompressSync,
  type ZstdOptions,
} from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { toUnc } from './wsl'
import { pushLog } from './log'

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

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528

/** 解析 zstd 首帧字节边界（对齐 dsh-session-persistence-jsonl scanZstdFrames） */
function firstFrameEnd(buf: Buffer): number {
  let offset = 0
  if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic')
  offset += 4
  const descriptor = buf.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buf.length - offset < remainingHeaderBytes) throw new Error('torn frame header')
  offset += remainingHeaderBytes
  for (;;) {
    if (buf.length - offset < 3) throw new Error('torn block header')
    const blockHeader = buf.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error('reserved block type')
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buf.length - offset < payloadBytes) throw new Error('torn block payload')
    offset += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (buf.length - offset < 4) throw new Error('torn checksum')
    offset += 4
  }
  return offset
}

/** 改写 workspace.json 中 path === oldCwd 的记录为 newCwd（best-effort，幂等） */
function remapWorkspaceRecords(sessionsRoot: string, oldCwd: string, newCwd: string): void {
  const wsPath = join(sessionsRoot, '..', 'storages', 'workspace.json')
  if (!existsSync(wsPath)) return
  try {
    const j = JSON.parse(readFileSync(wsPath, 'utf8')) as {
      tables?: { workspaces?: Record<string, { path?: string }> }
    }
    const ws = j.tables?.workspaces
    if (!ws) return
    let changed = 0
    for (const record of Object.values(ws)) {
      if (record.path === oldCwd) {
        record.path = newCwd
        changed++
      }
    }
    if (changed === 0) return
    const bak = `${wsPath}.bak`
    if (!existsSync(bak)) writeFileSync(bak, readFileSync(wsPath))
    writeFileSync(wsPath, JSON.stringify(j, null, 2) + '\n')
    pushLog(`[migrate] workspace.json: remapped ${changed} record(s) ${oldCwd} -> ${newCwd}`)
  } catch (e) {
    pushLog(`[migrate] workspace.json remap failed (best-effort): ${(e as Error).message}`)
  }
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
 * 单个会话失败不阻断（记入 failed）。首次改写前写 .bak 备份（全量原始字节）。
 */
export async function migrateSessionCwds(sessionsRoot: string, workspace: string): Promise<SessionCwdMigrateStats> {
  const stats: SessionCwdMigrateStats = { rewritten: 0, moved: 0, skipped: 0, failed: [] }
  if (!existsSync(sessionsRoot)) return stats
  const targetKey = projectKey(workspace)
  // 迁移目标工作区目录需真实存在（attachSession 会 realpath 校验）；不存在则补建。
  // 1.13 修复：sessionsRoot 是 UNC（\\wsl.localhost\<distro>\...），workspace 是
  // Linux 路径——直接 mkdirSync(workspace) 会在 Windows 侧当前盘根建出 C:\home\... 垃圾。
  // 必须转成 UNC（toUnc）在发行版内补建。
  const distroMatch = /^\\\\wsl\.(?:localhost|\$)\\([^\\]+)/i.exec(sessionsRoot)
  const workspaceUnc = distroMatch ? toUnc(distroMatch[1], workspace) : null
  try {
    if (workspaceUnc) mkdirSync(workspaceUnc, { recursive: true })
  } catch (e) {
    pushLog(`[migrate] cannot ensure workspace dir ${workspaceUnc}: ${(e as Error).message}`)
  }
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
        // zstd：只解首帧（header），尾部事件帧字节原样保留
        let tail: Buffer
        let headerText: string
        if (useZstd) {
          const firstEnd = firstFrameEnd(raw)
          headerText = zstdDecompressSync(raw.subarray(0, firstEnd)).toString('utf8')
          tail = raw.subarray(firstEnd)
        } else {
          headerText = raw.toString('utf8')
          tail = Buffer.alloc(0)
        }
        const nl = headerText.indexOf('\n')
        if (nl < 0) { stats.skipped++; continue }
        let header: { type?: string; cwd?: string } | null = null
        try { header = JSON.parse(headerText.slice(0, nl)) } catch { /* fallthrough */ }
        if (!header || header.type !== 'session' || typeof header.cwd !== 'string') { stats.skipped++; continue }
        if (!isWinAbs(header.cwd)) { stats.skipped++; continue }
        const oldCwd = header.cwd
        // 备份原始文件（仅首次，全量字节）
        const bak = useZstd ? `${zstdPath}.bak` : `${plainPath}.bak`
        if (!existsSync(bak)) writeFileSync(bak, raw)
        // 改写 header cwd：新 header 帧 + 原事件帧尾部
        header.cwd = workspace
        const newHeaderLine = JSON.stringify(header) + '\n'
        const newRaw = useZstd
          ? Buffer.concat([
              zstdCompressSync(Buffer.from(newHeaderLine, 'utf8'), {
                params: { [constants.ZSTD_c_checksumFlag]: 1 },
              } satisfies ZstdOptions),
              tail,
            ])
          : Buffer.concat([Buffer.from(newHeaderLine, 'utf8'), raw.subarray(nl + 1)])
        if (useZstd) writeFileSync(zstdPath, newRaw)
        else writeFileSync(plainPath, newRaw)
        stats.rewritten++
        pushLog(`[migrate] rewrote ${sess.name} cwd ${oldCwd} -> ${workspace} (${raw.length} -> ${newRaw.length} bytes)`)
        remapWorkspaceRecords(sessionsRoot, oldCwd, workspace)
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
