// 更新面板（2.2 从 Dashboard.tsx 拆出）
import { useEffect, useState } from 'react'
import type { AppUpdateInfo, AppUpdateProgress } from '../../../shared/types'
import { useStatus } from '../hooks'
import { errMsg } from '../lib/errors'
import { fmtSize } from '../lib/format'
import { Button, Card, Header, inputCls } from '../ui'

export default function UpdatePanel() {
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
  // 检查失败 ≠ 未配置仓库，单独记录错误避免误导（1.3）
  const [appCheckErr, setAppCheckErr] = useState('')

  useEffect(() => {
    window.dsh.listVersions().then(setVersions).catch(() => setVersions([]))
    window.dsh
      .checkAppUpdate()
      .then(setAppInfo)
      .catch((e) => setAppCheckErr(errMsg(e)))
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
    try {
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
    } catch (e) {
      // 1.2：IPC reject 时不能把按钮永久卡在「下载中…」
      setDlState('idle')
      setAppMsg('下载失败: ' + errMsg(e))
      setAppMsgOk(false)
    }
  }

  const installAppNow = async (): Promise<void> => {
    try {
      const r = await window.dsh.installAppUpdate()
      setAppMsg(r.message)
      setAppMsgOk(r.ok)
    } catch (e) {
      setAppMsg(errMsg(e))
      setAppMsgOk(false)
    }
  }

  const installed = status?.installedVersion ?? null
  const latest = status?.latestVersion ?? null
  const updatable = installed != null && latest != null && installed !== latest

  const [actErr, setActErr] = useState('')
  const act = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    setMsg('')
    setActErr('')
    try {
      await fn()
      setMsg(done)
    } catch (e) {
      // 1.2：更新/回滚失败要展示原因，不能静默
      setActErr(errMsg(e))
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
          {actErr && <p className="mt-3 text-sm text-rose-400">{actErr}</p>}
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
                <Button disabled={dlState === 'downloading'} onClick={() => void startAppDownload()}>
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
        ) : appCheckErr ? (
          <p className="mt-2 text-xs text-rose-400">检查更新失败：{appCheckErr}</p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">检查更新中…</p>
        )}
      </Card>
    </div>
  )
}
