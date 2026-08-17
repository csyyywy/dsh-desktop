// 构建期下载 pnpm 完整包到 resources/pnpm，供插件管理器离线安装/卸载插件。
// pnpm 的 bin/pnpm.cjs 只是 shim，真实入口是 dist/pnpm.mjs（13MB bundle）+ dist/node_modules，
// 因此需要复制整个 package 目录。已存在则跳过。
// 下载统一走系统 curl：Node 的 fetch 在带自定义 CA 的代理环境下会 TLS 校验失败。
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '11.21.0'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'pnpm')
const destEntry = join(destDir, 'bin', 'pnpm.cjs')

function curlDownload(url, outPath, label = '文件') {
  console.log(`[download-pnpm] 下载 ${label}:`, url)
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
  console.log(`[download-pnpm] ${label} 完成: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
}

async function main() {
  if (existsSync(destEntry)) {
    console.log('[download-pnpm] 已存在，跳过：', destDir)
    return
  }
  const tarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`

  const tmpDir = join(root, 'resources', '.pnpm-extract')
  mkdirSync(tmpDir, { recursive: true })
  const tgzPath = join(tmpDir, 'pnpm.tgz')

  curlDownload(tarballUrl, tgzPath, 'pnpm tarball')

  const r = spawnSync('tar', ['-xzf', 'pnpm.tgz'], { cwd: tmpDir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('tar 解压失败: ' + (r.stderr || r.stdout))

  rmSync(destDir, { recursive: true, force: true })
  renameSync(join(tmpDir, 'package'), destDir)
  rmSync(tmpDir, { recursive: true, force: true })

  if (!existsSync(destEntry)) {
    throw new Error(`解压后 pnpm 入口不存在: ${destEntry}`)
  }
  console.log('[download-pnpm] 完成：', destDir)
}

main().catch((e) => {
  console.error('[download-pnpm] 失败：', e.message)
  process.exit(1)
})
