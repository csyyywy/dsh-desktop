// 恢复 electron 二进制到 node_modules/electron/dist（完整解压）。
// 当 `npm install` 的 electron postinstall 下载失败（Node fetch 走自定义 CA 代理
// 会 TLS 校验失败）时，electron 的 dist 可能缺失/不完整，导致运行时沙箱渲染器
// 崩掉（"Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null"）。
// 本脚本用系统 curl 下载（走系统证书库）+ 7z 完整解压（PowerShell Expand-Archive 会漏文件）。
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronPkg = join(root, 'node_modules', 'electron', 'package.json')
const distDir = join(root, 'node_modules', 'electron', 'dist')

// electron 完整的关键哨兵文件：任一缺失即视为不完整
const REQUIRED = ['electron.exe', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']

function isComplete() {
  return REQUIRED.every((f) => existsSync(join(distDir, f)))
}

function main() {
  if (!existsSync(electronPkg)) {
    console.error('[restore-electron] 未找到 node_modules/electron，请先 npm install')
    process.exit(1)
  }
  if (isComplete()) {
    console.log('[restore-electron] electron 二进制完整，跳过')
    return
  }
  const version = JSON.parse(readFileSync(electronPkg, 'utf8')).version
  const url = process.env.ELECTRON_MIRROR_URL || `https://npmmirror.com/mirrors/electron/${version}/electron-v${version}-win32-x64.zip`
  const zipPath = join(root, '.tmp-electron.zip')

  console.log('[restore-electron] 下载：', url)
  const dl = spawnSync('curl', ['-sSL', '--max-time', '180', '-o', zipPath, url], { stdio: 'inherit' })
  if (dl.status !== 0) {
    console.error('[restore-electron] 下载失败')
    rmSync(zipPath, { force: true })
    process.exit(1)
  }

  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(distDir, { recursive: true })

  // 优先 7z（electron-builder 依赖自带），回退系统 unzip
  const sevenZip = join(root, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe')
  let ext
  if (existsSync(sevenZip)) {
    ext = spawnSync(sevenZip, ['x', zipPath, `-o${distDir}`, '-y', '-bso0', '-bsp0'], { stdio: 'inherit' })
  } else {
    ext = spawnSync('unzip', ['-o', zipPath, '-d', distDir], { stdio: 'inherit' })
  }
  rmSync(zipPath, { force: true })

  if (ext.status !== 0 || !isComplete()) {
    console.error('[restore-electron] 解压失败或不完整，请检查关键文件')
    process.exit(1)
  }
  console.log('[restore-electron] 完成')
}

main()
