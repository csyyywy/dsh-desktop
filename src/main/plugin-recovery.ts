// 启动失败恢复编排（v0.3.0，移植 dataelement/dsh-desktop v0.4.0 #94/#96/#98 思路，MIT）。
// 纯检测见 plugin-recovery-detection.ts；本文件负责：
//  - 把「loader 条目 id / 插槽冲突名」按 profile bundle 顺序映射回真实 npm 包（#98）；
//  - 要求候选包同时存在于 profile dependencies 与 bundles 才提供卸载入口；
//  - 汇总成 PluginRecoveryInfo 交给 index.ts 塞进 AppStatus.recovery，供恢复界面渲染。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from './wsl'
import { readProfilePkg } from './plugin-manager'
import { pushLog } from './log'
import {
  extractDuplicateLoaderEntryId,
  extractFailureCause,
  extractOffendingPlugins,
  extractSlotConflictName,
  isPackageReference
} from './plugin-recovery-detection'
import type { PluginRecoveryInfo, PluginRecoveryTarget } from '../shared/types'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readInstalledPkgJson(dir: string, name: string): Record<string, unknown> | null {
  const pkgPath = join(dir, 'node_modules', name, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 某个已装 bundle 包内可扫描的 patch 文件列表（由 dsh.bundle.patch 声明 + 常见默认名） */
function resolvePatchFiles(dir: string, name: string): string[] {
  const files: string[] = []
  const pkg = readInstalledPkgJson(dir, name)
  const p = (pkg as { dsh?: { bundle?: { patch?: unknown } } } | undefined)?.dsh?.bundle?.patch
  const candidates: string[] = []
  if (typeof p === 'string') candidates.push(p)
  else if (Array.isArray(p)) for (const x of p) if (typeof x === 'string') candidates.push(x)
  else if (p && typeof p === 'object') for (const v of Object.values(p)) if (typeof v === 'string') candidates.push(v)
  const base = join(dir, 'node_modules', name)
  for (const c of candidates) {
    // 只接受相对路径的配置文件，拒绝绝对路径（防读到包外文件）
    if (/\.(ya?ml|json|js|cjs|ts)$/i.test(c) && !/^[A-Za-z]:[\\/]/.test(c) && !c.startsWith('/')) {
      const f = join(base, c)
      if (existsSync(f)) files.push(f)
    }
  }
  for (const def of ['cordis.patch.yml', 'cordis.patch.yaml', 'patch.yml', 'patch.yaml']) {
    const f = join(base, def)
    if (existsSync(f)) files.push(f)
  }
  return files
}

/** profile package.json 的 dsh.profile.bundles（安装序） */
function profileBundlesInOrder(): string[] {
  const pkg = readProfilePkg()
  const b = (pkg as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles
  return Array.isArray(b) ? (b as string[]) : []
}

function isInProfileDeps(name: string): boolean {
  const pkg = readProfilePkg()
  const deps = (pkg as { dependencies?: Record<string, unknown> } | null)?.dependencies ?? {}
  return Object.prototype.hasOwnProperty.call(deps, name)
}

/** 在 profile bundle 中（按序）找声明了 <entryId> 的包（读 patch 文件内容，词边界匹配） */
function findBundleOwnerForEntry(entryId: string, bundles: string[]): string | null {
  const dir = profileDir()
  const re = new RegExp(`[\\"'\\s:=/(]${escapeRegExp(entryId)}(?=[\\"'\\s,}\\]:/]|$)`, 'i')
  for (const name of bundles) {
    for (const f of resolvePatchFiles(dir, name)) {
      try {
        const text = readFileSync(f, 'utf8')
        if (re.test(text)) return name
      } catch {
        /* 单个文件读取失败忽略 */
      }
    }
  }
  return null
}

/** 汇总可恢复目标：日志直指 + loader 条目映射 + 插槽/路由映射（#94/#96/#98） */
export async function resolveRecoveryPlugins(stderrLines: readonly string[]): Promise<PluginRecoveryTarget[]> {
  const targets: PluginRecoveryTarget[] = []
  const seen = new Set<string>()
  const add = (t: PluginRecoveryTarget): void => {
    if (t.name) {
      if (seen.has(t.name)) return
      seen.add(t.name)
    }
    targets.push(t)
  }

  // 1) 日志直接指认的可操作第三方插件（#98 原则：仅在确属已装依赖时提供卸载，否则不误导）
  for (const ref of extractOffendingPlugins(stderrLines)) {
    if (isInProfileDeps(ref)) {
      add({ name: ref, displayName: ref, reason: '启动日志直接指认该插件加载失败/冲突' })
    } else {
      add({ name: null, displayName: ref, reason: '启动日志提及，但不在已安装依赖中，无法直接卸载' })
    }
  }

  // 2) 重复 loader 条目 → 映射回真实包（#98）；内部标识不提供误导性卸载入口
  const dupId = extractDuplicateLoaderEntryId(stderrLines)
  if (dupId) {
    if (isPackageReference(dupId)) {
      add({ name: dupId, displayName: dupId, reason: `重复注册 loader 条目「${dupId}」` })
    } else {
      const owner = findBundleOwnerForEntry(dupId, profileBundlesInOrder())
      if (owner && isInProfileDeps(owner)) {
        add({ name: owner, displayName: `${owner}（loader 条目: ${dupId}）`, reason: `重复注册 loader 条目「${dupId}」，由该包引入` })
      } else if (!dupId.includes(':')) {
        pushLog(`恢复: loader 条目「${dupId}」无法映射到已装插件，跳过卸载建议`)
      }
    }
  }

  // 3) 插槽/路由冲突 → 映射回真实包（尽力而为）
  const slot = extractSlotConflictName(stderrLines)
  if (slot) {
    const owner = findBundleOwnerForEntry(slot, profileBundlesInOrder())
    if (owner && isInProfileDeps(owner)) {
      add({ name: owner, displayName: `${owner}（插槽: ${slot}）`, reason: `插槽/路由「${slot}」重复注册，由该包引入` })
    }
  }

  return targets
}

/** 启动失败 → 恢复信息（供 AppStatus.recovery） */
export async function detectPluginRecovery(stderrLines: readonly string[]): Promise<PluginRecoveryInfo> {
  const cause = extractFailureCause(stderrLines)
  const offending = await resolveRecoveryPlugins(stderrLines)
  return {
    offending,
    message: cause || (offending.length > 0 ? 'dsh 启动失败（插件冲突）' : 'dsh 启动失败，详见日志'),
    canReset: true
  }
}
