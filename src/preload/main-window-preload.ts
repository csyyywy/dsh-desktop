// 主窗口专用 preload（v0.3.0，移植 dataelement/dsh-desktop v0.4.0 #94/#96 思路，MIT）。
// 只暴露最小恢复 API（window.__dshRecovery），不把完整 window.dsh 暴露给 dsh Web UI。
// 作用：检测 dsh Web UI 的全屏错误页，注入「重启 Harness / 重试连接」按钮，
// 点击后经主进程清理/重启并刷新页面——避免用户卡死在错误页。
// v0.3.4：新增 dsh ≥ 0.1.2 的 401 认证页兜底（launch token 正常时不会出现；
// 一旦出现说明外壳未能取得 token，重启服务可重新解析并带 token 导航）。
// tsconfig.node.json 的 lib 是 ES2023（无 DOM），此处需要 DOM 类型
/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'

const RECOVERY_KEY = '__dshRecovery'
const BTN_MARKER = 'data-dsh-recovery'

/** 可检测的全屏错误页：页面文案包含 match 即注入对应按钮 */
const ERROR_PAGES: { match: string; label: string }[] = [
  { match: 'Failed to load plugins', label: '重启 Harness' },
  { match: 'dsh web authentication required', label: '重试连接' }
]

function injectRestartButton(card: Element, label: string): void {
  if (card.querySelector(`[${BTN_MARKER}]`)) return
  const btn = document.createElement('button')
  btn.setAttribute(BTN_MARKER, '1')
  btn.textContent = label
  btn.style.cssText =
    'margin-top:16px;padding:10px 18px;border-radius:8px;border:1px solid rgba(77,107,254,.5);' +
    'background:rgba(77,107,254,.18);color:#8ea0ff;font-size:14px;cursor:pointer;'
  btn.onclick = (): void => {
    btn.textContent = '重试中…'
    btn.disabled = true
    void ipcRenderer.invoke('recovery:restart').catch(() => {
      btn.textContent = label
      btn.disabled = false
    })
  }
  card.appendChild(btn)
}

function watchForErrorCard(): void {
  let running = false
  let pending = false
  let lastRun = 0
  // 节流（leading + trailing，500ms）：大 DOM 上每次变更都全量 textContent 扫描开销大，
  // 但纯 leading 节流会漏掉「静默期后不再有变更」的最后一次插入，必须带尾随补偿
  const SCAN_INTERVAL = 500
  const scan = (): void => {
    if (running) {
      pending = true
      return
    }
    const wait = Math.max(0, SCAN_INTERVAL - (Date.now() - lastRun))
    if (wait > 0) {
      if (!pending) {
        pending = true
        setTimeout(() => {
          pending = false
          scan()
        }, wait)
      }
      return
    }
    running = true
    requestAnimationFrame(() => {
      lastRun = Date.now()
      try {
        doScan()
      } catch {
        /* 忽略 DOM 扫描异常 */
      }
      running = false
      if (pending) {
        pending = false
        scan()
      }
    })
  }
  const doScan = (): void => {
    const root = document.body ?? document.documentElement
    const text = root?.textContent ?? ''
    for (const page of ERROR_PAGES) {
      if (!text.includes(page.match)) continue
      // 找包含该文案的叶子元素，取其卡片容器注入按钮
      const all = root!.querySelectorAll('*')
      for (const el of Array.from(all)) {
        if (el.children.length > 0) continue
        if (!(el.textContent ?? '').includes(page.match)) continue
        const card = el.closest('[class*="card" i], [class*="error" i], main, article') ?? el.parentElement ?? el
        injectRestartButton(card, page.label)
        return
      }
    }
  }
  const mo = new MutationObserver(scan)
  const start = (): void => {
    scan()
    try {
      mo.observe(document.body ?? document.documentElement, { childList: true, subtree: true })
    } catch {
      /* 忽略 observe 失败 */
    }
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
}

// 只暴露「重启」：卸载通道（recovery:uninstallRetry）不再从此处暴露——
// dsh Web UI 属可被插件扩展的内容，主进程侧另有恢复清单白名单双重把关
contextBridge.exposeInMainWorld(RECOVERY_KEY, {
  restartHarness: () => ipcRenderer.invoke('recovery:restart')
})

watchForErrorCard()
