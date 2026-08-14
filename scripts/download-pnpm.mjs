// 构建期下载 pnpm 完整包到 resources/pnpm，供插件管理器离线安装/卸载插件。
// pnpm 的 bin/pnpm.cjs 只是 shim，真实入口是 dist/pnpm.mjs（13MB bundle）+ dist/node_modules，
// 因此需要复制整个 package 目录。已存在则跳过。
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '11.21.0'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'pnpm')
const destEntry = join(destDir, 'bin', 'pnpm.cjs')

async function main() {
  if (existsSync(destEntry)) {
    console.log('[download-pnpm] 已存在，跳过：', destDir)
    return
  }
  const tarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`
  console.log('[download-pnpm] 下载：', tarballUrl)
  const res = await fetch(tarballUrl, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${tarballUrl}`)
  const buf = Buffer.from(await res.arrayBuffer())

  const tmpDir = join(root, 'resources', '.pnpm-extract')
  mkdirSync(tmpDir, { recursive: true })
  writeFileSync(join(tmpDir, 'pnpm.tgz'), buf)

  const r = spawnSync('tar', ['-xzf', 'pnpm.tgz'], { cwd: tmpDir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('tar 解压失败: ' + (r.stderr || r.stdout))

  rmSync(destDir, { recursive: true, force: true })
  renameSync(join(tmpDir, 'package'), destDir)
  rmSync(tmpDir, { recursive: true, force: true })
  console.log('[download-pnpm] 完成：', destDir)
}

main().catch((e) => {
  console.error('[download-pnpm] 失败：', e.message)
  process.exit(1)
})
