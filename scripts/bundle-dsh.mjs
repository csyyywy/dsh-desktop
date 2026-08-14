// 构建期把 dsh 本体（@deepseek-ai/dsh + 依赖树）预装到 resources/dsh-bundle，
// 打包进应用后，首次启动直接复制到 data/，无需联网安装。已存在则跳过。
import { existsSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'dsh-bundle')
const version = process.env.DSH_BUNDLE_VERSION || 'latest'

function main() {
  const binPath = join(destDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(binPath)) {
    console.log('[bundle-dsh] 已存在，跳过：', destDir)
    return
  }
  const tmpDir = join(root, 'resources', '.dsh-bundle-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const target = version === 'latest' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${version}`
  console.log('[bundle-dsh] 安装：', target)
  // 优先用内置 node 直跑 npm-cli.js（无 shell，避免中文路径被 cmd 弄乱）
  const node = join(root, 'resources', 'node', 'node.exe')
  const npmCli = join(root, 'resources', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const useBundled = existsSync(node) && existsSync(npmCli)
  const cmd = useBundled ? node : 'npm'
  const args = useBundled
    ? [npmCli, 'install', '--prefix', tmpDir, '--no-audit', '--no-fund', target]
    : ['install', '--prefix', tmpDir, '--no-audit', '--no-fund', target]
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: !useBundled && process.platform === 'win32' })
  if (r.status !== 0) throw new Error('npm install 失败')

  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const entry of ['node_modules', 'package.json', 'package-lock.json']) {
    const s = join(tmpDir, entry)
    if (existsSync(s)) cpSync(s, join(destDir, entry), { recursive: true })
  }
  rmSync(tmpDir, { recursive: true, force: true })
  console.log('[bundle-dsh] 完成：', destDir)
}

try {
  main()
} catch (e) {
  console.error('[bundle-dsh] 失败：', e.message)
  process.exit(1)
}
