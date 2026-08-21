// 设置面板（2.2 从 Dashboard.tsx 拆出）
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/types'
import { updateSettings, useSettings } from '../hooks'
import { errMsg } from '../lib/errors'
import { FALLBACK_BG, BG_PRESETS } from '../lib/theme'
import { Button, Card, Field, Header, Toggle, inputCls } from '../ui'

export default function SettingsPanel() {
  const settings = useSettings()
  const [local, setLocal] = useState<AppSettings | null>(settings)
  const [saved, setSaved] = useState(false)
  const [bgErr, setBgErr] = useState('')
  // 密钥 write-only：主进程不再下发密钥值，这里只收集新输入（空 = 保持不变）
  const [keyInput, setKeyInput] = useState('')
  const [tokenInput, setTokenInput] = useState('')

  useEffect(() => {
    setLocal(settings)
  }, [settings])

  if (!local) return <Header title="设置" desc="加载中…" />
  const set = (patch: Partial<AppSettings>): void => setLocal({ ...local, ...patch })

  const save = async (): Promise<void> => {
    setSaved(false)
    setBgErr('')
    try {
      const patch: Partial<AppSettings> = { ...local }
      // 密钥不随整对象回传：只有用户输入了新值才提交，避免把脱敏空值写回覆盖真值
      delete (patch as Record<string, unknown>).apiKey
      delete (patch as Record<string, unknown>).githubToken
      if (keyInput.trim()) patch.apiKey = keyInput.trim()
      if (tokenInput.trim()) patch.githubToken = tokenInput.trim()
      await updateSettings(patch)
      setSaved(true)
      setKeyInput('')
      setTokenInput('')
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      // 1.2：保存失败要有反馈，不能静默
      setBgErr('保存失败: ' + errMsg(e))
    }
  }

  const clearSecret = async (k: 'apiKey' | 'githubToken'): Promise<void> => {
    setBgErr('')
    try {
      await updateSettings({ [k]: '' } as Partial<AppSettings>)
    } catch (e) {
      setBgErr(errMsg(e))
    }
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
      setBgErr(errMsg(e))
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
            <p className="mt-1 text-xs text-slate-500">端口被占用时自动释放本应用残留进程；被其他程序占用则自动切换并保存（见「状态」提示）。</p>
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
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className={inputCls}
              placeholder={settings?.hasApiKey ? '已保存（输入新值可更换，留空保持不变）' : 'DEEPSEEK_API_KEY，留空则在 Web UI 中设置'}
            />
            {settings?.hasApiKey && (
              <button onClick={() => void clearSecret('apiKey')} className="mt-1 text-xs text-rose-300 hover:underline">
                清除已保存的 Key
              </button>
            )}
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
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className={inputCls}
              placeholder={settings?.hasGithubToken ? '已保存（输入新值可更换，留空保持不变）' : 'ghp_xxx，仅本地保存'}
            />
            {settings?.hasGithubToken && (
              <button onClick={() => void clearSecret('githubToken')} className="mt-1 text-xs text-rose-300 hover:underline">
                清除已保存的 Token
              </button>
            )}
          </Field>
          <Toggle label="开机自启" checked={local.launchOnLogin} onChange={(v) => set({ launchOnLogin: v })} />

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
