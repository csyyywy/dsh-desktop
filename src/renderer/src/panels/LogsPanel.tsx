// 日志面板（2.2 从 Dashboard.tsx 拆出）
import { useEffect, useRef } from 'react'
import { useLogs } from '../hooks'
import { Header } from '../ui'

export default function LogsPanel() {
  const logs = useLogs()
  const ref = useRef<HTMLDivElement>(null)
  // 1.6：贴底检测——用户上翻阅读时不再被每行新日志拽回底部
  const pinnedRef = useRef(true)
  const onScroll = (): void => {
    const el = ref.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  useEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) el.scrollTo({ top: el.scrollHeight })
  }, [logs])
  return (
    <div className="space-y-4">
      <Header title="日志" desc="dsh 进程与安装的实时输出" />
      <div
        ref={ref}
        onScroll={onScroll}
        className="min-h-[60vh] overflow-y-auto rounded-2xl border border-white/10 bg-ink-950/80 p-4 font-mono text-xs leading-relaxed text-slate-300"
      >
        {logs.length === 0 ? (
          <span className="text-slate-600">暂无日志</span>
        ) : (
          logs.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
