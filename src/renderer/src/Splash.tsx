import { useEffect, useState } from 'react'
import type { AppStatus, InstallProgress } from '../../shared/types'
import { useSettings } from './hooks'
import WhaleMark from './WhaleMark'

const FALLBACK_BG = 'radial-gradient(140% 140% at 10% -10%, #1b2547 0%, #0b1020 55%, #0a0d18 100%)'

const PARTICLES = [
  { left: '12%', top: '28%', delay: '0s', size: 3 },
  { left: '82%', top: '18%', delay: '0.8s', size: 2 },
  { left: '24%', top: '72%', delay: '1.6s', size: 4 },
  { left: '70%', top: '64%', delay: '0.4s', size: 2 },
  { left: '48%', top: '14%', delay: '2.2s', size: 3 },
  { left: '90%', top: '80%', delay: '1.2s', size: 2 }
]

export default function Splash() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [retrying, setRetrying] = useState(false)
  const settings = useSettings()

  useEffect(() => {
    let mounted = true
    const offS = window.dsh.onStatusChanged((s) => {
      if (mounted) setStatus(s)
    })
    const offP = window.dsh.onInstallProgress((p) => {
      if (mounted) setProgress(p)
    })
    window.dsh.getStatus().then((s) => {
      if (mounted) setStatus(s)
    })
    return () => {
      mounted = false
      offS()
      offP()
    }
  }, [])

  const isError = status?.phase === 'error'
  const message = isError ? status?.error : progress?.message ?? '正在准备…'

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await window.dsh.start()
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div
      className="splash-card relative flex h-screen w-screen flex-col items-center justify-center gap-4 overflow-hidden border border-white/10 px-8"
      style={{ background: settings?.background || FALLBACK_BG }}
    >
      {/* 动态网格 */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(120,160,255,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(120,160,255,0.35) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
          animation: 'dsh-grid 3.5s linear infinite'
        }}
      />

      {/* 扫描线 */}
      <div
        className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent"
        style={{ animation: 'dsh-scan 3.8s ease-in-out infinite' }}
      />

      {/* 漂浮粒子 */}
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="pointer-events-none absolute rounded-full bg-cyan-300/80"
          style={{
            left: p.left,
            top: p.top,
            width: p.size,
            height: p.size,
            animation: `dsh-float 4s ease-in-out ${p.delay} infinite`
          }}
        />
      ))}

      {/* 品牌 */}
      <div className="relative flex items-center gap-3">
        <div className="relative">
          <div
            className="absolute -inset-4 rounded-full bg-cyan-400/30 blur-xl"
            style={{ animation: 'dsh-glow 3s ease-in-out infinite' }}
          />
          <WhaleMark className="relative h-10 w-10" fill="#4d6bfe" />
        </div>
        <div className="text-left">
          <div
            className="bg-gradient-to-r from-[#8ea0ff] via-[#4d6bfe] to-[#8ea0ff] bg-clip-text text-lg font-semibold text-transparent"
            style={{ backgroundSize: '200% 100%', animation: 'dsh-shimmer 3.5s linear infinite' }}
          >
            DeepSeek Harness
          </div>
          <div className="text-xs text-slate-400">本地桌面客户端</div>
        </div>
      </div>

      <div className="relative h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-cyan-300" />

      <div className="line-clamp-3 max-w-[320px] break-all text-center text-sm text-slate-300">{message}</div>

      {isError && (
        <div className="flex gap-2">
          <button
            onClick={retry}
            disabled={retrying}
            className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-400 disabled:opacity-50"
          >
            {retrying ? '重试中…' : '重试'}
          </button>
          <button
            onClick={() => void window.dsh.openDashboard()}
            className="rounded-xl bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
          >
            打开仪表盘
          </button>
        </div>
      )}
    </div>
  )
}
