// 状态面板（2.2 从 Dashboard.tsx 拆出）
import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { useStatus } from '../hooks'
import { Button, Card, Header, Info } from '../ui'

type Phase = AppStatus['phase']

function phaseMeta(phase: Phase): { label: string; color: string; dot: string } {
  switch (phase) {
    case 'running':
      return { label: '运行中', color: 'text-emerald-400', dot: 'bg-emerald-400' }
    case 'starting':
      return { label: '启动中', color: 'text-amber-400', dot: 'bg-amber-400' }
    case 'installing':
      return { label: '安装中', color: 'text-amber-400', dot: 'bg-amber-400' }
    case 'error':
      return { label: '出错', color: 'text-rose-400', dot: 'bg-rose-400' }
    default:
      return { label: '已停止', color: 'text-slate-400', dot: 'bg-slate-500' }
  }
}

export default function StatusPanel() {
  const status = useStatus()
  const [busy, setBusy] = useState(false)
  const meta = phaseMeta(status?.phase ?? 'stopped')
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <Header title="状态" desc="DeepSeek Harness 服务运行状态" />
      {status?.error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
          {status.error}
        </div>
      )}
      <Card>
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 animate-pulse rounded-full ${meta.dot}`} />
          <span className={`text-lg font-semibold ${meta.color}`}>{meta.label}</span>
          <span className="text-sm text-slate-400">
            {status ? `端口 ${status.port} · ${status.nodeLabel === 'bundled' ? '内置 Node' : '系统 Node'}` : ''}
          </span>
          {status?.backend === 'wsl' && (
            <span className="rounded-full border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-xs text-brand-300">
              WSL · {status.wslDistro ?? '?'}
            </span>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {status?.running ? (
            <>
              <Button variant="danger" disabled={busy} onClick={() => void run(() => window.dsh.stop())}>
                停止
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => window.dsh.restart())}>
                重启
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => void run(() => window.dsh.start())}>
              {status?.phase === 'installing' ? '安装中…' : '启动'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void window.dsh.openWebUI()}>
            打开 Harness
          </Button>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        <Info label="已装版本" value={status?.installedVersion ?? '未安装'} />
        <Info label="最新版本" value={status?.latestVersion ?? '—'} />
        <Info label="访问地址" value={status?.url ?? ''} />
        <Info label="工作区" value={status?.workspace ?? ''} />
      </div>
      <Card>
        <div className="text-sm text-slate-400">
          配置与插件目录：<code className="text-slate-200">{status?.dshHome}</code>
          <div className="mt-2 flex gap-3">
            <button onClick={() => void window.dsh.openDshHome()} className="text-sm text-brand-300 hover:underline">
              打开配置目录
            </button>
            <button onClick={() => void window.dsh.openPluginsDir()} className="text-sm text-brand-300 hover:underline">
              打开插件目录
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
