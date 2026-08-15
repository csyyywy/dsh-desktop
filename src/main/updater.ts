// 应用外壳自更新：GitHub Releases 版本检查 + curl 下载 setup.exe + NSIS 静默安装。
// 硬约束：本机自定义 CA 代理下 Node fetch/https 会 TLS 校验失败，
// 所有外部 HTTP 请求一律走系统 curl（见 net.ts），下载二进制同样用 curl。
// dsh 本体更新在 dsh-manager + 仪表盘「更新」面板完成，与这里无关。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadSettings, dataDir } from './settings'
import { curlJson } from './net'
import type { AppUpdateInfo, AppUpdateProgress, AppUpdateResult } from '../shared/types'

interface GhAsset {
  name: string
  size: number
  browser_download_url: string
}

interface GhRelease {
  tag_name?: string
  html_url?: string
  assets?: GhAsset[]
}

/** 下载目录在数据目录下（`<dataDir>/updates`），升级安装器不触碰数据目录 */
export function updateDir(): string {
  const dir = join(dataDir(), 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

let downloading = false

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'dsh-desktop',
    Accept: 'application/vnd.github+json'
  }
  const token = loadSettings().githubToken.trim()
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const repo = loadSettings().appUpdateRepo.trim()
  const current = app.getVersion()
  const base: AppUpdateInfo = {
    enabled: !!repo,
    current,
    latest: null,
    hasUpdate: false,
    url: null,
    assetUrl: null,
    assetSize: null
  }
  if (!repo) return base
  try {
    const j = (await curlJson(`https://api.github.com/repos/${repo}/releases/latest`, githubHeaders())) as GhRelease
    const latest = (j.tag_name ?? '').replace(/^v/i, '') || null
    const asset = (j.assets ?? []).find((a) => /-setup\.exe$/i.test(a.name)) ?? null
    return {
      enabled: true,
      current,
      latest,
      hasUpdate: latest != null && latest !== current,
      url: j.html_url ?? null,
      assetUrl: asset?.browser_download_url ?? null,
      assetSize: asset?.size ?? null
    }
  } catch {
    // 网络/限流等一律视为"无更新信息"，不打断主流程
    return base
  }
}

/** 从安装包文件名里解析版本号，用于排序找最新 */
function versionOf(name: string): number[] {
  const m = name.match(/-(\d+(?:\.\d+)*)/)
  return m ? m[1].split('.').map((n) => parseInt(n, 10) || 0) : [0]
}

function cmpVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 下载最新版 setup.exe 到数据目录。
 * onProgress 回调下载/校验进度；成功时 path 为本地安装包完整路径。
 */
export function downloadAppUpdate(
  onProgress?: (p: AppUpdateProgress) => void
): Promise<AppUpdateResult & { path?: string }> {
  return new Promise((resolve) => {
    void (async () => {
      if (downloading) {
        resolve({ ok: false, message: '已在下载中，请稍候' })
        return
      }
      downloading = true
      try {
        const info = await checkAppUpdate()
        if (!info.enabled || !info.assetUrl || !info.latest) {
          downloading = false
          resolve({ ok: false, message: '未配置更新仓库或该版本没有附带安装包' })
          return
        }
        if (!info.hasUpdate) {
          downloading = false
          resolve({ ok: false, message: '外壳已是最新版本' })
          return
        }
        const dir = updateDir()
        const target = join(dir, `dsh-desktop-${info.latest}-setup.exe`)
        const part = target + '.part'
        const total = info.assetSize ?? 0
        // 已下载过同版本且大小吻合 → 直接复用，跳过网络
        if (existsSync(target) && (total <= 0 || statSync(target).size === total)) {
          onProgress?.({ phase: 'done', percent: 100, receivedBytes: statSync(target).size, totalBytes: total, message: '安装包已存在' })
          downloading = false
          resolve({ ok: true, message: `已下载 v${info.latest} 安装包`, path: target })
          return
        }
        // 清理上一次残留的下载
        for (const f of readdirSync(dir)) {
          if (/\.exe(\.part)?$/i.test(f)) rmSync(join(dir, f), { force: true })
        }
        onProgress?.({
          phase: 'downloading',
          percent: 0,
          receivedBytes: 0,
          totalBytes: total,
          message: `正在下载 v${info.latest} …`
        })
        const child = spawn('curl', ['-sS', '-L', '--fail', '--retry', '3', '-o', part, info.assetUrl], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe']
        })
        let stderr = ''
        child.stderr.on('data', (b) => (stderr += b.toString()))
        const timer = setInterval(() => {
          try {
            const size = statSync(part).size
            onProgress?.({
              phase: 'downloading',
              percent: total > 0 ? Math.min(99, Math.round((size / total) * 100)) : 0,
              receivedBytes: size,
              totalBytes: total,
              message: `正在下载 v${info.latest} …`
            })
          } catch {
            /* 分片文件尚未出现 */
          }
        }, 300)
        child.on('error', (e) => {
          clearInterval(timer)
          downloading = false
          resolve({ ok: false, message: `无法启动下载：${e.message}` })
        })
        child.on('close', (code) => {
          clearInterval(timer)
          if (code !== 0) {
            downloading = false
            resolve({ ok: false, message: `下载失败 (curl exit ${code})：${stderr.trim() || '网络错误'}` })
            return
          }
          try {
            const size = statSync(part).size
            onProgress?.({
              phase: 'verifying',
              percent: 100,
              receivedBytes: size,
              totalBytes: total,
              message: '正在校验文件…'
            })
            if (total > 0 && size !== total) {
              downloading = false
              resolve({ ok: false, message: `文件校验失败：期望 ${total} 字节，实际 ${size} 字节` })
              return
            }
            if (size < 1024 * 1024) {
              downloading = false
              resolve({ ok: false, message: '下载的文件异常过小，已中止' })
              return
            }
            renameSync(part, target)
            onProgress?.({ phase: 'done', percent: 100, receivedBytes: size, totalBytes: total, message: '下载完成' })
            downloading = false
            resolve({ ok: true, message: `已下载 v${info.latest} 安装包`, path: target })
          } catch (e) {
            downloading = false
            resolve({ ok: false, message: `文件处理失败：${(e as Error).message}` })
          }
        })
      } catch (e) {
        downloading = false
        resolve({ ok: false, message: (e as Error).message })
      }
    })()
  })
}

/** 返回已下载的安装包路径（按版本号取最新），没有则返回 null */
export function downloadedUpdatePath(): string | null {
  try {
    const names = readdirSync(updateDir()).filter((f) => /-setup\.exe$/i.test(f))
    if (names.length === 0) return null
    names.sort((a, b) => cmpVersion(versionOf(a), versionOf(b)))
    return join(updateDir(), names[names.length - 1])
  } catch {
    return null
  }
}
