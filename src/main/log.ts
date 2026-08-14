// dsh 进程输出 + 内部操作的环形日志缓冲
type Listener = (line: string) => void

const MAX = 3000
const lines: string[] = []
const listeners = new Set<Listener>()

export function pushLog(line: string): void {
  const trimmed = line.replace(/\r?\n$/, '')
  if (!trimmed) return
  lines.push(trimmed)
  if (lines.length > MAX) lines.splice(0, lines.length - MAX)
  for (const l of listeners) l(trimmed)
}

export function getLogs(count = 500): string[] {
  return lines.slice(-count)
}

export function onLog(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
