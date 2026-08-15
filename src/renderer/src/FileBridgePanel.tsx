// 文件桥面板（v0.2.0）：Windows ↔ WSL 双栏文件管理器。
// 复制/移动走主进程 fs-bridge（可中断流式 + .dshpart 清理），队列显示进度/速率/取消；
// 路径转换展示 UNC 与盘符映射双形态；支持从系统拖拽文件到 Windows 栏发起传输。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { FsEntry, FsSide, FsTransferProgress, FsTranslateResult } from '../../shared/types'
import { useStatus } from './hooks'

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function fmtSpeed(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB/s`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB/s`
  return `${n} B/s`
}

function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-white/10 bg-ink-900/80 p-5">{children}</div>
}

function Header({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="mt-1 text-sm text-slate-400">{desc}</p>
    </div>
  )
}

function Button({
  variant = 'primary',
  disabled,
  onClick,
  children,
  title
}: {
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  onClick: () => void
  children: ReactNode
  title?: string
}) {
  const styles: Record<string, string> = {
    primary: 'bg-brand-500 text-white hover:bg-brand-400',
    ghost: 'bg-white/5 text-slate-200 hover:bg-white/10',
    danger: 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
  }
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-xl px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  )
}

interface Pane {
  side: FsSide
  path: string
  entries: FsEntry[]
  loading: boolean
  error: string
  selected: Set<string>
}

const emptyPane = (side: FsSide): Pane => ({ side, path: '', entries: [], loading: false, error: '', selected: new Set() })

const PHASE_META: Record<string, { label: string; color: string }> = {
  queued: { label: '排队', color: 'text-slate-400' },
  copying: { label: '传输中', color: 'text-amber-400' },
  done: { label: '完成', color: 'text-emerald-400' },
  error: { label: '失败', color: 'text-rose-400' },
  cancelled: { label: '已取消', color: 'text-slate-400' }
}

export default function FileBridgePanel() {
  const status = useStatus()
  const [win, setWin] = useState<Pane>(() => ({ ...emptyPane('win'), path: 'C:\\Users' }))
  const [wsl, setWsl] = useState<Pane>(() => ({ ...emptyPane('wsl'), path: '/home' }))
  const [jobs, setJobs] = useState<FsTransferProgress[]>([])
  const [busy, setBusy] = useState(false)
  const [tInput, setTInput] = useState('')
  const [tResult, setTResult] = useState<FsTranslateResult | null>(null)
  const [tError, setTError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  // 初始路径：按当前工作区智能取
  useEffect(() => {
    if (!status) return
    setWin((p) => {
      if (p.path !== 'C:\\Users') return p
      const ws = status.workspace
      return { ...p, path: /^[A-Za-z]:[\\/]/.test(ws) ? ws : 'C:\\Users' }
    })
    setWsl((p) => {
      if (p.path !== '/home') return p
      const ws = status.workspace
      return { ...p, path: ws.startsWith('/') ? ws : '/home' }
    })
  }, [status])

  // 传输进度订阅
  useEffect(
    () =>
      window.dsh.onFsbProgress((p) => {
        setJobs((prev) => {
          const idx = prev.findIndex((j) => j.id === p.id)
          if (idx === -1) return [...prev, p]
          const next = [...prev]
          next[idx] = p
          return next
        })
      }),
    []
  )

  const load = useCallback(async (side: FsSide, path: string): Promise<void> => {
    const set = side === 'win' ? setWin : setWsl
    set((p) => ({ ...p, loading: true, error: '' }))
    try {
      const entries = await window.dsh.fsbList(side, path)
      set({ side, path, entries, loading: false, error: '', selected: new Set() })
    } catch (e) {
      set((p) => ({ ...p, loading: false, error: (e as Error).message }))
    }
  }, [])

  const refreshBoth = useCallback((): void => {
    void load('win', win.path)
    void load('wsl', wsl.path)
  }, [load, win.path, wsl.path])

  // 挂载时加载一次（wsl 侧仅当已切到 WSL 后端）
  const loadedRef = useRef(false)
  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true
    if (win.path) void load('win', win.path)
    if (wsl.path && status?.backend === 'wsl') void load('wsl', wsl.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, status])

  // 切换到 WSL 后端后自动加载 wsl 侧
  useEffect(() => {
    if (status?.backend === 'wsl' && wsl.path && wsl.entries.length === 0 && !wsl.loading && !wsl.error) {
      void load('wsl', wsl.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.backend, wsl.path, wsl.entries.length, wsl.loading, wsl.error, load])

  const enter = (side: FsSide, entry: FsEntry): void => {
    if (!entry.isDir) {
      void window.dsh.fsbOpen(side, entry.path)
      return
    }
    void load(side, entry.path)
  }

  const up = (side: FsSide): void => {
    const p = side === 'win' ? win.path : wsl.path
    const sep = side === 'win' ? '\\' : '/'
    const idx = p.lastIndexOf(sep)
    if (idx <= 0) return
    void load(side, p.slice(0, idx))
  }

  const root = (side: FsSide): void => {
    void load(side, side === 'win' ? 'C:\\' : '/')
  }

  const toggle = (side: FsSide, path: string): void => {
    const set = side === 'win' ? setWin : setWsl
    set((p) => {
      const sel = new Set(p.selected)
      if (sel.has(path)) sel.delete(path)
      else sel.add(path)
      return { ...p, selected: sel }
    })
  }

  const transfer = async (direction: 'to-wsl' | 'to-win', move: boolean): Promise<void> => {
    const src = direction === 'to-wsl' ? win : wsl
    const dst = direction === 'to-wsl' ? wsl : win
    const sel = [...src.selected]
    if (sel.length === 0 || !dst.path) return
    setBusy(true)
    try {
      await window.dsh.fsbTransfer(
        sel.map((p) => ({
          id: crypto.randomUUID(),
          srcSide: src.side,
          srcPath: p,
          dstSide: dst.side,
          dstPath: dst.path,
          move
        }))
      )
    } catch (e) {
      window.alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (side: FsSide, entry: FsEntry): Promise<void> => {
    if (!window.confirm(`确定删除「${entry.name}」？此操作不可恢复。`)) return
    const r = await window.dsh.fsbRemove(side, entry.path)
    if (!r.ok) window.alert(r.message)
    void load(side, side === 'win' ? win.path : wsl.path)
  }

  const rename = async (side: FsSide, entry: FsEntry): Promise<void> => {
    const name = window.prompt('新名称：', entry.name)
    if (!name || name === entry.name) return
    const r = await window.dsh.fsbRename(side, entry.path, name)
    if (!r.ok) window.alert(r.message)
    void load(side, side === 'win' ? win.path : wsl.path)
  }

  const mkdir = async (side: FsSide): Promise<void> => {
    const p = side === 'win' ? win.path : wsl.path
    const name = window.prompt('文件夹名称：')
    if (!name) return
    const sep = side === 'win' ? '\\' : '/'
    const r = await window.dsh.fsbMkdir(side, p.endsWith(sep) ? p + name : p + sep + name)
    if (!r.ok) window.alert(r.message)
    void load(side, p)
  }

  const doTranslate = async (): Promise<void> => {
    setTError('')
    setTResult(null)
    try {
      setTResult(await window.dsh.fsbTranslate(tInput.trim()))
    } catch (e) {
      setTError((e as Error).message)
    }
  }

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).then(() => window.alert('已复制到剪贴板'))
  }

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    dragDepth.current = 0
    setDragOver(false)
    e.preventDefault()
    const files = [...e.dataTransfer.files].map((f) => window.dsh.getPathForFile(f)).filter(Boolean)
    if (files.length === 0 || !wsl.path) return
    setBusy(true)
    try {
      await window.dsh.fsbTransfer(
        files.map((p) => ({
          id: crypto.randomUUID(),
          srcSide: 'win' as FsSide,
          srcPath: p,
          dstSide: 'wsl' as FsSide,
          dstPath: wsl.path,
          move: false
        }))
      )
    } catch (err) {
      window.alert((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const renderPane = (pane: Pane): ReactNode => {
    const sep = pane.side === 'win' ? '\\' : '/'
    return (
      <div
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
          setDragOver(true)
        }}
        onDragLeave={() => {
          dragDepth.current -= 1
          if (dragDepth.current <= 0) setDragOver(false)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => void onDrop(e)}
        className={`flex min-h-[320px] flex-col rounded-xl border bg-ink-950/60 ${
          dragOver ? 'border-brand-500' : 'border-white/10'
        }`}
      >
        <div className="flex items-center gap-1 border-b border-white/10 p-2">
          <Button variant="ghost" onClick={() => up(pane.side)} title="上级目录" disabled={pane.path.length <= (pane.side === 'win' ? 3 : 1)}>
            ↑
          </Button>
          <Button variant="ghost" onClick={() => root(pane.side)} title="根目录">
            ⌂
          </Button>
          <input
            value={pane.path}
            onChange={(e) => set(pane.side, { ...pane, path: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(pane.side, pane.path)
            }}
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-ink-900 px-2 py-1 text-xs text-slate-100 outline-none focus:border-brand-500"
          />
          <Button variant="ghost" onClick={() => void load(pane.side, pane.path)} title="刷新">
            ⟳
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-1">
          {pane.error && <div className="px-3 py-2 text-xs text-rose-300">{pane.error}</div>}
          {!pane.error &&
            pane.entries.map((entry) => (
              <div
                key={entry.path}
                className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5"
                onDoubleClick={() => enter(pane.side, entry)}
              >
                <input
                  type="checkbox"
                  checked={pane.selected.has(entry.path)}
                  onChange={() => toggle(pane.side, entry.path)}
                  onClick={(e) => e.stopPropagation()}
                  className="accent-brand-500"
                />
                <span className={entry.isDir ? 'text-amber-300' : 'text-slate-300'}>{entry.isDir ? '📁' : '📄'}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-200" title={entry.path}>
                  {entry.name}
                </span>
                {!entry.isDir && <span className="shrink-0 text-xs text-slate-500">{fmtSize(entry.size)}</span>}
                {!entry.isDir && <span className="shrink-0 text-[10px] text-slate-600">{fmtTime(entry.mtime)}</span>}
                <span className="hidden shrink-0 gap-1 group-hover:flex">
                  <button className="text-xs text-brand-300 hover:underline" onClick={() => void rename(pane.side, entry)}>
                    改名
                  </button>
                  <button className="text-xs text-rose-300 hover:underline" onClick={() => void remove(pane.side, entry)}>
                    删除
                  </button>
                  {pane.side === 'wsl' && (
                    <button
                      className="text-xs text-brand-300 hover:underline"
                      onClick={() => void window.dsh.fsbOpen(pane.side, entry.path, true)}
                    >
                      终端
                    </button>
                  )}
                </span>
              </div>
            ))}
          {pane.loading && <div className="px-3 py-2 text-xs text-slate-500">加载中…</div>}
        </div>
        <div className="flex items-center justify-between border-t border-white/10 px-3 py-2">
          <span className="text-xs text-slate-500">
            {pane.entries.filter((e) => e.isDir).length} 个目录 · {pane.entries.filter((e) => !e.isDir).length} 个文件
          </span>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={() => mkdir(pane.side)} title="新建文件夹">
              ＋新建
            </Button>
            <Button
              variant="ghost"
              disabled={pane.selected.size === 0}
              onClick={() => void transfer(pane.side === 'win' ? 'to-wsl' : 'to-win', false)}
            >
              复制 → {pane.side === 'win' ? 'WSL' : 'Windows'}
            </Button>
            <Button
              variant="ghost"
              disabled={pane.selected.size === 0}
              onClick={() => void transfer(pane.side === 'win' ? 'to-wsl' : 'to-win', true)}
            >
              移动 → {pane.side === 'win' ? 'WSL' : 'Windows'}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const set = (side: FsSide, patch: Pane): void => {
    if (side === 'win') setWin(patch)
    else setWsl(patch)
  }

  return (
    <div className="space-y-5">
      <Header title="文件桥" desc="在 Windows 与 WSL 之间浏览、复制、移动文件（传输可取消，残留自动清理）" />

      <div className="grid grid-cols-2 gap-4">
        {renderPane(win)}
        {status?.backend !== 'wsl' ? (
          <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-white/10 bg-ink-950/60 p-6 text-center text-sm text-slate-500">
            WSL 侧需先切换到 WSL 后端（「运行后端」面板一键部署）。
            <br />
            当前为本机模式，仅可浏览 Windows 侧。
          </div>
        ) : (
          renderPane(wsl)
        )}
      </div>

      {jobs.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm text-slate-300">传输队列（最多 2 个并发）</div>
            <Button variant="ghost" onClick={() => setJobs([])}>
              清空记录
            </Button>
          </div>
          <div className="space-y-3">
            {jobs.map((j) => {
              const meta = PHASE_META[j.phase] ?? PHASE_META.queued
              const pct = j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0
              return (
                <div key={j.id} className="rounded-xl border border-white/10 bg-ink-950/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-200" title={`${j.srcPath} → ${j.dstPath}`}>
                        {j.name}
                        <span className="ml-2 text-xs text-slate-500">
                          {j.srcSide === 'wsl' ? 'WSL' : 'Win'} → {j.dstSide === 'wsl' ? 'WSL' : 'Win'}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">{j.srcPath}</div>
                    </div>
                    <span className={`shrink-0 text-xs font-medium ${meta.color}`}>{meta.label}</span>
                    {j.phase === 'copying' || j.phase === 'queued' ? (
                      <Button
                        variant="danger"
                        onClick={() => void window.dsh.fsbCancel(j.id)}
                        title="取消传输（自动清理未完成文件）"
                      >
                        取消
                      </Button>
                    ) : null}
                  </div>
                  {(j.phase === 'copying' || j.phase === 'queued') && (
                    <div className="mt-2 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="shrink-0 text-[11px] text-slate-400">
                        {fmtSize(j.done)} / {fmtSize(j.total)} · {fmtSpeed(j.bytesPerSec)}
                      </span>
                    </div>
                  )}
                  {j.message && <div className="mt-1 text-[11px] text-slate-500">{j.message}</div>}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Card>
        <div className="text-sm text-slate-300">路径转换</div>
        <div className="mt-2 flex gap-2">
          <input
            value={tInput}
            onChange={(e) => setTInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doTranslate()
            }}
            placeholder="粘贴任意路径：C:\... / \\wsl.localhost\... / /home/..."
            className={inputCls}
          />
          <Button onClick={() => void doTranslate()}>转换</Button>
        </div>
        {tError && <div className="mt-2 text-xs text-rose-300">{tError}</div>}
        {tResult && (
          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-slate-500">Linux 路径</span>
              <code className="min-w-0 flex-1 break-all text-slate-200">{tResult.linux}</code>
              <button className="shrink-0 text-brand-300 hover:underline" onClick={() => copyText(tResult.linux)}>
                复制
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-slate-500">WSL 网络路径</span>
              <code className="min-w-0 flex-1 break-all text-slate-200">{tResult.windows}</code>
              <button className="shrink-0 text-brand-300 hover:underline" onClick={() => copyText(tResult.windows)}>
                复制
              </button>
            </div>
            {tResult.windowsLocal && (
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-slate-500">盘符映射</span>
                <code className="min-w-0 flex-1 break-all text-slate-400">{tResult.windowsLocal}</code>
                <button className="shrink-0 text-brand-300 hover:underline" onClick={() => copyText(tResult.windowsLocal!)}>
                  复制
                </button>
              </div>
            )}
          </div>
        )}
        {!tResult && !tError && (
          <div className="mt-2 text-xs text-slate-500">
            提示：Windows 盘符映射（如 C:\Users）仅对 /mnt/* 挂载路径有效；UNC 路径对任意 WSL 路径有效。
          </div>
        )}
      </Card>
    </div>
  )
}

const inputCls =
  'w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-brand-500'
