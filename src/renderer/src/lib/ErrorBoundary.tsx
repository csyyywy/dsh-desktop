import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: string | null
}

/** 渲染崩溃兜底（2.3）：任一组件抛错时不整窗白屏（Electron 里白屏用户无法恢复） */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(e: unknown): State {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center p-6 text-center">
          <div className="text-sm font-medium text-rose-300">界面渲染出错</div>
          <pre className="mt-3 max-h-40 max-w-lg overflow-auto whitespace-pre-wrap rounded-xl bg-ink-950 p-3 font-mono text-xs text-slate-400">
            {this.state.error}
          </pre>
          <button
            className="mt-4 rounded-lg bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
