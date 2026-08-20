// 运行后端面板（v0.2.0）：本机 / WSL 后端切换、发行版管理、一键部署（分阶段进度）、诊断、残留清理。
import { useCallback, useEffect, useState } from 'react'
import type { BackendInfo, BackendSetupProgress } from '../../shared/types'
import { useStatus } from './hooks'
import { errMsg } from './lib/errors'
import { Button, Card, Header, inputCls } from './ui'

const STAGE_LABEL: Record<string, string> = {
  ready: '发行版就绪检查',
  mkdir: '创建目录',
  node: '安装 Node',
  pnpm: '安装 pnpm',
  'npm-install': '安装 dsh',
  verify: '校验'
}

export default function BackendPanel() {
  const status = useStatus()
  const [info, setInfo] = useState<BackendInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [setup, setSetup] = useState<BackendSetupProgress | null>(null)
  const [diagnose, setDiagnose] = useState<string[] | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // 2.8：全部 useState 提到顶部（此前 distro 声明在计算之后，未来加早退会破坏 hooks 顺序）
  const [distro, setDistro] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setInfo(await window.dsh.backendInfo())
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => window.dsh.onBackendSetupProgress((p) => setSetup(p)), [])

  // 刷新后清理已不存在的发行版选中（避免残留失效名）
  useEffect(() => {
    if (distro && !(info?.distros ?? []).some((d) => d.name === distro)) setDistro('')
  }, [info, distro])

  // 1.8：run 保留返回值，并把「正常 resolve 但 ok:false / error 字段」的结构化失败也展示出来
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      if (r && typeof r === 'object') {
        const rec = r as unknown as Record<string, unknown>
        // 正常 resolve 但 ok:false / error 字段的结构化失败也要展示（1.8）
        if ('ok' in rec && rec.ok === false) {
          setMsg({ ok: false, text: typeof rec.message === 'string' ? rec.message : '操作失败' })
          return r
        }
        if (typeof rec.error === 'string' && rec.error) setMsg({ ok: false, text: rec.error })
      }
      return r
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) })
    } finally {
      setBusy(false)
      void refresh()
    }
    return undefined
  }

  const running = status?.running ?? false
  const wslActive = status?.backend === 'wsl'
  const deployables = (info?.distros ?? []).filter((d) => d.deployable)

  const doSetup = async (): Promise<void> => {
    if (!distro) {
      setMsg({ ok: false, text: '请先选择发行版' })
      return
    }
    setDiagnose(null)
    await run(() => window.dsh.backendSetup(distro))
    setSetup(null)
  }

  return (
    <div className="max-w-3xl space-y-5">
      <Header title="运行后端" desc="选择 dsh 运行环境：本机 Windows 进程，或 WSL 发行版内（界面与操作不变）" />

      {msg && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            msg.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'
          }`}
        >
          {msg.text}
        </div>
      )}

      {info?.error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          枚举 WSL 发行版失败：{info.error}
          <div className="mt-1 text-xs text-amber-400/70">请确认 WSL 已安装（终端运行 wsl --status），应用以普通用户运行时不应出现此问题。</div>
        </div>
      )}

      <Card>
        <div className="text-sm text-slate-300">后端模式（服务运行中不可切换）</div>
        <div className="mt-3 flex gap-3">
          <button
            disabled={running || busy}
            onClick={() => void run(() => window.dsh.backendSetMode('local'))}
            className={`flex-1 rounded-xl border px-4 py-3 text-sm transition disabled:opacity-50 ${
              !wslActive ? 'border-brand-500 bg-brand-500/15 text-brand-200' : 'border-white/10 bg-ink-900 hover:bg-white/5'
            }`}
          >
            <div className="font-semibold">本机模式</div>
            <div className="mt-1 text-xs text-slate-400">dsh 以 Windows 进程运行</div>
          </button>
          <button
            disabled={running || busy}
            onClick={() => void run(() => window.dsh.backendSetMode('wsl'))}
            className={`flex-1 rounded-xl border px-4 py-3 text-sm transition disabled:opacity-50 ${
              wslActive ? 'border-brand-500 bg-brand-500/15 text-brand-200' : 'border-white/10 bg-ink-900 hover:bg-white/5'
            }`}
          >
            <div className="font-semibold">WSL 模式</div>
            <div className="mt-1 text-xs text-slate-400">
              {wslActive ? `发行版：${status?.wslDistro ?? '—'}` : 'dsh 运行在 WSL 发行版内'}
            </div>
          </button>
        </div>
        {wslActive && !(status?.wslReady) && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            WSL 后端尚未部署完成，无法启动服务。请先在下方完成一键部署。
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-300">
            WSL 环境
            {info?.wslVersion ? (
              <span className="ml-2 text-xs text-slate-500">
                WSL {info.wslVersion} · 内核 {info.kernelVersion ?? '?'}
              </span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => void run(async () => refresh())}>
              刷新
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void run(async () => setDiagnose(await window.dsh.backendDiagnose()))}
            >
              诊断
            </Button>
          </div>
        </div>

        {deployables.length === 0 ? (
          <div className="mt-4 rounded-xl border border-white/10 bg-ink-900 px-4 py-4 text-sm text-slate-300">
            没有可用的 WSL 发行版。
            <div className="mt-3 flex gap-3">
              <Button
                disabled={busy}
                onClick={() => void run(() => window.dsh.backendInstallDistro('Ubuntu'))}
              >
                安装 Ubuntu 发行版（需 UAC）
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => window.dsh.backendInstallDistro('Debian'))}>
                安装 Debian
              </Button>
            </div>
            <div className="mt-3 text-xs text-slate-500">
              安装完成后请先在终端完成首次配置（创建用户名/密码），再回到此处点「刷新」并部署。
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {deployables.map((d) => (
                <label
                  key={d.name}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition ${
                    distro === d.name ? 'border-brand-500 bg-brand-500/10' : 'border-white/10 bg-ink-900 hover:bg-white/5'
                  }`}
                >
                  <div>
                    <div className="text-sm font-medium text-slate-100">{d.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {d.state} · WSL{d.version}
                    </div>
                  </div>
                  <input
                    type="radio"
                    name="wsl-distro"
                    checked={distro === d.name}
                    onChange={() => setDistro(d.name)}
                    className="accent-brand-500"
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button disabled={busy || !distro} onClick={() => void doSetup()}>
                一键部署到 {distro || '…'}
              </Button>
              {wslActive && status?.wslReady && (
                <Button
                  variant="ghost"
                  disabled={busy || running}
                  onClick={() => void run(() => window.dsh.backendSyncFromWindows())}
                  title="把本机 dsh 的插件/预设/会话同步到 WSL（停服执行，完成后自动恢复）"
                >
                  从本机同步插件与数据
                </Button>
              )}
              {!wslActive && (
                <span className="self-center text-xs text-slate-500">部署完成后自动切换为 WSL 模式并同步本机数据</span>
              )}
            </div>
          </div>
        )}
      </Card>

      {setup && (
        <Card>
          <div className="text-sm text-slate-300">
            {STAGE_LABEL[setup.stage] ?? setup.stage}
            <span className="ml-2 text-xs text-slate-500">{setup.percent}%</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-brand-500 transition-all"
              style={{ width: `${Math.max(2, setup.percent)}%` }}
            />
          </div>
          <div className="mt-2 break-all text-xs text-slate-400">{setup.message}</div>
        </Card>
      )}

      {status?.stalePid != null && (
        <Card>
          <div className="text-sm text-rose-300">
            检测到 WSL 内残留的 dsh 进程（pid {status.stalePid}），自动清理失败，请手动处理或强制清理：
          </div>
          <div className="mt-3">
            <Button variant="danger" disabled={busy} onClick={() => void run(() => window.dsh.backendForceCleanup())}>
              强制清理
            </Button>
          </div>
        </Card>
      )}

      {diagnose && (
        <Card>
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-300">诊断输出</div>
            <Button variant="ghost" onClick={() => setDiagnose(null)}>
              关闭
            </Button>
          </div>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-ink-950 p-4 text-xs text-slate-300">
            {diagnose.join('\n')}
          </pre>
        </Card>
      )}
    </div>
  )
}
