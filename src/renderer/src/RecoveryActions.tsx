// 启动失败恢复操作卡（v0.3.0，#81/#94/#96/#98）：列出问题插件 + 「卸载并重试」+
// 「重置数据（备份后重建）」+「重试启动」。Splash 与 StatusPanel 复用。
import { useState } from 'react'
import type { PluginRecoveryInfo } from '../../shared/types'
import { Button } from './ui'

export default function RecoveryActions({ recovery }: { recovery: PluginRecoveryInfo | null }) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!recovery) return null
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try {
      await fn()
    } catch {
      /* 主进程已置 error 态，状态广播会刷新界面 */
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="w-full max-w-xl rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
      <div className="font-medium text-rose-300">启动失败，可尝试以下恢复操作</div>
      <div className="mt-1 line-clamp-2 break-all text-xs text-rose-200/70">{recovery.message}</div>

      {recovery.offending.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-rose-200/70">疑似问题插件：</div>
          {recovery.offending.map((t) => {
            const n = t.name
            const key = n ? `uninstall:${n}` : `none:${t.displayName}`
            return (
              <div key={key} className="flex items-center justify-between gap-2 rounded-lg bg-rose-950/40 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-rose-100">{t.displayName}</div>
                  <div className="truncate text-[11px] text-rose-200/60">{t.reason}</div>
                </div>
                {n ? (
                  <button
                    disabled={busy === key}
                    onClick={() => void run(key, () => window.dsh.recoveryUninstallRetry(n))}
                    className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-400 disabled:opacity-50"
                  >
                    {busy === key ? '卸载中…' : '卸载并重试'}
                  </button>
                ) : (
                  <span className="shrink-0 rounded-lg bg-white/5 px-2 py-1 text-[11px] text-slate-400">
                    无法自动卸载（不在已装依赖中）
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {recovery.canReset && (
          <button
            disabled={busy === 'reset'}
            onClick={() => void run('reset', () => window.dsh.recoveryResetData())}
            className="rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-500/30 disabled:opacity-50"
          >
            {busy === 'reset' ? '重置中…' : '重置数据（备份后重建）'}
          </button>
        )}
        <Button variant="ghost" size="sm" disabled={busy === 'restart'} onClick={() => void run('restart', () => window.dsh.restart())}>
          {busy === 'restart' ? '重试中…' : '重试启动'}
        </Button>
      </div>
    </div>
  )
}
