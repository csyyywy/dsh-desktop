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

// 允许用环境变量覆盖版本/镜像
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
    return
  }
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

main().catch((e) => {
  console.error('[download-node] 失败：', e.message)
  process.exit(1)
})
