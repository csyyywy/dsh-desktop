// 渲染层统一错误处理：
// - errMsg(e)：把 IPC reject 的任意值收敛成可读字符串（Electron 的 ipcRenderer.invoke
//   reject 时可能是 Error / string / 任意值，直接 (e as Error).message 会得到 undefined）
// - useAsyncAction：封装「busy + catch + 错误消息」，替代各面板散落的 try/catch
import { useCallback, useRef, useState } from 'react'

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return e == null ? '未知错误' : String(e)
}

export interface AsyncAction<T extends unknown[], R> {
  busy: boolean
  error: string
  run: (...args: T) => Promise<void>
  clear: () => void
}

/** 包装一个返回 Promise 的 IPC 调用：自动维护 busy 状态与错误消息（不抛出）。 */
export function useAsyncAction<T extends unknown[], R>(fn: (...args: T) => Promise<R>): AsyncAction<T, R> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fnRef = useRef(fn)
  fnRef.current = fn
  const run = useCallback(async (...args: T): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fnRef.current(...args)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }, [])
  const clear = useCallback(() => setError(''), [])
  return { busy, error, run, clear }
}
