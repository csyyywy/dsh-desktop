import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AppSettings, AppStatus } from '../../shared/types'

export function useStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null)
  useEffect(() => {
    let mounted = true
    const off = window.dsh.onStatusChanged((s) => {
      if (mounted) setStatus(s)
    })
    window.dsh.getStatus().then((s) => {
      if (mounted) setStatus(s)
    })
    return () => {
      mounted = false
      off()
    }
  }, [])
  return status
}

export function useLogs(max = 400): string[] {
  const [logs, setLogs] = useState<string[]>([])
  useEffect(() => {
    let mounted = true
    window.dsh.getLogs().then((l) => {
      if (mounted) setLogs(l.slice(-max))
    })
    const off = window.dsh.onLogLine((line) => {
      if (!mounted) return
      setLogs((prev) => [...prev.slice(-(max - 1)), line])
    })
    return () => {
      mounted = false
      off()
    }
  }, [max])
  return logs
}

// —— 设置 store：多个组件（仪表盘背景、设置面板）共享同一份设置并随变更重渲染 ——
let snapshot: AppSettings | null = null
const listeners = new Set<() => void>()
let attempts = 0

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
function getSnapshot(): AppSettings | null {
  return snapshot
}
function notify(): void {
  listeners.forEach((l) => l())
}

/** 拉取设置（1.4：模块加载期 IPC 可能尚未就绪，失败有限重试 + 退避）。
 *  一旦成功即停止；updateSettings 成功后也会写入 snapshot。 */
function loadSettingsOnce(): void {
  if (snapshot !== null || attempts >= 10) return
  attempts++
  window.dsh
    .getSettings()
    .then((s) => {
      snapshot = s
      notify()
    })
    .catch(() => {
      setTimeout(loadSettingsOnce, Math.min(2000, 500 * attempts))
    })
}

loadSettingsOnce()

export function useSettings(): AppSettings | null {
  // 从未成功加载且未到上限时，借本次渲染再触发一次
  if (snapshot === null && attempts < 10) loadSettingsOnce()
  return useSyncExternalStore(subscribe, getSnapshot)
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = await window.dsh.setSettings(patch)
  snapshot = next
  notify()
  return next
}
