// 构建期把 dsh 本体（@deepseek-ai/dsh + 依赖树）预装到 resources/dsh-bundle，
// 打包进应用后，首次启动直接复制到 data/，无需联网安装。已存在则跳过。
//
// v0.2.3 提速改造（用户要求）：
// - 主路径改用内置 pnpm（resources/pnpm）而非 npm：
//   * worker 并发下载，冷装明显快于 npm；
//   * 内容寻址 store（node_modules/.dsh-pnpm-store）持久化——store 一经加热，
//     重跑 / 换版本只下载增量，秒级完成。
// - 必须 --config.node-linker=hoisted：pnpm 默认 isolated 布局会在 node_modules
//   里用 symlink 指向 .pnpm/，restoreBundledDsh 的 cpSync 不会解引用，复制后必坏。
//   hoisted 得到与 npm 一致的扁平 node_modules，可直接整目录复制。
// - --ignore-scripts：dsh 依赖树里带构建脚本的包全部可安全跳过（本机实测：
//   koffi 预编译在 @koromix/koffi-win32-x64 optional dep、node-pty 自带 prebuilds、
//   @deepseek-ai/dsh-subprocess-local 的 postinstall 仅 chmod 可执行位（Windows
//   无意义）、@google/genai 与 protobufjs 纯 JS）。跳过构建脚本同时规避了
//   pnpm 11 的构建拦截审批，以及 koffi cnoke 在网络上挂起的问题（实测）。
// - 构建完成后校验 koffi/node-pty 可加载 + dsh --version 可运行。
// - pnpm 失败回退 npm（原逻辑），不阻断构建。
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'dsh-bundle')
const version = process.env.DSH_BUNDLE_VERSION || 'latest'
const nodeExe = join(root, 'resources', 'node', 'node.exe')
const pnpmCjs = join(root, 'resources', 'pnpm', 'bin', 'pnpm.cjs')
// 持久 store：放 node_modules 下（gitignore、不打进应用、跨构建复用）
const storeDir = join(root, 'node_modules', '.dsh-pnpm-store')

/** 构建后快速校验：原生模块可加载 + dsh 可运行（发现坏 bundle 就在构建期报出来） */
function verifyBundle(dir) {
  const nm = join(dir, 'node_modules')
  const run = (args) => {
    const r = spawnSync(nodeExe, args, { cwd: dir, encoding: 'utf8' })
    return r.status === 0 ? (r.stdout || '').trim() : null
  }
  const koffi = run(['-e', "try{require('koffi');process.stdout.write('ok')}catch(e){process.exit(1)}"])
  const pty = run(['-e', "try{const p=require('node-pty');process.stdout.write(typeof p.spawn==='function'?'ok':'bad')}catch(e){process.exit(1)}"])
  const dshVer = run([join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'])
  const ok = koffi === 'ok' && pty === 'ok' && dshVer
  console.log(`[bundle-dsh] 校验：koffi=${koffi === 'ok' ? 'OK' : 'FAIL'} node-pty=${pty === 'ok' ? 'OK' : 'FAIL'} dsh=${dshVer ?? 'FAIL'}`)
  if (!ok) throw new Error('bundle 校验失败（原生模块未就绪），请勿打包')
}

function main() {
  const binPath = join(destDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(binPath)) {
    console.log('[bundle-dsh] 已存在，跳过：', destDir)
    return
  }
  const target = version === 'latest' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${version}`
  const tmpDir = join(root, 'resources', '.dsh-bundle-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  // pnpm add 需要一个 package.json
  writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'dsh-bundle-tmp', private: true, version: '0.0.0' }, null, 2), 'utf8')

  // 主路径：内置 pnpm（hoisted 布局 + 持久 store + 忽略构建脚本 + 优先离线缓存）
  if (existsSync(nodeExe) && existsSync(pnpmCjs)) {
    console.log('[bundle-dsh] pnpm 安装：', target)
    const pnpmArgs = [
      'add', target,
      '--dir', tmpDir,
      '--config.node-linker=hoisted',
      '--ignore-scripts',
      '--store-dir', storeDir,
      '--prefer-offline',
      '--reporter', 'append-only'
    ]
    const r = spawnSync(nodeExe, [pnpmCjs, ...pnpmArgs], { stdio: 'inherit', encoding: 'utf8' })
    if (r.status === 0 && existsSync(join(tmpDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      finalize(tmpDir, destDir)
      verifyBundle(destDir)
      return
    }
    console.error('[bundle-dsh] pnpm 失败，回退 npm')
  }

  // 回退：npm install（原逻辑）
  console.log('[bundle-dsh] npm 安装：', target)
  const npmCli = join(root, 'resources', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const useBundled = existsSync(nodeExe) && existsSync(npmCli)
  const cmd = useBundled ? nodeExe : 'npm'
  const args = useBundled
    ? [npmCli, 'install', '--prefix', tmpDir, '--no-audit', '--no-fund', target]
    : ['install', '--prefix', tmpDir, '--no-audit', '--no-fund', target]
  const r2 = spawnSync(cmd, args, { stdio: 'inherit', shell: !useBundled && process.platform === 'win32' })
  if (r2.status !== 0) throw new Error('npm install 失败')
  finalize(tmpDir, destDir)
  verifyBundle(destDir)
}

/** 把 tmp 的 node_modules 等搬进 resources/dsh-bundle（构建产物目录） */
function finalize(tmpDir, destDir) {
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const entry of ['node_modules', 'package.json', 'package-lock.json', 'pnpm-lock.yaml']) {
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
