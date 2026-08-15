// 文件桥（v0.2.0）：Windows ↔ WSL 双向文件浏览/复制/移动/重命名/删除/路径转换。
//
// 设计要点：
//  - wsl 侧路径在 IPC 中始终是 Linux 形态（/home/user/...），Windows 侧操作经
//    UNC 映射（\\wsl.localhost\<distro>\...）；UNC 只由 toUnc 构造，绝不信任渲染层拼接。
//  - 复制 = 可中断流式（64KB 块 + 背压），目标先写 <name>.dshpart，成功后 rename 落名；
//    取消/失败立即 destroy 流并删除 .dshpart（不残留半成品）。
//  - 同侧移动优先 fs.rename（原子）；EXDEV（跨挂载点）自动回退复制+删源。
//  - 传输并发上限 2，其余排队（进度事件含 queued 状态）。
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { shell } from 'electron'
import { currentDistro, fromUnc, openWslTerminal, toUnc, validateLinuxPath, validateWinPath, wslpath } from './wsl'
import { pushLog } from './log'
import type { FsEntry, FsSide, FsTransferProgress, FsTransferRequest, FsTranslateResult, PluginOpResult } from '../shared/types'

type Emit = (p: FsTransferProgress) => void

/** 侧路径 → Windows 可访问路径（win 原样；wsl 经 UNC），非法返回 null */
function winOf(side: FsSide, path: string): string | null {
  if (side === 'win') return validateWinPath(path) ? path : null
  const d = currentDistro()
  return d && validateLinuxPath(path) ? toUnc(d, path) : null
}

function linuxJoin(base: string, name: string): string {
  return base.endsWith('/') ? base + name : base + '/' + name
}

// ---------- 浏览 ----------

export function listEntries(side: FsSide, path: string): FsEntry[] {
  const win = winOf(side, path)
  if (!win) throw new Error('非法路径')
  const entries = readdirSync(win, { withFileTypes: true }).map((e) => {
    const full = join(win, e.name)
    let isDir = e.isDirectory()
    let size = 0
    let mtime = 0
    try {
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        isDir = false // 链接按文件展示，避免误入
      } else {
        isDir = st.isDirectory()
        size = isDir ? 0 : st.size
        mtime = Math.floor(st.mtimeMs)
      }
    } catch {
      /* 损坏链接/权限拒绝：按最小信息展示 */
    }
    return {
      name: e.name,
      path: side === 'wsl' ? linuxJoin(path, e.name) : full,
      isDir,
      size,
      mtime
    }
  })
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

// ---------- 传输（并发 2 + 可中断流式） ----------

const MAX_CONCURRENT = 2
const queue: { job: FsTransferRequest; emit: Emit }[] = []
const running = new Map<string, { job: FsTransferRequest; emit: Emit }>()
const cancelled = new Set<string>()

export function cancelTransfer(id: string): void {
  cancelled.add(id)
  jobStarts.delete(id)
  const r = running.get(id)
  if (r) pushLog(`文件桥：取消传输 ${id}`)
}

function progressOf(job: FsTransferRequest, emit: Emit, patch: Partial<FsTransferProgress>): void {
  emit({
    id: job.id,
    name: basename(job.srcPath),
    srcPath: job.srcPath,
    dstPath: job.dstPath,
    srcSide: job.srcSide,
    dstSide: job.dstSide,
    phase: 'copying',
    done: 0,
    total: 0,
    bytesPerSec: 0,
    ...patch
  })
}

export function enqueueTransfer(jobs: FsTransferRequest[], emit: Emit): void {
  for (const j of jobs) {
    cancelled.delete(j.id)
    queue.push({ job: j, emit })
    progressOf(j, emit, { phase: 'queued' })
  }
  pump()
}

function pump(): void {
  while (running.size < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()
    if (!item) break
    if (cancelled.has(item.job.id)) {
      progressOf(item.job, item.emit, { phase: 'cancelled', message: '已取消' })
      continue
    }
    running.set(item.job.id, item)
    void runJob(item).finally(() => {
      running.delete(item.job.id)
      pump()
    })
  }
}

async function runJob(item: { job: FsTransferRequest; emit: Emit }): Promise<void> {
  const { job, emit } = item
  const srcWin = winOf(job.srcSide, job.srcPath)
  const dstWin = winOf(job.dstSide, job.dstPath)
  if (!srcWin || !dstWin) {
    progressOf(job, emit, { phase: 'error', message: '非法路径' })
    return
  }
  const name = basename(job.srcPath)
  const dstFile = join(dstWin, name)
  let total = 0
  try {
    total = statSync(srcWin).size
  } catch (e) {
    progressOf(job, emit, { phase: 'error', message: '无法读取源文件: ' + (e as Error).message })
    return
  }
  const start = Date.now()
  try {
    // 同侧：原子 rename；跨侧（或 EXDEV 回退）走流式复制 + 删源
    if (job.srcSide === job.dstSide) {
      try {
        renameSync(srcWin, dstFile)
        progressOf(job, emit, { phase: 'done', done: total, total })
        pushLog(`文件桥：移动 ${job.srcSide} ${job.srcPath} → ${job.dstPath}`)
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      }
    }
    await copyStream(job, srcWin, dstFile, total, emit)
    if (job.move) rmSync(srcWin, { force: true })
    const elapsed = (Date.now() - start) / 1000
    progressOf(job, emit, { phase: 'done', done: total, total, bytesPerSec: elapsed > 0 ? Math.round(total / elapsed) : 0 })
    pushLog(`文件桥：${job.move ? '移动' : '复制'}完成 ${job.srcSide} ${job.srcPath} → ${job.dstPath}`)
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'cancelled' || cancelled.has(job.id)) {
      progressOf(job, emit, { phase: 'cancelled', message: '已取消，残留已清理' })
    } else {
      progressOf(job, emit, { phase: 'error', message: msg })
    }
  }
}

/** 可中断流式复制：.dshpart → 成功 rename 落名；取消/失败 destroy + 清理 */
function copyStream(job: FsTransferRequest, src: string, dst: string, total: number, emit: Emit): Promise<void> {
  return new Promise((resolve, reject) => {
    if (existsSync(dst)) {
      if (!job.overwrite) {
        reject(new Error('目标已存在同名文件（可勾选覆盖）'))
        return
      }
      try { rmSync(dst, { force: true }) } catch { /* ignore */ }
    }
    const part = dst + '.dshpart'
    try { rmSync(part, { force: true }) } catch { /* ignore */ }
    const rs = createReadStream(src, { highWaterMark: 64 * 1024 })
    const ws = createWriteStream(part)
    let written = 0
    let lastEmit = 0
    let destroyed = false
    const cleanup = (): void => {
      if (destroyed) return
      destroyed = true
      try { rs.destroy() } catch { /* ignore */ }
      try { ws.destroy() } catch { /* ignore */ }
      try { rmSync(part, { force: true }) } catch { /* ignore */ }
    }
    rs.on('data', (chunk: Buffer) => {
      if (cancelled.has(job.id)) {
        cleanup()
        reject(new Error('cancelled'))
        return
      }
      written += chunk.length
      const now = Date.now()
      if (now - lastEmit > 1000) {
        lastEmit = now
        const elapsed = Math.max(1, (now - (startTimeOf(job) ?? now)) / 1000)
        progressOf(job, emit, { phase: 'copying', done: written, total, bytesPerSec: Math.round(written / elapsed) })
      }
      if (!ws.write(chunk)) rs.pause()
    })
    ws.on('drain', () => rs.resume())
    rs.on('end', () => ws.end())
    ws.on('finish', () => {
      try {
        renameSync(part, dst)
        resolve()
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
    ws.on('error', (e) => {
      cleanup()
      reject(cancelled.has(job.id) ? new Error('cancelled') : e)
    })
    rs.on('error', (e) => {
      cleanup()
      reject(cancelled.has(job.id) ? new Error('cancelled') : e)
    })
  })
}

const jobStarts = new Map<string, number>()

function startTimeOf(job: FsTransferRequest): number | undefined {
  if (!jobStarts.has(job.id)) jobStarts.set(job.id, Date.now())
  return jobStarts.get(job.id)
}

// ---------- 文件操作 ----------

export function removeEntry(side: FsSide, path: string): PluginOpResult {
  const win = winOf(side, path)
  if (!win) return { ok: false, message: '非法路径' }
  try {
    rmSync(win, { recursive: true, force: true })
    pushLog(`文件桥：删除 ${side} ${path}`)
    return { ok: true, message: '已删除' }
  } catch (e) {
    return { ok: false, message: '删除失败: ' + (e as Error).message }
  }
}

export function renameEntry(side: FsSide, path: string, newName: string): PluginOpResult {
  const win = winOf(side, path)
  if (!win) return { ok: false, message: '非法路径' }
  if (typeof newName !== 'string' || newName.length === 0 || newName.length > 255) return { ok: false, message: '非法文件名' }
  if (/[\\/\0]/.test(newName) || newName === '.' || newName === '..') return { ok: false, message: '非法文件名' }
  try {
    renameSync(win, join(dirname(win), newName))
    return { ok: true, message: '已重命名' }
  } catch (e) {
    return { ok: false, message: '重命名失败: ' + (e as Error).message }
  }
}

export function mkdirEntry(side: FsSide, path: string): PluginOpResult {
  const win = winOf(side, path)
  if (!win) return { ok: false, message: '非法路径' }
  try {
    mkdirSync(win, { recursive: true })
    return { ok: true, message: '已创建' }
  } catch (e) {
    return { ok: false, message: '创建失败: ' + (e as Error).message }
  }
}

// ---------- 路径转换 ----------

export async function translatePath(input: string): Promise<FsTranslateResult> {
  if (/^\\\\wsl\.(?:localhost|\$)\\/i.test(input)) {
    const linux = fromUnc(input)
    if (!linux) throw new Error('无法识别的 WSL UNC 路径')
    const local = await wslpath(linux).catch(() => null)
    return { windows: input, windowsLocal: local, linux, kind: 'wsl-unc' }
  }
  if (/^[A-Za-z]:[\\/]/.test(input)) {
    const linux = await wslpath(input, false)
    if (!linux) throw new Error('wslpath 转换失败（发行版未就绪或路径不可达）')
    return { windows: input, windowsLocal: input, linux, kind: 'win' }
  }
  if (input.startsWith('/')) {
    const d = currentDistro()
    if (!d) throw new Error('未配置 WSL 发行版')
    const windows = toUnc(d, input)
    const local = await wslpath(input).catch(() => null)
    return { windows, windowsLocal: local, linux: input, kind: 'linux' }
  }
  throw new Error('无法识别的路径（支持: C:\\... / \\\\wsl.localhost\\... / /home/...）')
}

// ---------- 打开 ----------

export async function openEntry(side: FsSide, path: string, terminal = false): Promise<PluginOpResult> {
  if (side === 'win') {
    if (terminal) return { ok: false, message: '本机侧不支持「终端打开」' }
    const err = await shell.openPath(path)
    return err ? { ok: false, message: err } : { ok: true, message: '' }
  }
  const d = currentDistro()
  const win = winOf('wsl', path)
  if (!d || !win) return { ok: false, message: '非法路径或未配置发行版' }
  if (terminal) {
    openWslTerminal(d, path)
    return { ok: true, message: '' }
  }
  const err = await shell.openPath(win)
  return err ? { ok: false, message: err } : { ok: true, message: '' }
}
