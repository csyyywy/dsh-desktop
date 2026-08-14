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

window.dsh.getSettings().then((s) => {
  snapshot = s
  notify()
})

export function useSettings(): AppSettings | null {
  return useSyncExternalStore(subscribe, getSnapshot)
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = await window.dsh.setSettings(patch)
  snapshot = next
  notify()
  return next
}
