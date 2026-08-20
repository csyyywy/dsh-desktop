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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveRuntime } from './dsh-manager'
import { dataDir, dshHome, loadSettings } from './settings'
import { pushLog } from './log'
import { curlJson } from './net'
import { currentDistro, runWslBash, toUnc, wslBaseLinux, wslDshHomeLinux, wslPnpmCjs, wslNodeBin, bashQuote } from './wsl'
import type { PluginInfo, PluginOpResult, PluginUpdateInfo } from '../shared/types'

const PROFILE = 'web'

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

/** profile 目录：WSL 模式 = UNC（Windows 侧 fs 用），本机 = Windows 路径 */
function profileDir(): string {
  if (loadSettings().backend === 'wsl') {
    const d = currentDistro()
    const l = profileLinuxDir()
    return d && l ? toUnc(d, l) : join(dshHome(), 'profiles', PROFILE)
  }
  return join(dshHome(), 'profiles', PROFILE)
}

/** profile 目录（发行版内 Linux 路径，仅供 wsl.exe 命令） */
function profileLinuxDir(): string | null {
  const home = wslDshHomeLinux()
  return home ? `${home}/profiles/${PROFILE}` : null
}

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
    const res = await runWslBash(script, { timeoutMs: 10 * 60 * 1000 })
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

/** 备份目录：WSL 模式 = 发行版内 backups（UNC 形态），本机 = dataDir/backups/plugins */
function backupsDir(): string {
  if (loadSettings().backend === 'wsl') {
    const d = currentDistro()
    const base = wslBaseLinux()
    return d && base ? toUnc(d, `${base}/backups/plugins`) : join(dataDir(), 'backups', 'plugins')
  }
  return join(dataDir(), 'backups', 'plugins')
}

/** 备份目录（发行版内 Linux 路径，wsl cp/rm 回退用） */
function backupsLinuxDir(): string | null {
  const base = wslBaseLinux()
  return base ? `${base}/backups/plugins` : null
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

/**
 * 安装/卸载前把整个 profile 目录快照到 backups/plugins/<时间戳>。
 * 调用方（controller）保证：WSL 模式下服务已停止后再调用（原子性）。
 * UNC cpSync 失败时回退发行版内 wsl cp -r。
 */
async function backupProfile(): Promise<void> {
  const dir = profileDir()
  if (!existsSync(join(dir, 'package.json'))) return
  const name = timestamp()
  const dest = join(backupsDir(), name)
  const linuxDir = profileLinuxDir()
  const linuxDest = backupsLinuxDir()
  try {
    mkdirSync(dest, { recursive: true })
    cpSync(dir, dest, { recursive: true })
  } catch (e) {
    pushLog('备份 profile（UNC）失败: ' + (e as Error).message)
    if (loadSettings().backend === 'wsl' && linuxDir && linuxDest) {
      // 回退：发行版内直接 cp。先清理同名目标（避免 cp -r 嵌套成 <ts>/web），
      // 再拷内容（${linuxDir}/. → ${linuxDest}/${name}/）。路径统一 bashQuote。
      const res = await runWslBash(
        `rm -rf ${bashQuote(`${linuxDest}/${name}`)} && mkdir -p ${bashQuote(`${linuxDest}/${name}`)} && cp -r ${bashQuote(`${linuxDir}/.`)} ${bashQuote(`${linuxDest}/${name}/`)}`,
        { silent: true }
      )
      if (res.code !== 0) pushLog('备份 profile（wsl cp）失败: ' + (res.stderr || res.stdout).trim())
    } else {
      pushLog('备份 profile 失败: ' + (e as Error).message)
    }
  }
  pruneBackups()
}

export function listBackups(): string[] {
  const dir = backupsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().reverse()
}

// 备份名是 backupProfile 生成的时间戳（YYYYMMDD-HHMMSS）；
// 删除前必须严格校验，防止构造 ../ 之类路径穿越
const BACKUP_NAME_RE = /^\d{8}-\d{6}$/

export function deleteBackup(name: string): PluginOpResult {
  if (!BACKUP_NAME_RE.test(name)) return { ok: false, message: '非法的备份名称' }
  const target = join(backupsDir(), name)
  if (!existsSync(target)) return { ok: false, message: '备份不存在' }
  try {
    rmSync(target, { recursive: true, force: true })
  } catch (e) {
    return { ok: false, message: '删除失败: ' + (e as Error).message }
  }
  return { ok: true, message: `已删除备份 ${name}` }
}

export async function restoreBackup(name: string): Promise<PluginOpResult> {
  // 安全校验（与 deleteBackup 同规则）：备份名必须是时间戳格式，
  // 否则 join() 可路径穿越、WSL 回退分支存在命令注入面（高危，必校验）
  if (!BACKUP_NAME_RE.test(name)) return { ok: false, message: '非法的备份名称' }
  return withPluginMutex(async () => {
    const src = join(backupsDir(), name)
    const dir = profileDir()
    if (!existsSync(src)) return { ok: false, message: '备份不存在' }
    const staging = dir + '.restore'
    const oldDir = dir + '.old'
    try {
      // 原子恢复（1.3）：先拷到 staging，校验成功后再交换——失败不毁现有 profile
      rmSync(staging, { recursive: true, force: true })
      rmSync(oldDir, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      cpSync(src, staging, { recursive: true })
      if (existsSync(dir)) renameSync(dir, oldDir)
      renameSync(staging, dir)
      rmSync(oldDir, { recursive: true, force: true })
    } catch (e) {
      // 回滚：清理 staging，恢复被换走的原 profile
      rmSync(staging, { recursive: true, force: true })
      if (!existsSync(dir) && existsSync(oldDir)) {
        try { renameSync(oldDir, dir) } catch { /* ignore */ }
      }
      rmSync(oldDir, { recursive: true, force: true })
      // UNC 失败回退发行版内操作（路径统一 bashQuote，防特殊字符破坏/注入）
      const linuxDir = profileLinuxDir()
      const linuxSrc = backupsLinuxDir()
      if (loadSettings().backend === 'wsl' && linuxDir && linuxSrc) {
        const res = await runWslBash(`rm -rf ${bashQuote(linuxDir)} && mkdir -p ${bashQuote(linuxDir)} && cp -r ${bashQuote(`${linuxSrc}/${name}`)} ${bashQuote(linuxDir)}`, { silent: true })
        return res.code === 0
          ? { ok: true, message: `已回退到 ${name}` }
          : { ok: false, message: '回退失败: ' + (res.stderr || res.stdout).trim() }
      }
      return { ok: false, message: '回退失败: ' + (e as Error).message }
    }
    return { ok: true, message: `已回退到 ${name}` }
  })
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

export async function updatePlugin(name: string): Promise<PluginOpResult> {
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
  const npmName = isGitSpec(spec) ? null : name
  if (npmName) allowBuild(npmName)
  // git 依赖：显式锁到远端最新 HEAD commit（bare spec 重装可能被 pnpm 判定无变化而跳过）
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
    // 走 curlJson（系统 curl），与项目约束一致：Node fetch 在自定义 CA 代理下会 TLS 校验失败
    const j = (await curlJson(url)) as { objects?: Array<{ package: Record<string, unknown> }> }
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

export async function installPlugin(spec: string, source: string = 'github'): Promise<PluginOpResult> {
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
    // 预取 npm 包名（下方统一放行构建脚本；pnpm 默认拦截 git 依赖的 prepare 脚本）
    npmName = await fetchRepoNpmName(repo)
  }
  if (npmName) allowBuild(npmName)
  // pnpm 11 会拦截需要构建脚本的依赖并报 ERR_PNPM_IGNORED_BUILDS（致命）。
  // 把被拦的包写进 allowBuilds 后重试，最多三轮（依赖树里可能有多个）。
  let result = await runPnpm(['add', pnpmSpec])
  for (let attempt = 0; result.code !== 0 && attempt < 3; attempt++) {
    const ignored = parseIgnoredBuilds(result.output)
    if (ignored.length === 0) break
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
    const hint = info.installScript
      ? '仓库含 install.ps1，属于「套装/脚本安装」型仓库（依赖 submodule + 安装脚本），不能直接 pnpm 安装。'
      : '仓库根目录没有 package.json，pnpm 只能装出占位包。'
    return {
      ok: false,
      message: `「${spec}」已写进依赖，但 ${resolved} 不是可安装的 npm/git 包（${hint}）dsh 不会加载它。请改用 npm 包名安装，或在列表中卸载它。`
    }
  }
  if (info.bundle) return { ok: true, message: `已安装 ${spec}，已注册为 bundle（服务自动重启后生效）` }
  if (!info.entry) return { ok: true, message: `已安装 ${spec}，但该包没有 main/exports 入口，需确认是否可被 dsh 加载` }
  return { ok: true, message: `已安装 ${spec}（未声明 dsh.bundle，需在 cordis.patch.yml 里手动启用）` }
  })
}

export async function uninstallPlugin(name: string): Promise<PluginOpResult> {
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
