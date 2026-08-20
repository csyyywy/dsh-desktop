// 共享主题常量（2.2 拆分时抽出）：背景预设被 Dashboard / Splash / SettingsPanel 共用

export const FALLBACK_BG =
  'radial-gradient(140% 140% at 10% -10%, #1b2547 0%, #0b1020 55%, #0a0d18 100%)'

export const BG_PRESETS: { name: string; value: string }[] = [
  { name: '深空蓝', value: FALLBACK_BG },
  { name: '极光', value: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { name: '紫夜', value: 'radial-gradient(120% 120% at 50% 0%, #2a1a4a 0%, #0b1020 62%)' },
  { name: '深海', value: 'linear-gradient(160deg, #0a192f 0%, #112240 55%, #0b1020 100%)' },
  { name: '暮色', value: 'linear-gradient(160deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)' },
  { name: '纯黑', value: '#0a0a0f' }
]
