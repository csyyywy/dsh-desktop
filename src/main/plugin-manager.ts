// 插件管理器：查看已装插件、浏览/搜索官方仓库（npm 关键字 dsh-plugin）、一键安装/卸载。
// 安装直接调用 pnpm（node 跑 pnpm.cjs，cwd=profile 目录），再维护 dsh.profile.bundles。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRuntime } from './dsh-manager'
import { dataDir, dshHome, loadSettings } from './settings'
import { pushLog } from './log'
import { curlJson } from './net'
import type { PluginInfo, PluginOpResult } from '../shared/types'

const PROFILE = 'web'

function profileDir(): string {
  return join(dshHome(), 'profiles', PROFILE)
}

function pnpmCjsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
    : join(app.getAppPath(), 'resources', 'pnpm', 'bin', 'pnpm.cjs')
}

function runPnpm(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const rt = resolveRuntime()
    const dir = profileDir()
    if (!existsSync(join(dir, 'package.json'))) {
      resolve({ code: 1, output: '配置目录尚未初始化，请先启动一次服务' })
      return
    }
    pushLog(`$ pnpm ${args.join(' ')}`)
    const child = spawn(rt.node, [pnpmCjsPath(), ...args], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const emit = (b: Buffer): void => {
      const t = b.toString()
      out += t
      pushLog(t)
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    child.on('error', (e) => resolve({ code: 1, output: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, output: out }))
  })
}

/** 某包是否声明了 dsh.bundle（即是一个可激活的 profile 层） */
function isBundle(dir: string, name: string): boolean {
  try {
    const pkgPath = join(dir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) return false
    return JSON.parse(readFileSync(pkgPath, 'utf8')).dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

function reconcileBundles(dir: string, added: string[], removed: string[]): void {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bundles: string[] = [...(pkg.dsh?.profile?.bundles ?? [])]
  let changed = false
  for (const name of added) {
    if (isBundle(dir, name) && !bundles.includes(name)) {
      bundles.push(name)
      changed = true
    }
  }
  for (const name of removed) {
    const i = bundles.indexOf(name)
    if (i !== -1) {
      bundles.splice(i, 1)
      changed = true
    }
  }
  if (changed) {
    pkg.dsh = { ...pkg.dsh, profile: { ...pkg.dsh?.profile, bundles } }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  }
}

function backupsDir(): string {
  return join(dataDir(), 'backups', 'plugins')
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function pruneBackups(): void {
  const dir = backupsDir()
  if (!existsSync(dir)) return
  const backups = readdirSync(dir).sort().reverse()
  while (backups.length > 10) {
    rmSync(join(dir, backups.pop() as string), { recursive: true, force: true })
  }
}

/** 安装/卸载前把整个 profile 目录快照到 backups/plugins/<时间戳> */
function backupProfile(): void {
  const dir = profileDir()
  if (!existsSync(join(dir, 'package.json'))) return
  const name = timestamp()
  const dest = join(backupsDir(), name)
  mkdirSync(dest, { recursive: true })
  try {
    cpSync(dir, dest, { recursive: true })
  } catch (e) {
    pushLog('备份 profile 失败: ' + (e as Error).message)
  }
  pruneBackups()
}

export function listBackups(): string[] {
  const dir = backupsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().reverse()
}

export function restoreBackup(name: string): PluginOpResult {
  const src = join(backupsDir(), name)
  const dir = profileDir()
  if (!existsSync(src)) return { ok: false, message: '备份不存在' }
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    cpSync(src, dir, { recursive: true })
  } catch (e) {
    return { ok: false, message: '回退失败: ' + (e as Error).message }
  }
  return { ok: true, message: `已回退到 ${name}` }
}

export function listInstalledRepos(): Set<string> {
  const pkgPath = join(profileDir(), 'package.json')
  if (!existsSync(pkgPath)) return new Set()
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    const repos = new Set<string>()
    for (const spec of Object.values(deps)) {
      const m = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(spec)
      if (m) repos.add(m[1].replace(/\.git$/, ''))
    }
    return repos
  } catch {
    return new Set()
  }
}

export async function listInstalledPlugins(): Promise<PluginInfo[]> {
  const pkgPath = join(profileDir(), 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    return Object.entries(deps).map(([name, spec]) => {
      const m = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(spec)
      const repo = m ? m[1].replace(/\.git$/, '') : undefined
      return { name, repo, version: '', description: '', installed: true, stars: 0 }
    })
  } catch {
    return []
  }
}

let searchCache: { key: string; time: number; results: PluginInfo[] } | null = null

async function searchGithub(query: string, sort: string): Promise<PluginInfo[]> {
  const q = (query || '').trim()
  const key = `gh|${q}|${sort}`
  if (searchCache && searchCache.key === key && Date.now() - searchCache.time < 60000) {
    return searchCache.results
  }
  const installedRepos = listInstalledRepos()
  const text = q ? `topic:dsh-plugin ${q}` : 'topic:dsh-plugin'
  const sortParam = sort === 'updated' ? 'updated' : 'stars'
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(text)}&sort=${sortParam}&order=desc&per_page=40`
  const token = loadSettings().githubToken?.trim()
  const headers: Record<string, string> = { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const j = (await curlJson(url, headers)) as { items?: Array<Record<string, unknown>>; message?: string }
    if (!j.items) {
      pushLog('GitHub 搜索失败: ' + (j.message || '无有效响应（可能是 API 限流）'))
      return []
    }
    const results = j.items
      .filter((r) => {
        const name = (r.full_name as string) ?? ''
        if (name === 'deepseek-ai/deepseek-harness') return false // 本体非插件
        const repo = name.split('/')[1] ?? ''
        return !/awesome/i.test(repo) // 目录/列表类仓库
      })
      .map((r) => {
        const fullName = (r.full_name as string) ?? ''
        return {
          name: fullName,
          repo: fullName,
          version: '',
          description: (r.description as string) ?? '',
          installed: installedRepos.has(fullName),
          stars: (r.stargazers_count as number) ?? 0,
          updatedAt: (r.pushed_at as string) ?? '',
          repoUrl: (r.html_url as string) ?? ''
        }
      })
    searchCache = { key, time: Date.now(), results }
    return results
  } catch (e) {
    pushLog('GitHub 搜索失败: ' + (e as Error).message)
    return []
  }
}

async function searchNpm(query: string): Promise<PluginInfo[]> {
  const installed = new Set((await listInstalledPlugins()).map((p) => p.name))
  const q = (query || '').trim()
  const text = q ? `keywords:dsh-plugin ${q}` : 'keywords:dsh-plugin'
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=40`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const j = (await res.json()) as { objects?: Array<{ package: Record<string, unknown> }> }
    return (j.objects ?? []).map((o) => {
      const p = o.package as {
        name?: string
        version?: string
        description?: string
        links?: { npm?: string; repository?: string }
      }
      const repo = (p.links?.repository ?? '')
        .replace(/^git\+/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/\.git$/, '')
      return {
        name: p.name ?? '',
        version: p.version ?? '',
        description: p.description ?? '',
        installed: installed.has(p.name ?? ''),
        stars: 0,
        repoUrl: repo || (p.links?.npm ?? '')
      }
    })
  } catch {
    return []
  }
}

export async function searchPlugins(query: string, sort: string = 'stars', source: string = 'github'): Promise<PluginInfo[]> {
  if (source === 'npm') return searchNpm(query)
  return searchGithub(query, sort)
}

function findNpmNameByRepo(repo: string): string | null {
  const pkgPath = join(profileDir(), 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    for (const [name, spec] of Object.entries(deps)) {
      if (spec.includes(repo)) return name
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 从 GitHub 仓库预取 package.json 的 name（npm 包名） */
async function fetchRepoNpmName(repo: string): Promise<string | null> {
  for (const branch of ['HEAD', 'main', 'master']) {
    try {
      const pkg = (await curlJson(`https://raw.githubusercontent.com/${repo}/${branch}/package.json`)) as {
        name?: string
      }
      if (pkg?.name) return pkg.name
    } catch {
      /* continue */
    }
  }
  return null
}

/** 精准放行某个包的构建脚本（写入 profile 的 pnpm.onlyBuiltDependencies） */
function allowBuild(pkgName: string): void {
  const pkgPath = join(profileDir(), 'package.json')
  if (!existsSync(pkgPath)) return
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const list: string[] = [...(pkg.pnpm?.onlyBuiltDependencies ?? [])]
    if (!list.includes(pkgName)) {
      list.push(pkgName)
      pkg.pnpm = { ...(pkg.pnpm ?? {}), onlyBuiltDependencies: list }
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    }
  } catch (e) {
    pushLog('放行构建脚本失败: ' + pkgName + ' ' + (e as Error).message)
  }
}

export async function installPlugin(spec: string, source: string = 'github'): Promise<PluginOpResult> {
  searchCache = null
  backupProfile()
  let pnpmSpec: string
  let npmName: string | null = null
  if (source === 'npm') {
    pnpmSpec = spec
    npmName = spec
  } else {
    // 从 git 地址或仓库名提取 owner/repo，规范化安装地址
    const repo = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(spec)?.[1]?.replace(/\.git$/, '') ?? spec
    pnpmSpec = /^git\+/.test(spec)
      ? spec
      : /^https?:\/\/github\.com\//.test(spec)
        ? `git+${spec}`
        : /^(https?|git):\/\//.test(spec)
          ? spec
          : `git+https://github.com/${repo}`
    // 预取 npm 包名，精准放行其构建脚本（pnpm 默认拦截 git 依赖的 prepare 脚本）
    npmName = await fetchRepoNpmName(repo)
    if (npmName) allowBuild(npmName)
  }
  const { code, output } = await runPnpm(['add', pnpmSpec])
  if (code !== 0) {
    const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: last || `安装失败 (exit ${code})` }
  }
  const resolved = findNpmNameByRepo(spec) ?? npmName ?? spec
  reconcileBundles(profileDir(), [resolved], [])
  return { ok: true, message: `已安装 ${spec}` }
}

export async function uninstallPlugin(name: string): Promise<PluginOpResult> {
  searchCache = null
  backupProfile()
  const { code, output } = await runPnpm(['remove', name])
  if (code !== 0) {
    const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: last || `卸载失败 (exit ${code})` }
  }
  reconcileBundles(profileDir(), [], [name])
  return { ok: true, message: `已卸载 ${name}` }
}
