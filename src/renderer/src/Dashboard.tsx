// 仪表盘外壳（2.2 重构）：只负责 tab 路由与侧栏；各面板拆到 panels/。
// 1.10：面板全部常驻挂载、用 hidden 切换——切 tab 不再卸载面板，
// 文件桥传输进度 / 更新下载状态 / 插件搜索等订阅与状态不丢失。
import { useState } from 'react'
import { useSettings } from './hooks'
import { FALLBACK_BG } from './lib/theme'
import BackendPanel from './BackendPanel'
import FileBridgePanel from './FileBridgePanel'
import StatusPanel from './panels/StatusPanel'
import SettingsPanel from './panels/SettingsPanel'
import UpdatePanel from './panels/UpdatePanel'
import LogsPanel from './panels/LogsPanel'
import PluginsPanel from './panels/PluginsPanel'
import BackupPanel from './panels/BackupPanel'

type Tab = 'status' | 'settings' | 'update' | 'logs' | 'plugins' | 'backups' | 'backend' | 'files'

const TABS: { id: Tab; label: string }[] = [
  { id: 'status', label: '状态' },
  { id: 'settings', label: '设置' },
  { id: 'backend', label: '运行后端' },
  { id: 'files', label: '文件桥' },
  { id: 'update', label: '更新' },
  { id: 'logs', label: '日志' },
  { id: 'plugins', label: '插件' },
  { id: 'backups', label: '备份与回退' }
]

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
        {/* 面板常驻挂载 + hidden 切换（1.10），保证跨 tab 不丢状态 */}
        <div className={tab === 'status' ? '' : 'hidden'}>
          <StatusPanel />
        </div>
        <div className={tab === 'settings' ? '' : 'hidden'}>
          <SettingsPanel />
        </div>
        <div className={tab === 'backend' ? '' : 'hidden'}>
          <BackendPanel />
        </div>
        <div className={tab === 'files' ? '' : 'hidden'}>
          <FileBridgePanel />
        </div>
        <div className={tab === 'update' ? '' : 'hidden'}>
          <UpdatePanel />
        </div>
        <div className={tab === 'logs' ? '' : 'hidden'}>
          <LogsPanel />
        </div>
        <div className={tab === 'plugins' ? '' : 'hidden'}>
          <PluginsPanel active={tab === 'plugins'} />
        </div>
        <div className={tab === 'backups' ? '' : 'hidden'}>
          <BackupPanel active={tab === 'backups'} />
        </div>
      </main>
    </div>
  )
}
