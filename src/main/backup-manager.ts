// 备份与回退管理器（v0.3.0 从 plugin-manager 拆出并扩展）：
// - 自动快照：安装/卸载/更新前对 profile 目录做时间戳快照（原有行为，含 WSL UNC/发行版内回退）；
// - 手动存档：把整个 dshHome() 打成独立归档（本机 tar zip / WSL 发行版内 tar.gz），
//   支持手动创建 / 列表 / 回退（staging 原子交换 + 恢复前快照）/ 删除；
// - resetHarnessData：#81「启动失败重置数据」恢复选项（备份后重建）。
// 依赖说明：profile 路径一律来自 wsl.ts 的 profileDir/profileLinuxDir（避免循环依赖）。
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { dataDir, dshHome, loadSettings } from './settings'
import { pushLog } from './log'
import {
  bashQuote, currentDistro, profileDir, profileLinuxDir, runWslBash, toUnc, wslBaseLinux, wslDshHomeLinux
} from './wsl'
import type { ManualBackupInfo, PluginOpResult } from '../shared/types'

// 自动快照名是时间戳（YYYYMMDD-HHMMSS）；删除/恢复前必须严格校验，防止路径穿越
const BACKUP_NAME_RE = /^\d{8}-\d{6}$/
// 手动存档名：<ts>-<label>.zip / <ts>-<label>.tar.gz（label 白名单字符）
const MANUAL_NAME_RE = /^\d{8}-\d{6}(?:-[0-9A-Za-z_-]{1,40})?\.(zip|tar\.gz)$/
const KEEP_AUTO = 10
const KEEP_MANUAL = 10

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 自动快照目录：WSL 模式 = 发行版内 backups/plugins（UNC 形态），本机 = dataDir/backups/plugins */
function backupsDir(): string {
  if (loadSettings().backend === 'wsl') {
    const d = currentDistro()
    const base = wslBaseLinux()
    return d && base ? toUnc(d, `${base}/backups/plugins`) : join(dataDir(), 'backups', 'plugins')
  }
  return join(dataDir(), 'backups', 'plugins')
}

/** 自动快照目录（发行版内 Linux 路径，wsl cp/rm 回退用） */
function backupsLinuxDir(): string | null {
  const base = wslBaseLinux()
  return base ? `${base}/backups/plugins` : null
}

/** 手动存档目录：WSL = 发行版内 backups/manual（UNC），本机 = dataDir/backups/manual */
function manualDir(): string {
  if (loadSettings().backend === 'wsl') {
    const d = currentDistro()
    const l = manualLinuxDir()
    return d && l ? toUnc(d, l) : join(dataDir(), 'backups', 'manual')
  }
  return join(dataDir(), 'backups', 'manual')
}

function manualLinuxDir(): string | null {
  const base = wslBaseLinux()
  return base ? `${base}/backups/manual` : null
}

// ---------- 自动快照（原有行为，从 plugin-manager 平移） ----------

function pruneBackups(): void {
  const dir = backupsDir()
  if (!existsSync(dir)) return
  const backups = readdirSync(dir).sort().reverse()
  while (backups.length > KEEP_AUTO) {
    rmSync(join(dir, backups.pop() as string), { recursive: true, force: true })
  }
}

/** 备份用的 profile 目录：优先 profiles/web（dsh 标准，--profile web），
 *  兼容历史版本把 profile 直接放在 profiles 根的布局；找不到 package.json 时回退 web */
function resolveBackupProfileDir(): string {
  const web = profileDir()
  if (existsSync(join(web, 'package.json'))) return web
  const profiles = join(dshHome(), 'profiles')
  if (existsSync(join(profiles, 'package.json'))) return profiles
  return web
}

/** cpSync filter：排除 node_modules —— pnpm 布局含 symlink/坏链接（junction 指向缺失目标），
 *  复制它既慢又不稳定（坏链接会让 tar/cp 报错）；插件真实状态由 package.json + pnpm-lock.yaml
 *  + pnpm-workspace.yaml 表达，回退后用 pnpm install 按 lockfile 重建（版本确定）。 */
function skipNodeModules(src: string): boolean {
  return !/node_modules/.test(src)
}

/** 安装/卸载前把 profile 目录快照到 backups/plugins/<时间戳>（排除 node_modules）。
 *  调用方（controller）保证：WSL 模式下服务已停止后再调用（原子性）。
 *  UNC cpSync 失败时回退发行版内 wsl cp -r。 */
export async function backupProfile(): Promise<void> {
  const dir = resolveBackupProfileDir()
  if (!existsSync(join(dir, 'package.json'))) {
    pushLog('自动备份跳过：profile 目录未初始化（' + dir + '）')
    return
  }
  const name = timestamp()
  const dest = join(backupsDir(), name)
  const linuxDir = profileLinuxDir()
  const linuxDest = backupsLinuxDir()
  try {
    mkdirSync(dest, { recursive: true })
    cpSync(dir, dest, { recursive: true, filter: skipNodeModules })
  } catch (e) {
    pushLog('备份 profile（UNC）失败: ' + (e as Error).message)
    if (loadSettings().backend === 'wsl' && linuxDir && linuxDest) {
      // 回退：发行版内直接 cp（Linux 下 symlink 复制无权限问题）。先清理同名目标
      const res = await runWslBash(
        `rm -rf ${bashQuote(`${linuxDest}/${name}`)} && mkdir -p ${bashQuote(`${linuxDest}/${name}`)} && cp -r ${bashQuote(`${linuxDir}/.`)} ${bashQuote(`${linuxDest}/${name}/`)}`,
        { silent: true }
      )
      if (res.code !== 0) pushLog('备份 profile（wsl cp）失败: ' + (res.stderr || res.stdout).trim())
    } else {
      pushLog('备份 profile 失败: ' + (e as Error).message)
    }
  }
  pushLog(`自动备份已创建: ${dest}`)
  pruneBackups()
}

export function listBackups(): string[] {
  const dir = backupsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort().reverse()
}

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

/** 回退自动快照：staging 拷贝 + 原子交换，失败回滚；UNC 失败回退发行版内 wsl cp。
 *  备份不含 node_modules（见 backupProfile），依赖重建由 controller 调 pnpm install 完成。 */
export async function restoreBackup(name: string): Promise<PluginOpResult> {
  if (!BACKUP_NAME_RE.test(name)) return { ok: false, message: '非法的备份名称' }
  const src = join(backupsDir(), name)
  const dir = resolveBackupProfileDir()
  if (!existsSync(src)) return { ok: false, message: '备份不存在' }
  const staging = dir + '.restore'
  const oldDir = dir + '.old'
  try {
    rmSync(staging, { recursive: true, force: true })
    rmSync(oldDir, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    cpSync(src, staging, { recursive: true })
    if (existsSync(dir)) renameSync(dir, oldDir)
    renameSync(staging, dir)
    rmSync(oldDir, { recursive: true, force: true })
  } catch (e) {
    rmSync(staging, { recursive: true, force: true })
    if (!existsSync(dir) && existsSync(oldDir)) {
      try { renameSync(oldDir, dir) } catch { /* ignore */ }
    }
    rmSync(oldDir, { recursive: true, force: true })
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
}

// ---------- 手动存档（v0.3.0） ----------

/** 归档标签白名单：只允许字母数字-_，最长 40 */
function sanitizeLabel(label: string): string {
  return (label || '').trim().replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40)
}

/** 本机系统 tar（bsdtar）执行：非 HTTP，无需走 curl */
function runTar(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('tar', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr?.on('data', (b: Buffer) => (err += b.toString()))
    child.on('error', (e) => resolve({ code: 1, output: e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, output: out || err }))
  })
}

/** 创建手动备份：整个 dshHome() 打成一个独立归档 */
export async function createManualBackup(label = ''): Promise<PluginOpResult> {
  const clean = sanitizeLabel(label)
  const ts = timestamp()
  const wslMode = loadSettings().backend === 'wsl'
  if (wslMode) {
    const base = wslBaseLinux()
    const home = wslDshHomeLinux()
    const d = currentDistro()
    const ldir = manualLinuxDir()
    if (!base || !home || !d || !ldir) return { ok: false, message: 'WSL 后端未部署' }
    const name = clean ? `${ts}-${clean}.tar.gz` : `${ts}.tar.gz`
    // --exclude=*node_modules*：跳过 pnpm 布局的 symlink/坏链接（坏链接会让 tar 报 Cannot stat）
    const res = await runWslBash(
      `mkdir -p ${bashQuote(ldir)} && tar czf ${bashQuote(`${ldir}/${name}`)} --exclude='*node_modules*' -C ${bashQuote(dirname(home))} ${bashQuote(basename(home))}`,
      { distro: d, timeoutMs: 10 * 60 * 1000 }
    )
    if (res.code !== 0) return { ok: false, message: '创建 WSL 手动备份失败: ' + (res.stderr || res.stdout).trim() }
    await pruneManualWsl()
    return { ok: true, message: `已创建手动备份 ${name}（不含 node_modules，回退时自动重建依赖）` }
  }
  const name = clean ? `${ts}-${clean}.zip` : `${ts}.zip`
  const dest = join(manualDir(), name)
  mkdirSync(manualDir(), { recursive: true })
  const home = dshHome()
  // --exclude=*node_modules*：同上，坏链接不再导致 tar 失败；依赖回退时重建
  const r = await runTar(['-a', '-c', '-f', dest, '--exclude=*node_modules*', '-C', dirname(home), basename(home)])
  if (r.code !== 0) return { ok: false, message: '创建手动备份失败: ' + r.output }
  pruneManual()
  return { ok: true, message: `已创建手动备份 ${name}（不含 node_modules，回退时自动重建依赖）` }
}

function parseTimestamp(name: string): number {
  const m = /^(\d{8})-(\d{6})/.exec(name)
  if (!m) return 0
  const s = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : 0
}

export function listManualBackups(): ManualBackupInfo[] {
  const dir = manualDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => MANUAL_NAME_RE.test(f))
    .map((f) => {
      let size = 0
      try { size = statSync(join(dir, f)).size } catch { /* ignore */ }
      return { name: f, size, createdAt: parseTimestamp(f) }
    })
    .sort((a, b) => b.createdAt - a.createdAt)
}

function pruneManual(): void {
  const dir = manualDir()
  if (!existsSync(dir)) return
  const list = readdirSync(dir).filter((f) => MANUAL_NAME_RE.test(f)).sort().reverse()
  while (list.length > KEEP_MANUAL) {
    rmSync(join(dir, list.pop() as string), { force: true })
  }
}

async function pruneManualWsl(): Promise<void> {
  const d = currentDistro()
  const ldir = manualLinuxDir()
  if (!d || !ldir) return
  const dir = manualDir()
  if (!existsSync(dir)) return
  const list = readdirSync(dir).filter((f) => MANUAL_NAME_RE.test(f)).sort().reverse()
  while (list.length > KEEP_MANUAL) {
    const f = list.pop() as string
    await runWslBash(`rm -f ${bashQuote(`${ldir}/${f}`)}`, { silent: true, distro: d })
  }
}

/** 恢复前把当前 dshHome 快照到 dataDir/backups/reset/<ts>（本机分支） */
async function snapshotHome(tag: string): Promise<PluginOpResult> {
  const home = dshHome()
  const dest = join(dataDir(), 'backups', 'reset', timestamp())
  mkdirSync(dest, { recursive: true })
  if (!existsSync(home)) return { ok: true, message: '（数据目录不存在，跳过快照）' }
  try {
    cpSync(home, dest, { recursive: true, filter: skipNodeModules })
    pushLog(`快照 dsh 数据（${tag}）: backups/reset/${timestamp().slice(0, 8)}…`)
    return { ok: true, message: '' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

/** 回退手动存档（本机）：安全快照 → staging 解包 → 原子交换 */
export async function restoreManualBackup(name: string): Promise<PluginOpResult> {
  if (!MANUAL_NAME_RE.test(name)) return { ok: false, message: '非法的备份名称' }
  if (loadSettings().backend === 'wsl') return restoreManualWsl(name)
  const src = join(manualDir(), name)
  if (!existsSync(src)) return { ok: false, message: '备份不存在' }
  const home = dshHome()
  try {
    const snap = await snapshotHome('手动恢复前')
    if (!snap.ok) return { ok: false, message: '恢复前快照失败，已取消: ' + snap.message }
    const staging = join(dataDir(), '.restore-dsh-home')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const r = await runTar(['-xf', src, '-C', staging])
    if (r.code !== 0) return { ok: false, message: '解包失败: ' + r.output }
    const extracted = join(staging, 'dsh-home')
    if (!existsSync(extracted)) return { ok: false, message: '存档内容不完整（缺少 dsh-home）' }
    const old = join(dataDir(), '.dsh-home.old')
    rmSync(old, { recursive: true, force: true })
    if (existsSync(home)) renameSync(home, old)
    renameSync(extracted, home)
    rmSync(old, { recursive: true, force: true })
    rmSync(staging, { recursive: true, force: true })
    return { ok: true, message: `已从手动备份 ${name} 恢复（原环境已快照）` }
  } catch (e) {
    return { ok: false, message: '恢复失败: ' + (e as Error).message }
  }
}

/** 回退手动存档（WSL：发行版内 tar + mv 原子交换） */
async function restoreManualWsl(name: string): Promise<PluginOpResult> {
  const base = wslBaseLinux()
  const home = wslDshHomeLinux()
  const d = currentDistro()
  const ldir = manualLinuxDir()
  if (!base || !home || !d || !ldir) return { ok: false, message: 'WSL 后端未部署' }
  const snap = `${base}/backups/reset/${timestamp()}`
  const staging = `${base}/.restore-dsh-home`
  const old = `${base}/.dsh-home.old`
  const script = [
    `mkdir -p ${bashQuote(snap)}`,
    `[ -d ${bashQuote(home)} ] && cp -r ${bashQuote(`${home}/.`)} ${bashQuote(`${snap}/`)}`,
    `rm -rf ${bashQuote(staging)} ${bashQuote(old)} && mkdir -p ${bashQuote(staging)}`,
    `tar xzf ${bashQuote(`${ldir}/${name}`)} -C ${bashQuote(staging)}`,
    `[ -d ${bashQuote(`${staging}/dsh-home`)} ] || { echo '存档不完整: 缺少 dsh-home'; exit 1; }`,
    `[ -d ${bashQuote(home)} ] && mv ${bashQuote(home)} ${bashQuote(old)}`,
    `mv ${bashQuote(`${staging}/dsh-home`)} ${bashQuote(home)}`,
    `rm -rf ${bashQuote(old)} ${bashQuote(staging)}`
  ].join('; ')
  const res = await runWslBash(script, { distro: d, timeoutMs: 10 * 60 * 1000 })
  if (res.code !== 0) return { ok: false, message: 'WSL 恢复失败: ' + (res.stderr || res.stdout).trim() }
  return { ok: true, message: `已从手动备份 ${name} 恢复（原环境已快照）` }
}

export async function deleteManualBackup(name: string): Promise<PluginOpResult> {
  if (!MANUAL_NAME_RE.test(name)) return { ok: false, message: '非法的备份名称' }
  if (loadSettings().backend === 'wsl') {
    const d = currentDistro()
    const ldir = manualLinuxDir()
    if (!d || !ldir) return { ok: false, message: 'WSL 后端未部署' }
    await runWslBash(`rm -f ${bashQuote(`${ldir}/${name}`)}`, { silent: true, distro: d })
    return { ok: true, message: `已删除备份 ${name}` }
  }
  const target = join(manualDir(), name)
  if (!existsSync(target)) return { ok: false, message: '备份不存在' }
  try {
    rmSync(target, { force: true })
  } catch (e) {
    return { ok: false, message: '删除失败: ' + (e as Error).message }
  }
  return { ok: true, message: `已删除备份 ${name}` }
}

// ---------- 重置数据（#81：启动失败恢复选项） ----------

/** 重置 dsh 数据目录：先快照到 backups/reset/<ts>，再重建空目录（供恢复界面/启动失败时用） */
export async function resetHarnessData(): Promise<PluginOpResult> {
  if (loadSettings().backend === 'wsl') return resetHarnessDataWsl()
  const snap = await snapshotHome('重置前')
  if (!snap.ok) return { ok: false, message: '备份失败，已取消重置: ' + snap.message }
  const home = dshHome()
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  pushLog(`已重置 dsh 数据目录（${home}）`)
  return { ok: true, message: `已备份到 backups/reset 并重建数据目录，请重新启动` }
}

async function resetHarnessDataWsl(): Promise<PluginOpResult> {
  const base = wslBaseLinux()
  const home = wslDshHomeLinux()
  const d = currentDistro()
  if (!base || !home || !d) return { ok: false, message: 'WSL 后端未部署' }
  const snap = `${base}/backups/reset/${timestamp()}`
  const script = `mkdir -p ${bashQuote(snap)} && [ -d ${bashQuote(home)} ] && cp -r ${bashQuote(`${home}/.`)} ${bashQuote(`${snap}/`)}; rm -rf ${bashQuote(home)} && mkdir -p ${bashQuote(home)}`
  const res = await runWslBash(script, { distro: d, timeoutMs: 10 * 60 * 1000 })
  if (res.code !== 0) return { ok: false, message: 'WSL 重置失败: ' + (res.stderr || res.stdout).trim() }
  return { ok: true, message: `已备份到 backups/reset 并重建 WSL 数据目录，请重新启动` }
}
