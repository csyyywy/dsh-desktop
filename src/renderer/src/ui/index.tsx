// 渲染层共享 UI 基元（2.1）：Card/Header/Button/Field/Toggle/Info/inputCls。
// 此前 Dashboard / BackendPanel / FileBridgePanel 各抄一份且细节悄悄不一致
// （Button 的 padding 两处 px-4/py-2、一处 px-3/py-1.5），统一后用 size 控制。
import type { ReactNode } from 'react'

export const inputCls =
  'w-full rounded-xl border border-white/10 bg-ink-900 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-brand-500'

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-white/10 bg-ink-900/80 p-5">{children}</div>
}

export function Header({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="mt-1 text-sm text-slate-400">{desc}</p>
    </div>
  )
}

export function Button({
  variant = 'primary',
  size = 'md',
  disabled,
  onClick,
  children,
  title
}: {
  variant?: 'primary' | 'ghost' | 'danger'
  /** md = px-4 py-2（面板主按钮）；sm = px-3 py-1.5（行内小按钮） */
  size?: 'md' | 'sm'
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
  const pad = size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2'
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-xl ${pad} text-sm font-medium transition disabled:opacity-50 ${styles[variant]}`}
    >
      {children}
    </button>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-sm text-slate-300">{label}</div>
      {children}
    </label>
  )
}

export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className="flex w-full items-center justify-between">
      <span className="text-sm text-slate-300">{label}</span>
      <span className={`h-6 w-11 rounded-full p-0.5 transition ${checked ? 'bg-brand-500' : 'bg-white/10'}`}>
        <span className={`block h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  )
}

export function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-ink-900/80 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm text-slate-100" title={value}>
        {value}
      </div>
    </div>
  )
}
