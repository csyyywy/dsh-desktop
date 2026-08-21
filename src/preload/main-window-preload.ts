// 主窗口专用 preload（v0.3.0，移植 dataelement/dsh-desktop v0.4.0 #94/#96 思路，MIT）。
// 只暴露最小恢复 API（window.__dshRecovery），不把完整 window.dsh 暴露给 dsh Web UI。
// 作用：检测 dsh Web UI 的全屏「Failed to load plugins」错误卡，注入「重启 Harness」按钮，
// 点击后经主进程清理/重启并刷新页面——避免用户卡死在错误页。
// tsconfig.node.json 的 lib 是 ES2023（无 DOM），此处需要 DOM 类型
/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron'

const RECOVERY_KEY = '__dshRecovery'
const BTN_MARKER = 'data-dsh-recovery'

function injectRestartButton(card: Element): void {
  if (card.querySelector(`[${BTN_MARKER}]`)) return
  const btn = document.createElement('button')
  btn.setAttribute(BTN_MARKER, '1')
  btn.textContent = '重启 Harness'
  btn.style.cssText =
    'margin-top:16px;padding:10px 18px;border-radius:8px;border:1px solid rgba(77,107,254,.5);' +
    'background:rgba(77,107,254,.18);color:#8ea0ff;font-size:14px;cursor:pointer;'
  btn.onclick = (): void => {
    btn.textContent = '重启中…'
    btn.disabled = true
    void ipcRenderer.invoke('recovery:restart').catch(() => {
      btn.textContent = '重启 Harness'
      btn.disabled = false
    })
  }
  card.appendChild(btn)
}

function watchForErrorCard(): void {
  let scanning = false
  const scan = (): void => {
    if (scanning) return
    scanning = true
    requestAnimationFrame(() => {
      scanning = false
      try {
        const root = document.body ?? document.documentElement
        if (!root || !(root.textContent ?? '').includes('Failed to load plugins')) return
        // 找包含该文案的叶子元素，取其卡片容器注入按钮
        const all = root.querySelectorAll('*')
        for (const el of Array.from(all)) {
          if (el.children.length > 0) continue
          if (!/Failed to load plugins/i.test(el.textContent ?? '')) continue
          const card = el.closest('[class*="card" i], [class*="error" i], main, article') ?? el.parentElement ?? el
          injectRestartButton(card)
          break
        }
      } catch {
        /* 忽略 DOM 扫描异常 */
      }
    })
  }
  const mo = new MutationObserver(scan)
  const start = (): void => {
    scan()
    try {
      mo.observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true })
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
