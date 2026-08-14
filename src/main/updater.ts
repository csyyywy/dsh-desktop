// 应用外壳自更新：手动查询 GitHub Releases 最新版（无 electron-updater 依赖）。
// dsh 本体更新在 dsh-manager + 仪表盘「更新」面板完成。
import { app } from 'electron'
import { loadSettings } from './settings'
import { curlJson } from './net'
import type { AppUpdateInfo } from '../shared/types'

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
  const repo = loadSettings().appUpdateRepo.trim()
  const current = app.getVersion()
  if (!repo) {
    return { enabled: false, current, latest: null, hasUpdate: false, url: null }
  }
  try {
    const j = (await curlJson(`https://api.github.com/repos/${repo}/releases/latest`, {
      'User-Agent': 'dsh-desktop',
      Accept: 'application/vnd.github+json'
    })) as { tag_name?: string; html_url?: string }
    const latest = (j.tag_name ?? '').replace(/^v/i, '') || null
    return {
      enabled: true,
      current,
      latest,
      hasUpdate: latest != null && latest !== current,
      url: j.html_url ?? null
    }
  } catch {
    return { enabled: true, current, latest: null, hasUpdate: false, url: null }
  }
}
