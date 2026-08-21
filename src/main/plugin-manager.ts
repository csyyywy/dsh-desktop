// 插件管理器：查看已装插件、浏览/搜索官方仓库（npm 关键字 dsh-plugin）、一键安装/卸载。
// 安装直接调用 pnpm（node 跑 pnpm.cjs，cwd=profile 目录），再维护 dsh.profile.bundles。
//
// WSL 模式（v0.2.0）双路径形态，严格分离：
//  - profileLinuxDir()：发行版内 Linux 路径，仅供 wsl.exe 命令（pnpm --dir / cp 等）；
//  - profileDir()：返回 UNC 路径（\\wsl.localhost\<distro>\...），仅供 Windows 侧 Node fs
//    读写（package.json / pnpm-workspace.yaml / node_modules 检查）。
// 严禁混用：pnpm 在 WSL 内只认 Linux 路径，Windows 侧 fs 只认 UNC。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveRuntime } from './dsh-manager'
import { loadSettings } from './settings'
import { pushLog } from './log'
import { curlJson } from './net'
import { bashQuote, currentDistro, profileDir, profileLinuxDir, runWslBash, wslNodeBin, wslPnpmCjs } from './wsl'
import { backupProfile } from './backup-manager'
import type { PluginInfo, PluginOpResult, PluginUpdateInfo } from '../shared/types'

const PROFILE = 'web'

// 包名/spec 白名单：实现在 validate-pkg.ts（零依赖，含单测）
import { assertSafeName, assertSafeSpec } from './validate-pkg'

// 插件写操作互斥（1.2）：install/uninstall/update/restore 并发时会同时读写
// 同一 profile（pnpm 竞态 + package.json 读改写丢失更新）。用 promise 链串行化。
let opChain: Promise<unknown> = Promise.resolve()
function withPluginMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn)
  opChain = run.catch(() => undefined)
  return run
}

/** 并发受限的 map（1.6）：git 插件更新检查每插件打 2 个 GitHub API 请求，
 *  无 token 时匿名限额 60 次/小时，全并发必然 403；限并发避免打爆限流。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** profile 目录 / Linux 路径已移入 wsl.ts（供 plugin-manager / backup-manager 共用） */

function pnpmCjsPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pnpm', 'bin', 'pnpm.cjs')
    : join(app.getAppPath(), 'resources', 'pnpm', 'bin', 'pnpm.cjs')
}

/** 运行 pnpm（本机 = node 跑 pnpm.cjs；WSL = 发行版内 node，--dir Linux profile）。
 *  导出供「从本机同步」等流程复用（同步后重建插件依赖）。 */
export async function runPnpm(args: string[]): Promise<{ code: number; output: string }> {
  const dir = profileDir()
  if (!existsSync(join(dir, 'package.json'))) {
    return { code: 1, output: '配置目录尚未初始化，请先启动一次服务' }
  }
  const registry = loadSettings().npmRegistry
  // --registry 只在需要解析包元数据的命令（add/update/install 等）上有意义；
  // pnpm remove 不接受该选项（Unknown option: 'registry'），remove 不访问 registry。
  const noRegistry = args[0] === 'remove' || args[0] === 'rebuild' || args[0] === 'list' || args[0] === 'outdated'
  const fullArgs = registry && !noRegistry ? [...args, '--registry', registry] : args
  if (loadSettings().backend === 'wsl') {
    const node = wslNodeBin()
    const pnpm = wslPnpmCjs()
    const linuxDir = profileLinuxDir()
    if (!node || !pnpm || !linuxDir) return { code: 1, output: 'WSL 后端未部署（缺少 node/pnpm）' }
    pushLog(`$ wsl pnpm ${fullArgs.join(' ')}`)
    // export PATH：lifecycle 脚本（node-pty 等原生构建）需要 node in PATH；
    // 用户参数逐个 bashQuote（双引号形式，wsl.exe 外层包装安全）
    const script = `export PATH=${bashQuote(dirname(node))}:$PATH; ${bashQuote(node)} ${bashQuote(pnpm)} --dir ${bashQuote(linuxDir)} ${fullArgs.map(bashQuote).join(' ')}`
    const res = await runWslBash(script, {
      timeoutMs: 10 * 60 * 1000,
      // 1.5：超时只杀了 wsl.exe 客户端，发行版内 pnpm 会继续跑并占 store/profile 锁；
      // 按 pnpm 可执行路径精确清理（限当前用户）
      onTimeout: () => {
        pushLog('pnpm 执行超时，尝试终止发行版内的 pnpm 进程')
        void runWslBash(`pkill -u $(id -un) -f ${bashQuote(pnpm)} 2>/dev/null`, { silent: true })
      }
    })
    return { code: res.code, output: res.stdout + res.stderr }
  }
  return new Promise((resolve) => {
    const rt = resolveRuntime()
    pushLog(`$ pnpm ${fullArgs.join(' ')}`)
    const child = spawn(rt.node, [pnpmCjsPath(), ...fullArgs], {
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
    // 超时兜底（与 WSL 分支的 10min 对应）：挂死的 pnpm 会卡死整个生命周期串行队列
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve({ code: 1, output: out + '\npnpm 执行超时（15 分钟），已终止' })
    }, 15 * 60 * 1000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, output: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, output: out })
    })
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

/** 已安装包的 node_modules 真实版本（读不到/占位包返回空串） */
function installedVersionOf(name: string): string {
  try {
    const pkgPath = join(profileDir(), 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) return ''
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** profile package.json 里某依赖的 spec（semver 范围或 git+https://...#commit） */
function specOf(name: string): string | null {
  try {
    const pkgPath = join(profileDir(), 'package.json')
    if (!existsSync(pkgPath)) return null
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = (pkg.dependencies ?? {}) as Record<string, string>
    return deps[name] ?? null
  } catch {
    return null
  }
}

function isGitSpec(spec: string): boolean {
  return /^(git\+|git:)/.test(spec)
}

/** git spec 里的锁定 commit（#<sha> 部分），无则 null */
function gitPinnedCommit(spec: string): string | null {
  const i = spec.lastIndexOf('#')
  return i === -1 ? null : spec.slice(i + 1)
}

/** 从 pnpm-lock.yaml 的 importer 段解析 git 依赖当前解析到的 commit（package.json 不写 #sha，只有 lockfile 有） */
function gitResolvedCommit(name: string, spec: string): string | null {
  try {
    const lockPath = join(profileDir(), 'pnpm-lock.yaml')
    if (!existsSync(lockPath)) return null
    const lines = readFileSync(lockPath, 'utf8').split(/\r?\n/)
    const bare = spec.replace(/#[^#]*$/, '')
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s+specifier:\s*(\S+)\s*$/.exec(lines[i])
      if (!m || m[1] !== bare) continue
      const v = /^\s+version:\s*(\S+)\s*$/.exec(lines[i + 1] ?? '')
      const sha = v ? /#([0-9a-f]{40,64})$/.exec(v[1]) : null
      if (sha) return sha[1]
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 简易 semver 比较：a > b（忽略前导 v，逐段数值比较） */
function semverGt(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va !== vb) return va > vb
  }
  return false
}

/** 远端最新可用信息：npm 包 → registry <name>/latest；git 依赖 → 最新 release tag + HEAD commit */
async function latestVersionOf(
  name: string,
  spec: string
): Promise<{ latest: string; short: boolean; commit?: string }> {
  if (isGitSpec(spec)) {
    const repo = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(spec)?.[1]?.replace(/\.git$/, '')
    if (!repo) throw new Error('无法解析 git 仓库地址')
    const headers: Record<string, string> = { 'User-Agent': 'dsh-desktop', Accept: 'application/vnd.github+json' }
    const token = loadSettings().githubToken?.trim()
    if (token) headers.Authorization = `Bearer ${token}`
    const [rel, head] = await Promise.allSettled([
      curlJson(`https://api.github.com/repos/${repo}/releases/latest`, headers),
      curlJson(`https://api.github.com/repos/${repo}/commits/HEAD`, headers),
    ])
    const tag = rel.status === 'fulfilled' ? ((rel.value as { tag_name?: string }).tag_name ?? '').replace(/^v/i, '') : ''
    const sha = head.status === 'fulfilled' ? (head.value as { sha?: string }).sha : undefined
    if (tag) return { latest: tag, short: false, commit: sha }
    if (sha) return { latest: sha.slice(0, 12), short: true, commit: sha }
    throw new Error('GitHub API 无响应（可能限流）')
  }
  const registry = (loadSettings().npmRegistry?.trim() || 'https://registry.npmjs.org').replace(/\/+$/, '')
  // scoped 包名中的 / 需编码为 %2F（registry 元数据端点格式）
  const url = `${registry}/${encodeURIComponent(name)}/latest`
  const j = (await curlJson(url)) as { version?: string; error?: string }
  if (!j.version) throw new Error(j.error || 'registry 无响应')
  return { latest: j.version, short: false }
}

export async function checkPluginUpdates(): Promise<PluginUpdateInfo[]> {
  const installed = await listInstalledPlugins()
  // 1.6：并发 3，避免 N 个 git 插件瞬间打 2N 个 GitHub API 请求触发匿名限流
  const out: PluginUpdateInfo[] = await mapLimit(installed, 3, async (p) => {
      const spec = specOf(p.name)
      if (!spec) return { name: p.name, current: p.version, latest: '', updateAvailable: false, error: '依赖记录缺失' }
      if (spec.startsWith('link:')) {
        // 本地链接依赖（开发用）：不是失败，只是无需检查更新
        return { name: p.name, current: p.version, latest: '', updateAvailable: false, note: '本地链接依赖' }
      }
      try {
        const { latest, short } = await latestVersionOf(p.name, spec)
        // git 依赖优先显示锁定的 commit（node_modules 版本号反映不了 commit 移动）
        const current = isGitSpec(spec)
          ? (gitPinnedCommit(spec) ?? gitResolvedCommit(p.name, spec) ?? p.version)?.slice(0, 12)
          : p.version
        const updateAvailable = short
          ? Boolean(current) && current !== latest
          : Boolean(current) && semverGt(latest, current)
        return { name: p.name, current, latest: short ? latest.slice(0, 12) : latest, updateAvailable }
      } catch (e) {
        return { name: p.name, current: p.version, latest: '', updateAvailable: false, error: (e as Error).message }
      }
    })
  return out
}

export async function updatePlugin(name: string, approvedBuilds?: string[]): Promise<PluginOpResult> {
  assertSafeName(name)
  return withPluginMutex(async () => {
  searchCache = null
  const spec = specOf(name)
  if (!spec) return { ok: false, message: `「${name}」不在依赖列表里，无法更新` }
  if (spec.startsWith('link:')) return { ok: false, message: `「${name}」是本地链接依赖（link:），无需更新` }
  // pnpm 的 `add <name>@latest` 对已是依赖的包会静默 no-op（spec 与版本都不动但退出码 0），
  // 因此必须先解析出精确的最新版本/commit，再显式安装。
  let info: { latest: string; short: boolean; commit?: string }
  try {
    info = await latestVersionOf(name, spec)
  } catch (e) {
    return { ok: false, message: `无法获取「${name}」的最新版本: ${(e as Error).message}` }
  }
  await backupProfile()
  // 构建脚本放行改用户确认（同 installPlugin，默认拒绝）
  let target: string
  if (isGitSpec(spec)) {
    if (!info.commit) return { ok: false, message: `无法获取「${name}」的远端最新 commit` }
    target = `${spec.replace(/#[^#]*$/, '')}#${info.commit}`
  } else {
    target = `${name}@${info.latest}`
  }
  pushLog(`更新插件 ${name}: ${spec} -> ${target}`)
  let result = await runPnpm(['add', target])
  for (let attempt = 0; result.code !== 0 && attempt < 3; attempt++) {
    const ignored = parseIgnoredBuilds(result.output)
    if (ignored.length === 0) break
    const known = approvedBuilds ?? []
    const pending = ignored.filter((p) => !known.includes(p))
    if (!approvedBuilds || pending.length > 0) {
      const all = [...new Set([...known, ...ignored])]
      return {
        ok: false,
        buildApprovals: all,
        message: `以下依赖包含安装期构建脚本（放行 = 允许执行其代码），请确认后重试: ${all.join(', ')}`
      }
    }
    approveBuilds(ignored)
    result = await runPnpm(['add', target])
  }
  const { code, output } = result
  if (code !== 0) {
    const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: last || `更新失败 (exit ${code})` }
  }
  reconcileBundles(profileDir(), [name], [])
  const now = installedVersionOf(name)
  return { ok: true, message: now ? `已更新 ${name} → v${now}` : `已更新 ${name} → ${target}` }
  })
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
      let version = installedVersionOf(name)
      if (!version && isGitSpec(spec)) {
        const commit = gitPinnedCommit(spec)
        version = commit ? commit.slice(0, 12) : 'git'
      }
      return { name, repo, version, description: '', installed: true, stars: 0 }
    })
  } catch {
    return []
  }
}

let searchCache: { key: string; time: number; results: PluginInfo[] } | null = null

/** 相关性打分（0-100）：query 命中 name 精确 > 前缀 > 子串 > keyword > description；完全无关 = 0。
 *  用于搜索后置过滤 + 排序，解决「答非所问」：query 与结果名/关键字/描述毫不相关的一律丢弃。 */
function relevanceOf(name: string, keywords: string[], description: string, q: string): number {
  if (!q) return 1 // 空 query = 浏览全部
  const n = q.toLowerCase()
  const nm = (name || '').toLowerCase()
  const desc = (description || '').toLowerCase()
  if (nm === n) return 100
  if (nm.startsWith(n)) return 85
  if (nm.includes(n)) return 70
  const kw = (keywords || []).some((k) => k.toLowerCase().includes(n))
  if (kw) return 55
  if (desc.includes(n)) return 40
  return 0
}

/** npm search 原生返回（保留 keywords 供相关性打分） */
interface NpmHit extends PluginInfo {
  keywords: string[]
}

async function npmSearch(text: string): Promise<NpmHit[]> {
  const installed = new Set((await listInstalledPlugins()).map((p) => p.name))
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=40`
  try {
    // 走 curlJson（系统 curl），与项目约束一致：Node fetch 在自定义 CA 代理下会 TLS 校验失败
    const j = (await curlJson(url)) as { objects?: Array<{ package: Record<string, unknown> }> }
    return (j.objects ?? []).map((o) => {
      const p = o.package as {
        name?: string
        version?: string
        description?: string
        keywords?: string[]
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
        keywords: p.keywords ?? [],
        repoUrl: repo || (p.links?.npm ?? '')
      }
    })
  } catch {
    return []
  }
}

async function searchNpm(query: string): Promise<PluginInfo[]> {
  const q = (query || '').trim()
  const strict = await npmSearch(`keywords:dsh-plugin${q ? ' ' + q : ''}`)
  let all = strict
  if (q && strict.length < 5) {
    // 严格结果不足：用关键词兜底并集（避免「答非所问」时整体为空）
    const fallback = await npmSearch(`keywords:${q}`)
    const seen = new Set(strict.map((r) => r.name))
    all = [...strict, ...fallback.filter((r) => !seen.has(r.name))]
  }
  return all
    .map((r) => ({ r, score: relevanceOf(r.name, r.keywords, r.description, q) }))
    .filter((x) => x.score > 0 || !q)
    .sort((a, b) => b.score - a.score || (a.r.name < b.r.name ? -1 : 1))
    .map((x) => x.r)
    .slice(0, 40)
}

async function searchGithub(query: string, sort: string): Promise<PluginInfo[]> {
  const q = (query || '').trim()
  const key = `gh|${q}|${sort}`
  if (searchCache && searchCache.key === key && Date.now() - searchCache.time < 60000) {
    return searchCache.results
  }
  const installedRepos = listInstalledRepos()
  // GitHub 仓库搜索：query 限定在 name/description/topics 内（避免 readme 弱相关命中），
  // 再加 topic:dsh-plugin 约束；结果经相关性过滤排序。
  const text = q ? `${q} in:name,description,topics topic:dsh-plugin` : 'topic:dsh-plugin'
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
    const raw = j.items
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
          repoUrl: (r.html_url as string) ?? '',
          topics: (r.topics as string[]) ?? []
        }
      })
    const results = raw
      .map((r) => ({ r, score: relevanceOf(r.repo, r.topics, r.description, q) }))
      .filter((x) => x.score > 0 || !q)
      .sort((a, b) => b.score - a.score || b.r.stars - a.r.stars)
      .map(({ r }) => ({ ...r, topics: undefined }))
      .slice(0, 40)
    searchCache = { key, time: Date.now(), results }
    return results
  } catch (e) {
    pushLog('GitHub 搜索失败: ' + (e as Error).message)
    return []
  }
}

export async function searchPlugins(query: string, sort: string = 'stars', source: string = 'github'): Promise<PluginInfo[]> {
  // Q6：IPC 直传的 sort/source 白名单校验，非法值回默认，防恶意参数
  const safeSource = source === 'npm' ? 'npm' : 'github'
  const safeSort = sort === 'updated' ? 'updated' : 'stars'
  if (safeSource === 'npm') return searchNpm(query)
  return searchGithub(query, safeSort)
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

/** 检查已安装包的真实性：pnpm 对仓库根目录没有 package.json 的 git 仓库，会生成占位 package.json */
function inspectInstalled(
  dir: string,
  name: string
): { placeholder: boolean; bundle: boolean; entry: boolean; installScript: boolean } {
  const empty = { placeholder: false, bundle: false, entry: false, installScript: false }
  try {
    const pkgPath = join(dir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) return empty
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return {
      placeholder: pkg._pnpmPlaceholder !== undefined,
      bundle: pkg.dsh?.bundle?.patch !== undefined,
      entry: Boolean(pkg.main || pkg.exports || pkg.bin),
      installScript: existsSync(join(dir, 'node_modules', name, 'install.ps1'))
    }
  } catch {
    return empty
  }
}

/** 把被拦截的一个 token 转成 allowBuilds 的 key。
 *  普通包：`cloudflared@0.7.3` → `cloudflared`；
 *  git 依赖：`@scope/name@git+https://...git#commit` → `@scope/name@git+https://...git`
 *  （pnpm 用 `getGitRepoAllowBuildKeyFromDepPath` 匹配，key 带 @name@ 前缀、去掉 #commit）。 */
function ignoredBuildKey(token: string): string {
  const t = token.trim()
  if (t.includes('@git+') || t.startsWith('git+')) {
    const hashIdx = t.indexOf('#')
    return hashIdx === -1 ? t : t.slice(0, hashIdx)
  }
  const m = /^(@?[^\s@]+)@\d/.exec(t)
  return m ? m[1] : t
}

/** 从 pnpm 输出的 ERR_PNPM_IGNORED_BUILDS 里解析被拦截的包名（如 cloudflared@0.7.3 或 git 依赖） */
function parseIgnoredBuilds(output: string): string[] {
  if (!/ERR_PNPM_IGNORED_BUILDS/.test(output)) return []
  const line = output.match(/Ignored build scripts:\s*(.+)/)?.[1]
  if (!line) return []
  const tokens = line.split(',').map(ignoredBuildKey).filter(Boolean)
  return [...new Set(tokens)]
}

/** YAML key 需要加引号的情形：@ 开头（scoped 包名）或含特殊字符。
 *  @ 是 YAML 保留字符，裸写会被 pnpm 当缩进错误拒绝。 */
function yamlKey(name: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 把包写入 profile 的 pnpm-workspace.yaml 的 allowBuilds（pnpm 11 的构建放行机制）。
 *  重建整个 allowBuilds 段：统一给需要引号的 key（如 @scope/pkg）加引号，
 *  顺带修掉被误写的占位文本 / 裸写的 scoped 条目。 */
function approveBuilds(pkgNames: string[]): void {
  const fresh = [...new Set(pkgNames.filter(Boolean))]
  if (fresh.length === 0) return
  const wsPath = join(profileDir(), 'pnpm-workspace.yaml')
  try {
    const existing = existsSync(wsPath) ? readFileSync(wsPath, 'utf8') : ''
    const lines = existing.split(/\r?\n/)
    const allowIdx = lines.findIndex((l) => /^allowBuilds:\s*$/.test(l))
    const keys = new Set<string>()
    let endIdx = lines.length
    if (allowIdx !== -1) {
      for (let i = allowIdx + 1; i < lines.length; i++) {
        const m = /^\s{2}("?)([^\s:"]+)\1:/.exec(lines[i])
        if (!m) break
        keys.add(m[2])
        endIdx = i + 1
      }
    }
    for (const n of fresh) keys.add(n)
    const head = allowIdx === -1 ? lines : lines.slice(0, allowIdx)
    const tail = allowIdx === -1 ? [] : lines.slice(endIdx)
    const block = ['allowBuilds:', ...[...keys].map((k) => `  ${yamlKey(k)}: true`)]
    writeFileSync(wsPath, [...head, ...block, ...tail].join('\n') + '\n')
    pushLog('已放行构建脚本: ' + fresh.join(', '))
  } catch (e) {
    pushLog('写入 allowBuilds 失败: ' + (e as Error).message)
  }
}

/** 精准放行某个包的构建脚本（pnpm 11 主机制是 pnpm-workspace.yaml 的 allowBuilds；
 *  package.json 的 pnpm.onlyBuiltDependencies 保留作旧版本兼容） */
function allowBuild(pkgName: string): void {
  approveBuilds([pkgName])
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

/** 读取 profile package.json（解析失败返回 null）；供恢复模块等复用 */
export function readProfilePkg(): Record<string, unknown> | null {
  const pkgPath = join(profileDir(), 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 读取已安装包的 package.json（node_modules/<name>/package.json） */
function readInstalledPackageJson(name: string): Record<string, unknown> | null {
  const pkgPath = join(profileDir(), 'node_modules', name, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从 registry 取某 npm 包的元数据（latest 版本的信息） */
async function fetchNpmPackageMeta(name: string): Promise<Record<string, unknown> | null> {
  try {
    const registry = (loadSettings().npmRegistry?.trim() || 'https://registry.npmjs.org').replace(/\/+$/, '')
    return (await curlJson(`${registry}/${encodeURIComponent(name)}/latest`)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 从包的 dsh.bundle.patch 声明中提取注册标识（id/name/文件名）集合 */
function patchIdsOf(pkg: Record<string, unknown> | null | undefined): string[] {
  const p = (pkg as { dsh?: { bundle?: { patch?: unknown } } } | undefined)?.dsh?.bundle?.patch
  if (!p) return []
  if (typeof p === 'string') return [p]
  if (Array.isArray(p)) return p.flatMap((x) => (typeof x === 'string' ? [x] : patchIdsOf(x)))
  if (typeof p === 'object') {
    const obj = p as Record<string, unknown>
    return [...Object.keys(obj), ...Object.values(obj).flatMap((v) => patchIdsOf((v ?? {}) as Record<string, unknown>))]
  }
  return []
}

/**
 * 安装前冲突预检（v0.3.0：先检测再安装，借鉴 zat-dsh-engine 冲突门禁思路）：
 * - 同名依赖已装 → 冲突；
 * - 候选包声明的 dsh.bundle.patch 注册标识与已装插件重叠 → 冲突（duplicate patch/loader/slot）；
 * - 无法解析候选包（git 仓库无 package.json / 网络失败）→ 降级为仅同名检测（warning 不阻断）。
 */
export async function preflightPluginInstall(spec: string, source: string = 'github'): Promise<PluginOpResult> {
  const conflicts: string[] = []
  const warnings: string[] = []
  let npmName: string | null = null
  let candidate: Record<string, unknown> | null = null
  if (source === 'npm') {
    npmName = spec
    candidate = await fetchNpmPackageMeta(spec)
  } else {
    const repo = /github\.com[/:]([^/]+\/[^/#?]+)/.exec(spec)?.[1]?.replace(/\.git$/, '') ?? spec
    npmName = await fetchRepoNpmName(repo)
    candidate = npmName ? await fetchNpmPackageMeta(npmName) : null
  }
  const installed = await listInstalledPlugins()
  if (npmName && installed.some((p) => p.name === npmName)) {
    conflicts.push(`已安装同名插件「${npmName}」，安装将覆盖/升级它（建议先更新或卸载）`)
  }
  const candIds = candidate ? patchIdsOf(candidate) : []
  if (candIds.length > 0) {
    for (const ip of installed) {
      const ipIds = patchIdsOf(readInstalledPackageJson(ip.name))
      const overlap = candIds.filter((id) => ipIds.includes(id))
      if (overlap.length > 0) {
        conflicts.push(`与「${ip.name}」冲突：重复注册 ${[...new Set(overlap)].join('、')}`)
      }
    }
  }
  if (!npmName) warnings.push('未能解析出候选包的 npm 包名，仅做已安装同名检测')
  else if (!candidate) warnings.push('无法获取候选包元数据（网络/限流），已跳过深层冲突检测')
  return {
    ok: conflicts.length === 0,
    message: conflicts.length > 0 ? `检测到 ${conflicts.length} 项安装冲突，建议先处理再安装` : '未检测到冲突，可以安装',
    conflicts,
    warnings
  }
}

export async function installPlugin(
  spec: string,
  source: string = 'github',
  approvedBuilds?: string[]
): Promise<PluginOpResult> {
  assertSafeSpec(spec)
  return withPluginMutex(async () => {
  searchCache = null
  await backupProfile()
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
    // 预取 npm 包名（供占位包检测；构建脚本放行一律走用户确认，不再预放行）
    npmName = await fetchRepoNpmName(repo)
  }
  // pnpm 11 会拦截需要构建脚本的依赖并报 ERR_PNPM_IGNORED_BUILDS（致命）。
  // 安全策略（默认拒绝）：拦截时返回待确认清单，用户逐包确认后带 approvedBuilds 重试；
  // 绝不自动放行——安装第三方插件 = 执行其（及传递依赖的）构建脚本，必须显式同意
  let result = await runPnpm(['add', pnpmSpec])
  for (let attempt = 0; result.code !== 0 && attempt < 3; attempt++) {
    const ignored = parseIgnoredBuilds(result.output)
    if (ignored.length === 0) break
    const known = approvedBuilds ?? []
    const pending = ignored.filter((p) => !known.includes(p))
    if (!approvedBuilds || pending.length > 0) {
      const all = [...new Set([...known, ...ignored])]
      return {
        ok: false,
        buildApprovals: all,
        message: `以下依赖包含安装期构建脚本（放行 = 允许执行其代码），请确认后重试: ${all.join(', ')}`
      }
    }
    approveBuilds(ignored)
    result = await runPnpm(['add', pnpmSpec])
  }
  const { code, output } = result
  if (code !== 0) {
    const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: last || `安装失败 (exit ${code})` }
  }
  const resolved = findNpmNameByRepo(spec) ?? npmName ?? spec
  reconcileBundles(profileDir(), [resolved], [])
  // pnpm 对没有 package.json 的 git 仓库会"成功"但只生成占位包 —— 检测出来并明确报错，避免静默无效
  const info = inspectInstalled(profileDir(), resolved)
  if (info.placeholder) {
    // 1.9：pnpm add 已把占位包写进 package.json/node_modules——主动回滚，
    // 否则依赖记录残留、列表显示"已安装"、再装同名真实包时冲突
    await runPnpm(['remove', resolved])
    const hint = info.installScript
      ? '仓库含 install.ps1，属于「套装/脚本安装」型仓库（依赖 submodule + 安装脚本），不能直接 pnpm 安装。'
      : '仓库根目录没有 package.json，pnpm 只能装出占位包。'
    return {
      ok: false,
      message: `「${spec}」不是可安装的 npm/git 包（${hint}）已回滚依赖。请改用 npm 包名安装，或按仓库自身机制安装。`
    }
  }
  if (info.bundle) return { ok: true, message: `已安装 ${spec}，已注册为 bundle（服务自动重启后生效）` }
  if (!info.entry) return { ok: true, message: `已安装 ${spec}，但该包没有 main/exports 入口，需确认是否可被 dsh 加载` }
  return { ok: true, message: `已安装 ${spec}（未声明 dsh.bundle，需在 cordis.patch.yml 里手动启用）` }
  })
}

export async function uninstallPlugin(name: string): Promise<PluginOpResult> {
  assertSafeName(name)
  return withPluginMutex(async () => {
  searchCache = null
  await backupProfile()
  const { code, output } = await runPnpm(['remove', name])
  if (code !== 0) {
    const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    return { ok: false, message: last || `卸载失败 (exit ${code})` }
  }
  reconcileBundles(profileDir(), [], [name])
  return { ok: true, message: `已卸载 ${name}` }
  })
}
