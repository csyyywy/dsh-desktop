// 构建期下载官方便携 Node（Windows x64）到 resources/node，使绿色版「解压即用」。
// 已存在则跳过。Node 版本固定为 22.x（满足 dsh 的 engines ^22.19 || >=24）。
import { existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const NODE_VERSION = 'v22.21.1'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'node')
const nodeExe = join(destDir, 'node.exe')
// WSL 后端（v0.2.0）：Linux x64 tar.xz 原样存放（不提前解压），
// 部署时由发行版内 tar 解压以保留可执行权限位。
const linuxTar = join(root, 'resources', 'node-linux.tar.xz')

// 允许用环境变量覆盖版本/镜像。
// 国内加速：DSH_NODE_MIRROR=https://npmmirror.com/mirrors/node/v22.21.1（或任意 nodejs.org/dist 镜像）
const version = process.env.DSH_NODE_VERSION || NODE_VERSION
const baseUrl = process.env.DSH_NODE_MIRROR || `https://nodejs.org/dist/${version}`

function extractZip(zipPath, outDir) {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`
    ],
    { encoding: 'utf8' }
  )
  if (ps.status !== 0) {
    throw new Error('解压失败: ' + (ps.stderr || ps.stdout || '').trim())
  }
}

async function main() {
  if (existsSync(nodeExe)) {
    console.log('[download-node] 已存在，跳过：', nodeExe)
  } else {
    const url = `${baseUrl}/node-${version}-win-x64.zip`
    console.log('[download-node] 下载：', url)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())

    mkdirSync(destDir, { recursive: true })
    const zipPath = join(destDir, 'node.zip')
    const tmpDir = join(destDir, '.extract')
    writeFileSync(zipPath, buf)

    mkdirSync(tmpDir, { recursive: true })
    extractZip(zipPath, tmpDir)

    const inner = join(tmpDir, `node-${version}-win-x64`)
    for (const f of readdirSync(inner)) {
      renameSync(join(inner, f), join(destDir, f))
    }
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })
    console.log('[download-node] 完成：', destDir)
  }

  // Linux x64（WSL 后端）：tar.xz 原样存 resources/node-linux.tar.xz
  if (process.env.DSH_SKIP_NODE_LINUX === '1') {
    console.log('[download-node] DSH_SKIP_NODE_LINUX=1，跳过 Linux 版')
  } else if (existsSync(linuxTar)) {
    console.log('[download-node] Linux 版已存在，跳过：', linuxTar)
  } else {
    const url = `${baseUrl}/node-${version}-linux-x64.tar.xz`
    console.log('[download-node] 下载 Linux 版（WSL 后端）：', url)
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
    writeFileSync(linuxTar, Buffer.from(await res.arrayBuffer()))
    console.log('[download-node] 完成：', linuxTar)
  }
}

main().catch((e) => {
  console.error('[download-node] 失败：', e.message)
  process.exit(1)
})
