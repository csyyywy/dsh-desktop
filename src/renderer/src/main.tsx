import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 2.3：未处理 Promise 拒绝的全局兜底，避免静默失败无迹可查
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  console.error('[unhandledrejection]', r instanceof Error ? r.message : r)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
