// 构建期下载官方便携 Node（Windows x64）到 resources/node，使绿色版「解压即用」。
// 已存在则跳过。Node 版本固定为 22.x（满足 dsh 的 engines ^22.19 || >=24）。
// 下载统一走系统 curl：Node 的 fetch 在带自定义 CA 的代理环境下会 TLS 校验失败。
import { existsSync, mkdirSync, writeFileSync, readdirSync, renameSync, rmSync, statSync, readFileSync, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
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

function curlDownload(url, outPath, label = '文件') {
  console.log(`[download-node] 下载 ${label}:`, url)
  const ps = spawnSync(
    'curl',
    ['-sSL', '--max-time', '300', '-o', outPath, url],
    { encoding: 'utf8' }
  )
  if (ps.status !== 0) {
    throw new Error(`${label} 下载失败 (curl exit ${ps.status}): ` + (ps.stderr || ps.stdout || '').trim())
  }
  if (!existsSync(outPath)) {
    throw new Error(`${label} 下载后文件不存在: ${outPath}`)
  }
  const size = statSync(outPath).size
  if (size === 0) {
    throw new Error(`${label} 下载结果为空: ${outPath}`)
  }
  console.log(`[download-node] ${label} 完成: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

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

/** 供应链校验：对照官方 SHASUMS256.txt 验证下载产物（清单拉不到则告警跳过，不匹配即致命） */
async function verifyAgainstShasums(baseUrl, fileName, filePath, label) {
  const listPath = filePath + '.sha256'
  try {
    curlDownload(`${baseUrl}/SHASUMS256.txt`, listPath, `${label} 校验清单`)
  } catch (e) {
    console.warn(`[download-node] 警告：无法获取 SHASUMS256.txt，跳过 ${fileName} 校验（${e.message}）`)
    return
  }
  let expected = null
  try {
    const text = readFileSync(listPath, 'utf8')
    const line = text.split(/\r?\n/).find((l) => l.trimEnd().endsWith('  ' + fileName))
    if (line) expected = line.trim().split(/\s+/)[0].toLowerCase()
  } finally {
    rmSync(listPath, { force: true })
  }
  if (!expected) throw new Error(`SHASUMS256.txt 中找不到 ${fileName}，拒绝使用下载产物`)
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    throw new Error(`${fileName} SHA256 不匹配！期望 ${expected}，实际 ${actual}（下载可能被篡改，已中止）`)
  }
  console.log(`[download-node] ${fileName} SHA256 校验通过`)
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = createReadStream(path)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

async function main() {
  if (existsSync(nodeExe)) {
    console.log('[download-node] 已存在，跳过：', nodeExe)
  } else {
    const url = `${baseUrl}/node-${version}-win-x64.zip`
    mkdirSync(destDir, { recursive: true })
    const zipPath = join(destDir, 'node.zip')
    const tmpDir = join(destDir, '.extract')

    curlDownload(url, zipPath, 'Windows x64 Node')
    await verifyAgainstShasums(baseUrl, `node-${version}-win-x64.zip`, zipPath, 'Windows x64 Node')

    mkdirSync(tmpDir, { recursive: true })
    extractZip(zipPath, tmpDir)

    const inner = join(tmpDir, `node-${version}-win-x64`)
    for (const f of readdirSync(inner)) {
      renameSync(join(inner, f), join(destDir, f))
    }
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(zipPath, { force: true })

    if (!existsSync(nodeExe)) {
      throw new Error(`解压后 node.exe 不存在: ${nodeExe}`)
    }
    console.log('[download-node] 完成：', destDir)
  }

  // Linux x64（WSL 后端）：tar.xz 原样存 resources/node-linux.tar.xz
  if (process.env.DSH_SKIP_NODE_LINUX === '1') {
    console.log('[download-node] DSH_SKIP_NODE_LINUX=1，跳过 Linux 版')
  } else if (existsSync(linuxTar)) {
    console.log('[download-node] Linux 版已存在，跳过：', linuxTar)
  } else {
    const url = `${baseUrl}/node-${version}-linux-x64.tar.xz`
    curlDownload(url, linuxTar, 'Linux x64 Node')
    await verifyAgainstShasums(baseUrl, `node-${version}-linux-x64.tar.xz`, linuxTar, 'Linux x64 Node')
  }
}

main().catch((e) => {
  console.error('[download-node] 失败：', e.message)
  process.exit(1)
})
