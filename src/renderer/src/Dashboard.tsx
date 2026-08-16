import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppSettings, AppStatus, AppUpdateInfo, AppUpdateProgress, PluginInfo, PluginUpdateInfo } from '../../shared/types'
import { useLogs, useStatus, useSettings, updateSettings } from './hooks'
import BackendPanel from './BackendPanel'
import FileBridgePanel from './FileBridgePanel'

type Tab = 'status' | 'settings' | 'update' | 'logs' | 'plugins' | 'backend' | 'files'
type Phase = AppStatus['phase']

const TABS: { id: Tab; label: string }[] = [
  { id: 'status', label: '状态' },
  { id: 'settings', label: '设置' },
  { id: 'backend', label: '运行后端' },
  { id: 'files', label: '文件桥' },
  { id: 'update', label: '更新' },
  { id: 'logs', label: '日志' },
  { id: 'plugins', label: '插件' }
]

const inputCls =
  'w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-brand-500'

const FALLBACK_BG = 'radial-gradient(140% 140% at 10% -10%, #1b2547 0%, #0b1020 55%, #0a0d18 100%)'

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

const BG_PRESETS: { name: string; value: string }[] = [
  { name: '深空蓝', value: FALLBACK_BG },
  { name: '极光', value: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { name: '紫夜', value: 'radial-gradient(120% 120% at 50% 0%, #2a1a4a 0%, #0b1020 62%)' },
  { name: '深海', value: 'linear-gradient(160deg, #0a192f 0%, #112240 55%, #0b1020 100%)' },
  { name: '暮色', value: 'linear-gradient(160deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' },
  { name: '纯黑', value: '#0a0a0f' }
]

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

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>('status')
  const settings = useSettings()
  return (
    <div
      className="flex h-screen w-screen overflow-hidden text-slate-200"
      style={{ background: settings?.background || FALLBACK_BG }}
    >
      <aside className="flex w-52 shrink-0 flex-col border-r border-white/10 bg-ink-950/85">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-4">
          <div>
            <div className="text-sm font-semibold leading-tight text-white">DeepSeek Harness</div>
            <div className="text-[11px] text-slate-400">本地桌面客户端</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${
                tab === t.id
                  ? 'bg-brand-500/15 text-brand-300'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <button
            onClick={() => void window.dsh.openWebUI()}
            className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-400"
          >
            打开 Harness
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-6">
        {tab === 'status' && <StatusPanel />}
        {tab === 'settings' && <SettingsPanel />}
        {tab === 'backend' && <BackendPanel />}
        {tab === 'files' && <FileBridgePanel />}
        {tab === 'update' && <UpdatePanel />}
        {tab === 'logs' && <LogsPanel />}
        {tab === 'plugins' && <PluginsPanel />}
      </main>
    </div>
  )
}

// ---------- 基础组件 ----------
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
  children
}: {
  variant?: 'primary' | 'ghost' | 'danger'
  disabled?: boolean
  onClick: () => void
  children: ReactNode
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
      className={`rounded-xl px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-sm text-slate-300">{label}</div>
      {children}
    </label>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center justify-between">
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`h-6 w-11 rounded-full p-0.5 transition ${checked ? 'bg-brand-500' : 'bg-white/10'}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink-900/80 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm text-slate-100" title={value}>
        {value}
      </div>
    </div>
  )
}

// ---------- 状态 ----------
function StatusPanel() {
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

// ---------- 设置 ----------
function SettingsPanel() {
  const settings = useSettings()
  const [local, setLocal] = useState<AppSettings | null>(settings)
  const [saved, setSaved] = useState(false)
  const [bgErr, setBgErr] = useState('')

  useEffect(() => {
    setLocal(settings)
  }, [settings])

  if (!local) return <Header title="设置" desc="加载中…" />
  const set = (patch: Partial<AppSettings>): void => setLocal({ ...local, ...patch })

  const save = async (): Promise<void> => {
    await updateSettings(local)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const chooseImage = async (): Promise<void> => {
    setBgErr('')
    try {
      const dataUrl = await window.dsh.pickBackgroundImage()
      if (!dataUrl) return
      set({
        background: `linear-gradient(rgba(10,13,24,0.5), rgba(10,13,24,0.5)), url("${dataUrl}") center/cover no-repeat`
      })
    } catch (e) {
      setBgErr((e as Error).message)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <Header title="设置" desc="保存后生效；端口 / 工作区 / 密钥改动需重启服务" />
      <Card>
        <div className="space-y-5">
          <Field label="端口">
            <input
              type="number"
              value={local.port}
              onChange={(e) => set({ port: Number(e.target.value) || 3080 })}
              className={inputCls}
            />
          </Field>
          <Field label="WSL 端口（WSL 模式专用，独立于本机端口）">
            <input
              type="number"
              value={local.wslPort}
              onChange={(e) => set({ wslPort: Number(e.target.value) || 3081 })}
              className={inputCls}
            />
          </Field>
          <Field label="工作区目录">
            <input
              value={local.workspace}
              onChange={(e) => set({ workspace: e.target.value })}
              className={inputCls}
              placeholder="留空使用用户主目录"
            />
          </Field>
          <Field label="API Key（可选）">
            <input
              type="password"
              value={local.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              className={inputCls}
              placeholder="DEEPSEEK_API_KEY，留空则在 Web UI 中设置"
            />
          </Field>
          <Field label="dsh 版本（默认 latest）">
            <input value={local.dshVersion} onChange={(e) => set({ dshVersion: e.target.value })} className={inputCls} />
          </Field>
          <Field label="npm 镜像源（安装 dsh / 插件用，国内加速）">
            <input
              value={local.npmRegistry}
              onChange={(e) => set({ npmRegistry: e.target.value })}
              className={inputCls}
              placeholder="https://registry.npmjs.org（官方）或 https://registry.npmmirror.com"
            />
          </Field>
          <Field label="应用更新仓库（owner/repo，空 = 禁用）">
            <input
              value={local.appUpdateRepo}
              onChange={(e) => set({ appUpdateRepo: e.target.value })}
              className={inputCls}
              placeholder="your-org/dsh-desktop"
            />
          </Field>
          <Field label="GitHub Token（可选，解除搜索频率限制）">
            <input
              type="password"
              value={local.githubToken}
              onChange={(e) => set({ githubToken: e.target.value })}
              className={inputCls}
              placeholder="ghp_xxx，仅本地保存"
            />
          </Field>
          <Toggle label="开机自启" checked={local.launchOnLogin} onChange={(v) => set({ launchOnLogin: v })} />
          <Toggle label="深色主题" checked={local.theme === 'dark'} onChange={(v) => set({ theme: v ? 'dark' : 'light' })} />

          <div>
            <div className="mb-2 text-sm text-slate-300">背景</div>
            <div className="flex flex-wrap items-center gap-2">
              {BG_PRESETS.map((p) => (
                <button
                  key={p.name}
                  title={p.name}
                  onClick={() => set({ background: p.value })}
                  className={`h-10 w-16 rounded-lg border transition ${
                    local.background === p.value ? 'border-brand-400 ring-1 ring-brand-400' : 'border-white/10'
                  }`}
                  style={{ background: p.value }}
                />
              ))}
              <button
                onClick={() => void chooseImage()}
                className="h-10 shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-slate-300 transition hover:bg-white/10"
              >
                选择图片
              </button>
            </div>
            {bgErr && <div className="mt-2 text-xs text-rose-400">{bgErr}</div>}
            {local.background.includes('data:image') ? (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-slate-400">图片背景已设置</span>
                <button onClick={() => set({ background: FALLBACK_BG })} className="text-xs text-brand-300 hover:underline">
                  清除图片
                </button>
              </div>
            ) : (
              <input
                value={local.background}
                onChange={(e) => set({ background: e.target.value })}
                className={`mt-3 ${inputCls}`}
                placeholder="自定义 CSS 背景，如 linear-gradient(...) 或 url(...)"
              />
            )}
          </div>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()}>保存</Button>
        {saved && <span className="text-sm text-emerald-400">已保存 ✓</span>}
        <Button variant="ghost" onClick={() => void window.dsh.restart()}>
          重启服务使配置生效
        </Button>
      </div>
    </div>
  )
}

// ---------- 更新 ----------
function UpdatePanel() {
  const status = useStatus()
  const [versions, setVersions] = useState<string[]>([])
  const [appInfo, setAppInfo] = useState<AppUpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [rollbackTarget, setRollbackTarget] = useState('')
  // 应用外壳更新
  const [dlState, setDlState] = useState<'idle' | 'downloading' | 'downloaded'>('idle')
  const [dlProgress, setDlProgress] = useState<AppUpdateProgress | null>(null)
  const [appMsg, setAppMsg] = useState('')
  const [appMsgOk, setAppMsgOk] = useState(true)

  useEffect(() => {
    window.dsh.listVersions().then(setVersions)
    window.dsh.checkAppUpdate().then(setAppInfo)
  }, [])

  useEffect(() => {
    return window.dsh.onAppUpdateProgress((p) => {
      setDlProgress(p)
      if (p.phase === 'done') {
        setDlState('downloaded')
        setAppMsg('下载完成，点击「立即安装并重启」')
        setAppMsgOk(true)
      } else if (p.phase === 'error') {
        setDlState('idle')
        setAppMsg(p.message)
        setAppMsgOk(false)
      }
    })
  }, [])

  const startAppDownload = async (): Promise<void> => {
    setDlState('downloading')
    setDlProgress(null)
    setAppMsg('')
    const r = await window.dsh.downloadAppUpdate()
    if (!r.ok) {
      setDlState('idle')
      setAppMsg(r.message)
      setAppMsgOk(false)
    } else {
      setDlState('downloaded')
      setAppMsg(r.message)
      setAppMsgOk(true)
    }
  }

  const installAppNow = async (): Promise<void> => {
    try {
      const r = await window.dsh.installAppUpdate()
      setAppMsg(r.message)
      setAppMsgOk(r.ok)
    } catch (e) {
      setAppMsg((e as Error).message)
      setAppMsgOk(false)
    }
  }

  const installed = status?.installedVersion ?? null
  const latest = status?.latestVersion ?? null
  const updatable = installed != null && latest != null && installed !== latest

  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      await fn()
      setMsg(done)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <Header title="更新" desc="通过 npm 更新 dsh 本体，保留所有插件与配置" />
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-slate-400">已装版本</div>
            <div className="text-lg font-semibold text-white">{installed ?? '未安装'}</div>
          </div>
          <div className="text-right">
            <div className="text-sm text-slate-400">最新版本</div>
            <div className="text-lg font-semibold text-brand-300">{latest ?? '—'}</div>
          </div>
        </div>
        <div className="mt-4">
          {updatable ? (
            <Button disabled={busy} onClick={() => void act(() => window.dsh.update(), `已更新到 ${latest} ✓`)}>
              {busy ? '更新中…' : `更新到 ${latest}`}
            </Button>
          ) : (
            <p className="text-sm text-slate-400">{installed ? '已是最新版本' : '尚未安装'}</p>
          )}
          {msg && <p className="mt-3 text-sm text-emerald-400">{msg}</p>}
        </div>
      </Card>
      <Card>
        <div className="text-sm font-medium text-slate-200">版本回滚</div>
        <p className="mt-1 text-xs text-slate-400">dsh 处于 developer preview，可能破坏兼容；可回滚到历史版本。</p>
        <div className="mt-3 flex gap-2">
          <select
            value={rollbackTarget}
            onChange={(e) => setRollbackTarget(e.target.value)}
            className={`flex-1 ${inputCls}`}
          >
            <option value="" disabled>
              选择历史版本…
            </option>
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <Button
            variant="danger"
            disabled={busy || !rollbackTarget || rollbackTarget === installed}
            onClick={() => void act(() => window.dsh.update(rollbackTarget), `已回滚到 ${rollbackTarget} ✓`)}
          >
            {busy ? '回滚中…' : '回滚'}
          </Button>
        </div>
      </Card>
      <Card>
        <div className="text-sm font-medium text-slate-200">应用外壳更新</div>
        <div className="mt-1 text-sm text-slate-400">
          当前外壳版本：{status?.appVersion ?? '—'}
          {appInfo?.enabled && appInfo.latest && ` · 最新版本：v${appInfo.latest}`}
        </div>
        {appInfo?.enabled ? (
          appInfo.hasUpdate ? (
            <div className="mt-3 space-y-3">
              <div className="flex items-center gap-3">
                <Button
                  disabled={dlState === 'downloading'}
                  onClick={() => void startAppDownload()}
                >
                  {dlState === 'downloading'
                    ? '下载中…'
                    : dlState === 'downloaded'
                      ? '已下载'
                      : `下载并安装 v${appInfo.latest}`}
                </Button>
                {dlState === 'downloaded' && (
                  <Button variant="ghost" onClick={() => void installAppNow()}>
                    立即安装并重启
                  </Button>
                )}
                <button
                  onClick={() => void window.dsh.openExternal(appInfo.url ?? '')}
                  className="text-xs text-slate-500 transition hover:text-slate-300 hover:underline"
                >
                  手动下载
                </button>
              </div>
              {dlState === 'downloading' && dlProgress && (
                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-brand-400 transition-all duration-300"
                      style={{ width: `${dlProgress.percent}%` }}
                    />
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {dlProgress.message}
                    {dlProgress.totalBytes > 0 &&
                      `（${fmtSize(dlProgress.receivedBytes)} / ${fmtSize(dlProgress.totalBytes)}）`}
                  </div>
                </div>
              )}
              {appMsg && <p className={`text-sm ${appMsgOk ? 'text-emerald-400' : 'text-rose-400'}`}>{appMsg}</p>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-400">外壳已是最新</p>
          )
        ) : (
          <p className="mt-2 text-xs text-slate-500">未配置更新仓库（可在「设置」里填写 appUpdateRepo 启用）</p>
        )}
      </Card>
    </div>
  )
}

// ---------- 日志 ----------
function LogsPanel() {
  const logs = useLogs()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [logs])
  return (
    <div className="space-y-4">
      <Header title="日志" desc="dsh 进程与安装的实时输出" />
      <div
        ref={ref}
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

// ---------- 插件管理器 ----------
function PluginsPanel() {
  const [installed, setInstalled] = useState<PluginInfo[]>([])
  const [results, setResults] = useState<PluginInfo[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [backups, setBackups] = useState<string[]>([])
  const [sort, setSort] = useState<'stars' | 'updated'>('stars')
  const [source, setSource] = useState<'github' | 'npm'>('github')
  const [customSpec, setCustomSpec] = useState('')
  const [updates, setUpdates] = useState<Record<string, PluginUpdateInfo>>({})
  const [checking, setChecking] = useState(false)

  const refreshInstalled = async (): Promise<void> => {
    setInstalled(await window.dsh.listPlugins())
  }
  const refreshUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const list = await window.dsh.checkPluginUpdates()
      setUpdates(Object.fromEntries(list.map((u) => [u.name, u])))
    } finally {
      setChecking(false)
    }
  }
  const refreshBackups = async (): Promise<void> => {
    setBackups(await window.dsh.listBackups())
  }
  const search = async (q: string, s: string = sort, src: string = source): Promise<void> => {
    setLoading(true)
    setResults(await window.dsh.searchPlugins(q, s, src))
    setLoading(false)
  }
  const switchSource = (s: 'github' | 'npm'): void => {
    setSource(s)
    void search(query, sort, s)
  }

  useEffect(() => {
    void refreshInstalled()
    void refreshUpdates()
    void refreshBackups()
    void search('')
  }, [])

  const doInstall = async (name: string): Promise<void> => {
    setBusy(name)
    setMsg('')
    const r = await window.dsh.installPlugin(name, source)
    setMsg(r.message)
    setBusy(null)
    await refreshInstalled()
    await refreshUpdates()
    await refreshBackups()
    await search(query)
  }
  const doUninstall = async (name: string): Promise<void> => {
    setBusy(name)
    setMsg('')
    const r = await window.dsh.uninstallPlugin(name)
    setMsg(r.message)
    setBusy(null)
    await refreshInstalled()
    await refreshUpdates()
    await refreshBackups()
    await search(query)
  }
  const doUpdate = async (name: string): Promise<void> => {
    setBusy(name)
    setMsg('')
    const r = await window.dsh.updatePlugin(name)
    setMsg(r.message)
    setBusy(null)
    await refreshInstalled()
    await refreshUpdates()
    await refreshBackups()
    await search(query)
  }
  const doRestore = async (name: string): Promise<void> => {
    setBusy(name)
    setMsg('')
    const r = await window.dsh.restoreBackup(name)
    setMsg(r.message)
    setBusy(null)
    await refreshInstalled()
    await refreshBackups()
    await search(query)
  }
  const doDeleteBackup = async (name: string): Promise<void> => {
    if (!window.confirm(`确定删除备份 ${name}？删除后不可恢复。`)) return
    setBusy(name)
    setMsg('')
    const r = await window.dsh.deleteBackup(name)
    setMsg(r.message)
    setBusy(null)
    await refreshBackups()
  }
  const doCustomInstall = async (): Promise<void> => {
    const spec = customSpec.trim()
    if (!spec) return
    // 地址（git/https）走 github 源，纯包名走 npm 源
    const src = /^git\+|^git:\/\/|^https?:\/\//.test(spec) ? 'github' : 'npm'
    setBusy('__custom__')
    setMsg('')
    const r = await window.dsh.installPlugin(spec, src)
    setMsg(r.message)
    setBusy(null)
    setCustomSpec('')
    await refreshInstalled()
    await refreshBackups()
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
        <div className={`rounded-xl border px-4 py-3 text-sm ${msg.startsWith('已') ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>
          {msg}
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

      <Card>
        <div className="mb-1 text-sm font-medium text-slate-200">备份与回退</div>
        <p className="mb-3 text-xs text-slate-400">每次安装/卸载插件前会自动备份当前环境，可一键回退。</p>
        {backups.length === 0 ? (
          <p className="text-sm text-slate-500">暂无备份（安装一次插件后自动生成）</p>
        ) : (
          <div className="space-y-2">
            {backups.map((b) => (
              <div key={b} className="flex items-center justify-between rounded-xl border border-white/10 bg-ink-950/70 px-4 py-2">
                <span className="font-mono text-xs text-slate-300">{b}</span>
                <div className="flex shrink-0 gap-2">
                  <button
                    disabled={busy === b}
                    onClick={() => void doRestore(b)}
                    className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-brand-500/20 hover:text-brand-300 disabled:opacity-50"
                  >
                    {busy === b ? '回退中…' : '回退'}
                  </button>
                  <button
                    disabled={busy === b}
                    onClick={() => void doDeleteBackup(b)}
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
