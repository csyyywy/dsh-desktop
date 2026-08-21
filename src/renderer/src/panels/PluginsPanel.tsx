// 插件管理面板（2.2 从 Dashboard.tsx 拆出，含 PluginRow）
import { useEffect, useRef, useState } from 'react'
import type { PluginInfo, PluginOpResult, PluginUpdateInfo } from '../../../shared/types'
import { errMsg } from '../lib/errors'
import { Button, Card, Header, inputCls } from '../ui'

export default function PluginsPanel() {
  const [installed, setInstalled] = useState<PluginInfo[]>([])
  const [results, setResults] = useState<PluginInfo[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  // 1.9：用 PluginOpResult.ok 决定消息配色，不再猜中文前缀
  const [msgOk, setMsgOk] = useState(true)
  const [sort, setSort] = useState<'stars' | 'updated'>('stars')
  const [source, setSource] = useState<'github' | 'npm'>('github')
  const [customSpec, setCustomSpec] = useState('')
  const [updates, setUpdates] = useState<Record<string, PluginUpdateInfo>>({})
  const [checking, setChecking] = useState(false)
  // 构建脚本放行确认（默认拒绝）：pnpm 拦截到带构建脚本的依赖时，先列清单等用户确认
  const [pending, setPending] = useState<
    { kind: 'install' | 'update'; name: string; src?: string; list: string[] } | null
  >(null)

  const refreshInstalled = async (): Promise<void> => {
    try {
      setInstalled(await window.dsh.listPlugins())
    } catch (e) {
      setMsgOk(false)
      setMsg('已装列表刷新失败: ' + errMsg(e))
    }
  }
  const refreshUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const list = await window.dsh.checkPluginUpdates()
      setUpdates(Object.fromEntries(list.map((u) => [u.name, u])))
    } catch {
      /* 忽略 */
    } finally {
      setChecking(false)
    }
  }
  // 1.5：搜索竞态防护——快速连点/切源/排序时只接受最新一次请求的结果
  const searchSeq = useRef(0)
  const search = async (q: string, s: string = sort, src: string = source): Promise<void> => {
    const seq = ++searchSeq.current
    setLoading(true)
    try {
      const list = await window.dsh.searchPlugins(q, s, src)
      if (seq !== searchSeq.current) return // 过期响应，丢弃
      setResults(list)
      // 不清 msg：搜索成功不应抹掉上一步操作的结果/错误提示（操作消息由下一次操作覆盖）
    } catch (e) {
      if (seq !== searchSeq.current) return
      setResults([])
      setMsgOk(false)
      setMsg('搜索失败: ' + errMsg(e))
    } finally {
      if (seq === searchSeq.current) setLoading(false)
    }
  }
  const switchSource = (s: 'github' | 'npm'): void => {
    setSource(s)
    void search(query, sort, s)
  }

  useEffect(() => {
    void refreshInstalled()
    void refreshUpdates()
    void search('')
  }, [])

  // 1.2：统一「busy + 结果消息 + 异常兜底」——IPC reject 时 busy 必须复位
  const doOp = async (
    busyKey: string,
    fn: () => Promise<PluginOpResult>,
    after?: () => Promise<void>
  ): Promise<void> => {
    setBusy(busyKey)
    setMsg('')
    setMsgOk(true)
    try {
      const r = await fn()
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
  // v0.3.0：安装前冲突预检（先检测再安装）——命中冲突先报告，用户确认后才继续。
  // approvedBuilds 非空 = 构建脚本放行后的重试（跳过预检，直接装）
  const preflightAndInstall = async (
    busyKey: string,
    name: string,
    src: string,
    approvedBuilds?: string[]
  ): Promise<void> => {
    setBusy(busyKey)
    setMsg('')
    setMsgOk(true)
    try {
      if (!approvedBuilds) {
        const check = await window.dsh.preflightPlugin(name, src)
        const detail = [...(check.conflicts ?? []), ...(check.warnings ?? [])].map((c) => `· ${c}`).join('\n')
        if (!check.ok) {
          setMsg(`${check.message}\n${detail}`)
          setMsgOk(false)
          if (!window.confirm(`${check.message}\n\n${detail}\n\n仍要安装吗？`)) return
        } else if (detail) {
          setMsg(`提示：\n${detail}`)
        }
      }
      const r = await window.dsh.installPlugin(name, src, approvedBuilds)
      if (!r.ok && r.buildApprovals?.length) {
        // pnpm 拦截到构建脚本：列清单等用户逐包确认（默认拒绝，不自动放行）
        setPending({ kind: 'install', name, src, list: r.buildApprovals })
        setMsg(r.message)
        setMsgOk(false)
        return
      }
      setMsg(r.message)
      setMsgOk(r.ok)
      await refreshInstalled()
      await refreshUpdates()
      await search(query)
    } catch (e) {
      setMsg('安装失败: ' + errMsg(e))
      setMsgOk(false)
    } finally {
      setBusy(null)
    }
  }
  const doInstall = (name: string): Promise<void> => preflightAndInstall(name, name, source)
  const doUninstall = (name: string): Promise<void> =>
    doOp(name, () => window.dsh.uninstallPlugin(name), async () => {
      await refreshInstalled()
      await refreshUpdates()
      await search(query)
    })
  const doUpdate = (name: string, approvedBuilds?: string[]): Promise<void> =>
    doOp(
      name,
      async () => {
        const r = await window.dsh.updatePlugin(name, approvedBuilds)
        if (!r.ok && r.buildApprovals?.length) {
          setPending({ kind: 'update', name, list: r.buildApprovals })
        }
        return r
      },
      async () => {
        await refreshInstalled()
        await refreshUpdates()
        await search(query)
      }
    )
  // 放行并重试：把用户确认的清单原样传回主进程
  const approveAndRetry = async (): Promise<void> => {
    const p = pending
    if (!p) return
    setPending(null)
    if (p.kind === 'install') await preflightAndInstall(p.name, p.name, p.src ?? source, p.list)
    else await doUpdate(p.name, p.list)
  }
  const doCustomInstall = async (): Promise<void> => {
    const spec = customSpec.trim()
    if (!spec) return
    // 地址（git/https）走 github 源，纯包名走 npm 源
    const src = /^git\+|^git:\/\/|^https?:\/\//.test(spec) ? 'github' : 'npm'
    setCustomSpec('')
    await preflightAndInstall('__custom__', spec, src)
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Header title="插件" desc="DeepSeek Harness 采用「一切皆插件」架构 —— 浏览官方仓库并一键安装" />

      <div className="flex flex-wrap gap-2">
        <div className="flex shrink-0 rounded-xl border border-white/10 bg-ink-900 p-0.5">
          <button
            onClick={() => switchSource('github')}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              source === 'github' ? 'bg-brand-500/20 text-brand-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            GitHub
          </button>
          <button
            onClick={() => switchSource('npm')}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              source === 'npm' ? 'bg-brand-500/20 text-brand-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            npm
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search(query)
          }}
          className={`min-w-[160px] flex-1 ${inputCls}`}
          placeholder={source === 'github' ? '搜索 GitHub topic dsh-plugin …' : '搜索 npm dsh-plugin …'}
        />
        <Button variant="ghost" onClick={() => void search(query)}>
          搜索
        </Button>
        {source === 'github' && (
          <select
            value={sort}
            onChange={(e) => {
              const v = e.target.value as 'stars' | 'updated'
              setSort(v)
              void search(query, v)
            }}
            className="shrink-0 rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-brand-500"
          >
            <option value="stars">按 star 数</option>
            <option value="updated">按最近更新</option>
          </select>
        )}
      </div>
      {msg && (
        <div
          className={`whitespace-pre-line rounded-xl border px-4 py-3 text-sm ${
            msgOk ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {msg}
        </div>
      )}

      {pending && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <div className="font-medium">需要放行构建脚本（默认拒绝）</div>
          <p className="mt-1 text-xs text-amber-200/80">
            以下依赖带有安装期构建脚本，放行 = 允许其在本机执行代码。请确认来源可信后再放行：
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
            {pending.list.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button disabled={busy !== null} onClick={() => void approveAndRetry()}>
              放行并重试
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消安装
            </Button>
          </div>
        </div>
      )}

      <Card>
        <div className="mb-1 text-sm font-medium text-slate-200">自定义安装</div>
        <p className="mb-3 text-xs text-slate-400">粘贴 Git 仓库地址或 npm 包名，直接安装（不经过搜索）。</p>
        <div className="flex gap-2">
          <input
            value={customSpec}
            onChange={(e) => setCustomSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doCustomInstall()
            }}
            className={`flex-1 ${inputCls}`}
            placeholder="如 https://github.com/user/plugin 或 @scope/plugin"
          />
          <Button disabled={busy === '__custom__' || !customSpec.trim()} onClick={() => void doCustomInstall()}>
            {busy === '__custom__' ? '安装中…' : '安装'}
          </Button>
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between text-sm font-medium text-slate-200">
          <span>已安装（{installed.length}）</span>
          <button
            disabled={checking}
            onClick={() => void refreshUpdates()}
            className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-brand-500/20 hover:text-brand-300 disabled:opacity-50"
          >
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>
        {installed.length === 0 ? (
          <p className="text-sm text-slate-500">尚未安装任何插件，从下方官方仓库搜索安装。</p>
        ) : (
          <div className="space-y-2">
            {installed.map((p) => (
              <PluginRow
                key={p.name}
                p={p}
                busy={busy}
                updateInfo={updates[p.name]}
                onUninstall={() => doUninstall(p.name)}
                onUpdate={() => doUpdate(p.name)}
              />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 text-sm font-medium text-slate-200">官方仓库</div>
        {loading ? (
          <p className="text-sm text-slate-500">加载中…</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-slate-500">
            没有结果。若之前能看到插件却突然为空，多半是 GitHub API 限流（未配置 Token 时每分钟约 10 次），稍等重试，或到「设置」里配置 GitHub Token。
          </p>
        ) : (
          <div className="space-y-2">
            {results.map((p) => (
              <PluginRow key={p.name} p={p} busy={busy} onInstall={() => doInstall(p.repo ?? p.name)} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days < 1) return '今天更新'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function PluginRow({
  p,
  busy,
  updateInfo,
  onInstall,
  onUninstall,
  onUpdate
}: {
  p: PluginInfo
  busy: string | null
  updateInfo?: PluginUpdateInfo
  onInstall?: () => void
  onUninstall?: () => void
  onUpdate?: () => void
}) {
  const working = busy === p.name
  const displayName = p.repo || p.name
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-ink-950/70 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-100">{displayName}</span>
          {p.version && <span className="shrink-0 text-xs text-slate-500">v{p.version}</span>}
          {updateInfo?.updateAvailable && (
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
              可更新 → v{updateInfo.latest}
            </span>
          )}
          {updateInfo?.note && (
            <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-slate-400" title={updateInfo.note}>
              {updateInfo.note}
            </span>
          )}
          {updateInfo?.error && (
            <span className="shrink-0 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300" title={updateInfo.error}>
              检查失败
            </span>
          )}
          {p.stars > 0 && <span className="shrink-0 text-xs text-amber-400">★ {p.stars}</span>}
          {p.updatedAt && <span className="shrink-0 text-xs text-slate-500">{formatDate(p.updatedAt)}</span>}
          {p.installed && (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300">已安装</span>
          )}
        </div>
        {p.description && <div className="mt-0.5 truncate text-xs text-slate-400">{p.description}</div>}
        {p.repoUrl && (
          <button
            onClick={() => void window.dsh.openExternal(p.repoUrl ?? '')}
            className="mt-0.5 inline-block max-w-full truncate text-left text-xs text-brand-300 hover:underline"
          >
            {p.repoUrl}
          </button>
        )}
      </div>
      {p.installed ? (
        <div className="flex shrink-0 gap-2">
          {onUpdate && updateInfo?.updateAvailable && (
            <button
              disabled={working}
              onClick={onUpdate}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-400 disabled:opacity-50"
            >
              {working ? '更新中…' : '更新'}
            </button>
          )}
          {onUninstall && (
            <button
              disabled={working}
              onClick={onUninstall}
              className="shrink-0 rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-50"
            >
              {working ? '处理中…' : '卸载'}
            </button>
          )}
        </div>
      ) : (
        onInstall && (
          <button
            disabled={working}
            onClick={onInstall}
            className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-400 disabled:opacity-50"
          >
            {working ? '安装中…' : '安装'}
          </button>
        )
      )}
    </div>
  )
}
