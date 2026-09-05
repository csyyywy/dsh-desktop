// electron-builder afterPack 钩子：从打包产物（win-unpacked）中删除本应用用不到的
// Electron 发行组件。
// - dxcompiler.dll / dxil.dll：WebGPU 着色器编译器（合计约 27MB）。dsh Web UI 为常规
//   React 页面，不使用 WebGPU；缺失时 Chromium 仅禁用 WebGPU 特性，常规渲染不受影响。
//   软件渲染回退（vk_swiftshader / vulkan-1）保留，无 GPU 驱动的机器仍可运行。
// - LICENSES.chromium.html 保留（许可合规考量）。
const { existsSync, rmSync, statSync } = require('node:fs')
const { join } = require('node:path')

const REMOVABLE = ['dxcompiler.dll', 'dxil.dll']

exports.default = function afterPack(context) {
  const dir = context.appOutDir
  let freed = 0
  for (const name of REMOVABLE) {
    const p = join(dir, name)
    if (!existsSync(p)) continue
    try {
      freed += statSync(p).size
      rmSync(p)
      console.log(`[after-pack] 已删除 ${name}`)
    } catch (e) {
      console.warn(`[after-pack] 删除 ${name} 失败（忽略）: ${e.message}`)
    }
  }
  if (freed > 0) {
    console.log(`[after-pack] 共释放 ${(freed / 1024 / 1024).toFixed(1)} MB`)
  }
}
