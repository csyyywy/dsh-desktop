// 备份与回退面板（v0.3.0 独立界面）：手动存档（可独立回退）+ 自动快照（安装/卸载/更新前生成）。
import { useCallback, useEffect, useState } from 'react'
import type { ManualBackupInfo } from '../../../shared/types'
import { errMsg } from '../lib/errors'
import { Button, Card, Header, inputCls } from '../ui'

function formatSize(n: number): string {
  if (n <= 0) return '—'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleString()
}

export default function BackupPanel() {
  const [auto, setAuto] = useState<string[]>([])
  const [manual, setManual] = useState<ManualBackupInfo[]>([])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [msgOk, setMsgOk] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAuto(await window.dsh.listBackups())
    } catch {
      /* 忽略 */
    }
    try {
      setManual(await window.dsh.backupListManual())
    } catch {
      /* 忽略 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doOp = async (
    busyKey: string,
    fn: () => Promise<unknown>,
    after?: () => Promise<void>
  ): Promise<void> => {
    setBusy(busyKey)
    setMsg('')
    setMsgOk(true)
    try {
      const r = (await fn()) as { ok: boolean; message: string }
      setMsg(r.message)
      setMsgOk(r.ok)
      await after?.()
    } catch (e) {
      setMsg('操作失败: ' + errMsg(e))
      setMsgOk(false)
    } finally {
      setBusy(null)
    }
  }

  const createManual = async (): Promise<void> => {
    await doOp('create', () => window.dsh.backupCreateManual(label), async () => {
      setLabel('')
      await refresh()
    })
  }
  const restoreManual = async (name: string): Promise<void> => {
    if (!window.confirm(`从手动备份 ${name} 恢复整个配置/插件/会话？当前环境会先自动快照一份。`)) return
    await doOp(name, () => window.dsh.backupRestoreManual(name), refresh)
  }
  const deleteManual = async (name: string): Promise<void> => {
    if (!window.confirm(`确定删除手动备份 ${name}？删除后不可恢复。`)) return
    await doOp(name, () => window.dsh.backupDeleteManual(name), refresh)
  }
  const restoreAuto = async (name: string): Promise<void> => {
    if (!window.confirm(`回退到自动快照 ${name}？`)) return
    await doOp(name, () => window.dsh.restoreBackup(name), refresh)
  }
  const deleteAuto = async (name: string): Promise<void> => {
    if (!window.confirm(`确定删除自动快照 ${name}？删除后不可恢复。`)) return
    await doOp(name, () => window.dsh.deleteBackup(name), refresh)
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Header title="备份与回退" desc="手动存档可随时创建、整体回退；自动快照在每次安装/卸载/更新插件前生成" />

      {msg && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            msgOk ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {msg}
        </div>
      )}

      <Card>
        <div className="mb-1 text-sm font-medium text-slate-200">手动存档</div>
        <p className="mb-3 text-xs text-slate-400">
          把整个配置/插件/会话打包成一个独立存档，可在任意时刻一键回退。回退前会自动快照当前环境。
        </p>
        <div className="flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createManual()
            }}
            className={`max-w-[280px] ${inputCls}`}
            placeholder="存档标签（可选，仅字母数字-_）"
          />
          <Button disabled={busy === 'create'} onClick={() => void createManual()}>
            {busy === 'create' ? '创建中…' : '创建手动备份'}
          </Button>
        </div>
        {manual.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">暂无手动存档。创建一个后即可在此回退。</p>
        ) : (
          <div className="mt-4 space-y-2">
            {manual.map((b) => (
              <div key={b.name} className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-ink-950/70 px-4 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-slate-200">{b.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {formatSize(b.size)} · {formatDate(b.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    disabled={busy === b.name}
                    onClick={() => void restoreManual(b.name)}
                    className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-400 disabled:opacity-50"
                  >
                    {busy === b.name ? '恢复中…' : '回退'}
                  </button>
                  <button
                    disabled={busy === b.name}
                    onClick={() => void deleteManual(b.name)}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 text-sm font-medium text-slate-200">自动快照（{auto.length}）</div>
        <p className="mb-3 text-xs text-slate-400">每次安装/卸载/更新插件前自动生成，保留最近 10 份。</p>
        {auto.length === 0 ? (
          <p className="text-sm text-slate-500">暂无自动快照（安装一次插件后自动生成）</p>
        ) : (
          <div className="space-y-2">
            {auto.map((b) => (
              <div key={b} className="flex items-center justify-between rounded-xl border border-white/10 bg-ink-950/70 px-4 py-2">
                <span className="font-mono text-xs text-slate-300">{b}</span>
                <div className="flex shrink-0 gap-2">
                  <button
                    disabled={busy === b}
                    onClick={() => void restoreAuto(b)}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-brand-500/20 hover:text-brand-300 disabled:opacity-50"
                  >
                    {busy === b ? '回退中…' : '回退'}
                  </button>
                  <button
                    disabled={busy === b}
                    onClick={() => void deleteAuto(b)}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
