// WSL 后端编排（v0.2.0）——从 index.ts 拆出，与外壳主流程解耦：
// 部署（runBackendSetup）、GitHub 可达性打通（ensureWslGithubAccess）、
// 本机→WSL 数据同步（syncFromWindows）、纯净模式降级（degradeToPureProfile）、
// 诊断（backendDiagnose）、后端信息（buildBackendInfo）。
// 依赖注入：runBackendSetup 需要的 广播/停止服务/目标版本 经 deps 传入，
// 本模块不反向依赖 index.ts（无循环引用）。
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { installDshWsl, wslInstalledVersion, wslIsComplete } from './dsh-manager'
import { dshHome, loadSettings, saveSettings } from './settings'
import { pushLog } from './log'
import { runPnpm } from './plugin-manager'
import { migrateSessionCwds } from './session-cwd-migrate'
import {
  bashQuote,
  currentDistro,
  hasSetsid,
  kernelVersion,
  listDistros,
  pingDistro,
  runWsl,
  runWslBash,
  runWslGlobal,
  toUnc,
  validateIpcArg,
  VALID_DISTRO_RE,
  wslBaseLinux,
  wslDshHomeLinux,
  wslDshHomeWindows,
  wslHomeOf,
  wslNodeBin,
  wslVersion,
  wslWorkspaceLinux
} from './wsl'
import type { BackendInfo, BackendSetupProgress, PluginOpResult } from '../shared/types'

/** runBackendSetup 需要的宿主能力（由 index.ts 注入） */
export interface BackendSetupDeps {
  emit(stage: BackendSetupProgress['stage'], percent: number, message: string): void
  broadcastStatus(): void
  stopIfRunning(): Promise<void>
  resolveDshTarget(): string
}

export async function buildBackendInfo(): Promise<BackendInfo> {
  const s = loadSettings()
  const { distros, error } = await listDistros()
  const [wv, kv] = await Promise.all([wslVersion(), kernelVersion()])
  return {
    mode: s.backend,
    distro: s.backend === 'wsl' ? s.wslDistro : null,
    distros,
    ready: s.backend === 'wsl' && !!s.wslDistro && wslIsComplete(),
    wslVersion: wv,
    kernelVersion: kv,
    error
  }
}

/** backend:setup 主流程：就绪检查 → 目录 → Node(tar) → pnpm → npm install dsh → 校验 */
export async function runBackendSetup(distro: string, deps: BackendSetupDeps): Promise<PluginOpResult> {
  const emit = deps.emit
  if (!validateIpcArg(distro) || !VALID_DISTRO_RE.test(distro)) {
    return { ok: false, message: '发行版名称含特殊字符，暂不支持部署' }
  }
  emit('ready', 0, `正在检查发行版 ${distro} …`)
  const ping = await pingDistro(distro)
  if (!ping.ok) return { ok: false, message: ping.message }
  // 旧后端（本机或其它发行版）运行中先停止
  await deps.stopIfRunning()

  emit('mkdir', 5, '创建目录结构 …')
  const home = await wslHomeOf(distro)
  if (!home) return { ok: false, message: '无法解析发行版 HOME' }
  const base = `${home}/.dsh-desktop`
  const mk = await runWslBash(`mkdir -p ${bashQuote(`${base}/node`)} ${bashQuote(`${base}/pnpm`)} ${bashQuote(`${base}/logs`)}`, { silent: true, distro })
  if (mk.code !== 0) return { ok: false, message: '创建目录失败: ' + (mk.stderr || mk.stdout).trim() }

  emit('node', 15, '拷贝 Linux Node（约 25MB）…')
  const tarSrc = app.isPackaged
    ? join(process.resourcesPath, 'node-linux.tar.xz')
    : join(app.getAppPath(), 'resources', 'node-linux.tar.xz')
  if (!existsSync(tarSrc)) return { ok: false, message: '缺少内置 Linux Node 资源（node-linux.tar.xz），请重新构建应用' }
  try {
    await fsp.copyFile(tarSrc, toUnc(distro, `${base}/node.tar.xz`))
  } catch (e) {
    return { ok: false, message: '拷贝 Node 失败: ' + (e as Error).message }
  }
  emit('node', 30, '解压 Node（tar 保留执行权限）…')
  const x = await runWslBash(`cd ${bashQuote(base)} && tar -xJf node.tar.xz --strip-components=1 -C node && chmod +x node/bin/node && rm -f node.tar.xz`, { timeoutMs: 180000, distro })
  if (x.code !== 0) return { ok: false, message: '解压 Node 失败: ' + (x.stderr || x.stdout).trim() }

  emit('pnpm', 45, '拷贝 pnpm（约 36MB）…')
  const pnpmSrc = app.isPackaged
    ? join(process.resourcesPath, 'pnpm')
    : join(app.getAppPath(), 'resources', 'pnpm')
  try {
    cpSync(pnpmSrc, toUnc(distro, `${base}/pnpm`), { recursive: true })
  } catch (e) {
    return { ok: false, message: '拷贝 pnpm 失败: ' + (e as Error).message }
  }

  const target = deps.resolveDshTarget()
  // 编译工具链（g++/make/python3）：dsh 依赖 node-pty/koffi 等原生包，npm install
  // 时 node-gyp 编译必需（冒烟实测缺失会 node-gyp 失败）。自动换阿里 apt 源（失败容忍）+ 安装。
  emit('npm-install', 55, '检查编译工具链（build-essential/python3）…')
  const toolsCheck = await runWslBash('command -v g++ >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && echo TOOLS_OK || echo TOOLS_MISSING', { silent: true, distro })
  if (!toolsCheck.stdout.includes('TOOLS_OK')) {
    emit('npm-install', 56, '缺少编译工具链，自动安装（阿里镜像源，约 2-3 分钟）…')
    pushLog('WSL 发行版缺少编译工具链，自动安装 build-essential/python3 …')
    // 自动换阿里源（仅替换 Ubuntu 默认域名，失败容忍），再安装
    await runWslBash(
      'sudo sed -i "s|//archive.ubuntu.com/ubuntu|//mirrors.aliyun.com/ubuntu|g; s|//security.ubuntu.com/ubuntu|//mirrors.aliyun.com/ubuntu|g" /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list 2>/dev/null; sudo apt-get update -qq',
      { silent: true, distro, timeoutMs: 180000 }
    )
    const tools = await runWslBash('sudo apt-get install -y -qq build-essential python3', { silent: true, distro, timeoutMs: 10 * 60 * 1000 })
    if (tools.code !== 0) {
      return { ok: false, message: '编译工具链安装失败，请手动执行: sudo apt install -y build-essential python3 后重试' }
    }
    const re = await runWslBash('command -v g++ >/dev/null && command -v make >/dev/null && command -v python3 >/dev/null && echo TOOLS_OK || echo TOOLS_MISSING', { silent: true, distro })
    if (!re.stdout.includes('TOOLS_OK')) {
      return { ok: false, message: '编译工具链安装后仍不可用（g++/make/python3）' }
    }
  }
  emit('npm-install', 60, `安装 @deepseek-ai/dsh@${target}（发行版内 npm，首次需联网）…`)
  // 部署期间 settings 尚未切换：显式传 distro/home，不走 currentDistro()/wslBaseLinux()
  const code = await installDshWsl(target, (line) => emit('npm-install', 60, line), { distro, home })
  if (code !== 0) return { ok: false, message: 'dsh 安装失败，详见日志（检查网络/代理）' }

  emit('verify', 95, '校验安装 …')
  // 先保存配置再校验（wslIsComplete 依赖 backend 配置）
  const prev = loadSettings()
  saveSettings({ ...prev, backend: 'wsl', wslDistro: distro, wslHome: home })
  if (!wslIsComplete()) {
    saveSettings({ ...prev })
    return { ok: false, message: '安装校验失败（依赖不完整），请重试' }
  }
  const setsid = await hasSetsid(distro)
  if (!setsid) {
    return { ok: false, message: '发行版缺少 setsid（util-linux），请先运行: sudo apt install util-linux（部署已完成，修复后即可启动）' }
  }
  emit('verify', 98, '从本机同步插件/预设/会话（尽力而为，失败不阻断）…')
  const sync = await syncFromWindows((m) => emit('verify', 98, '同步: ' + m), false)
  if (!sync.ok) pushLog('部署后自动同步失败: ' + sync.message)
  emit('verify', 100, sync.ok ? '部署完成' : '部署完成（同步失败，服务仍可启动）')
  deps.broadcastStatus()
  return { ok: true, message: `WSL 后端部署完成（${distro}），dsh@${target}${sync.ok ? '。' + sync.message : '（同步失败: ' + sync.message + '）'}` }
}

/**
 * 确保 WSL 内可访问 GitHub（pnpm 的 git 依赖需要 clone）。
 * 本机场景（实测）：hosts 把 github.com 劫持到 127.0.0.1（#S302，steamcommunity_302
 * 本地 443 转发），WSL 的 DNS 转发继承该结果，但 WSL 内 127.0.0.1 是自己的回环
 * → 连接被拒；真实 IP 直连也被墙。对策：
 * 1. 探测 WSL 内 github 连通性；
 * 2. 不通且 Windows 侧 127.0.0.1:443 有转发服务（302）→ UAC 配置
 *    portproxy 0.0.0.0:443 → 127.0.0.1:443 + 防火墙放行（一次性，持久化）；
 * 3. WSL /etc/hosts 写入 Windows 宿主 IP（ip route 网关）的 github 映射。
 */
export async function ensureWslGithubAccess(distro: string, allowUac = false): Promise<{ ok: boolean; message: string }> {
  const probe = await runWslBash('curl -sS -o /dev/null -w "%{http_code}" --max-time 8 https://github.com', { silent: true, distro })
  if (['200', '301', '302'].includes(probe.stdout.trim())) return { ok: true, message: '' }
  // Windows 宿主 IP（WSL 网关；tr+cut 提取，避免 awk 单引号被外层剥掉的问题）
  const winIp = (await runWslBash("ip route show default | tr -s ' ' | cut -d' ' -f3 | head -1", { silent: true, distro })).stdout.trim()
  if (!winIp) return { ok: false, message: '无法获取 Windows 宿主 IP，git 依赖可能安装失败' }
  const hostsLine = `${winIp} github.com www.github.com api.github.com codeload.github.com raw.githubusercontent.com objects.githubusercontent.com gist.github.com`
  // 宿主 443 已可达（portproxy 已配置过）→ 直接写 hosts 验证，不再弹 UAC
  const hostProbe = await runWslBash(`curl -sS -o /dev/null -w "%{http_code}" --max-time 3 https://${winIp}:443`, { silent: true, distro })
  if (!['200', '301', '302'].includes(hostProbe.stdout.trim())) {
    // Windows 侧是否有 302 类本地转发（127.0.0.1:443）
    const hasLocal443 = await new Promise<boolean>((r) => {
      const s = connect({ host: '127.0.0.1', port: 443 }, () => {
        s.destroy()
        r(true)
      })
      s.on('error', () => r(false))
    })
    if (!hasLocal443) {
      return { ok: false, message: 'WSL 内无法访问 GitHub，且本机 127.0.0.1:443 无本地转发服务（steamcommunity_302 未运行？），git 依赖将安装失败' }
    }
    // 自动同步不弹 UAC（用户要求：做不到先跳过，服务先启动）；手动同步才提权配置
    if (!allowUac) {
      return { ok: false, message: 'WSL 内 GitHub 不可达（本机 hosts 劫持），自动同步跳过插件依赖重建；可在「从本机同步」时授权 UAC 打通' }
    }
    // 配置 portproxy + 防火墙（UAC 一次，幂等：先 delete 忽略错误再 add）
    const netshScript =
      "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=443 2>$null; " +
      'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=443; ' +
      "netsh advfirewall firewall delete rule name='dsh-wsl-gh443' 2>$null; " +
      "netsh advfirewall firewall add rule name='dsh-wsl-gh443' dir=in action=allow protocol=TCP localport=443"
    pushLog('WSL 内 GitHub 不可达（本机 hosts 劫持 127.0.0.1），请求提权配置 0.0.0.0:443 → 127.0.0.1:443 转发（请在弹出的 UAC 中允许）')
    try {
      const psCmd = `Start-Process powershell -ArgumentList '-NoProfile','-Command',${JSON.stringify(netshScript)} -Verb RunAs -Wait`
      await new Promise<void>((resolve) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true })
        child.on('close', () => resolve())
        child.on('error', () => resolve())
      })
    } catch {
      /* 用户拒绝 UAC 或失败，继续尝试直连 */
    }
  }
  // WSL hosts 写入 Windows 宿主 IP
  const res = await runWslBash(`grep -q "github.com" /etc/hosts || echo "${hostsLine}" | sudo tee -a /etc/hosts > /dev/null`, { distro })
  if (res.code !== 0) return { ok: false, message: '写入 /etc/hosts 失败: ' + (res.stderr || res.stdout).trim() }
  // 验证
  const re = await runWslBash('curl -sS -o /dev/null -w "%{http_code}" --max-time 10 https://github.com', { silent: true, distro })
  if (['200', '301', '302'].includes(re.stdout.trim())) {
    pushLog(`WSL 内 GitHub 已可达（经 Windows 宿主 ${winIp}:443 转发）`)
    return { ok: true, message: '' }
  }
  return { ok: false, message: 'GitHub 转发配置后仍不可达（请确认已允许 UAC），git 依赖可能安装失败' }
}

/**
 * 从本机 dsh-home 同步配置/插件/预设/会话到 WSL dsh-home（v0.2.0）：
 * 1. 复制配置层（排除 node_modules / pnpm 快照）：.agent-presets、sessions、storages、
 *    super-injector、profiles/web 的 package.json/pnpm-workspace.yaml/pnpm-lock.yaml/cordis*.yml、凭据散文件
 * 2. WSL 内 pnpm install 重建插件依赖（平台正确的二进制）
 * 调用方保证：同步在服务停止状态下进行（与备份同原子性规则）。
 */
export async function syncFromWindows(emit?: (msg: string) => void, allowUac = false): Promise<PluginOpResult> {
  const s = loadSettings()
  const d = currentDistro()
  const winHome = dshHome()
  const wslHomeU = wslDshHomeWindows()
  const wslHomeL = wslDshHomeLinux()
  if (s.backend !== 'wsl' || !d || !wslHomeU || !wslHomeL) return { ok: false, message: '需要先切换到 WSL 后端并完成部署' }
  if (!existsSync(winHome)) return { ok: false, message: '本机 dsh-home 不存在' }
  const log = (m: string): void => {
    pushLog('同步: ' + m)
    emit?.(m)
  }
  // 配置层排除规则：node_modules 由 WSL 内 pnpm install 重建（平台不同），快照文件冗余，
  // .credentials.yaml 不同步——dsh 0.1.0-rc.6 在 WSL 内读它会卡死启动（实测），
  // API Key 由启动时从本机凭据解析并经环境变量注入
  const isSyncable = (rel: string): boolean => !/node_modules/.test(rel) && !/\.mkts-snapshot/.test(rel) && rel !== '.credentials.yaml'
  let copied = 0
  try {
    for (const entry of readdirSync(winHome, { withFileTypes: true })) {
      const rel = entry.name
      if (!isSyncable(rel)) continue
      const src = join(winHome, rel)
      const dst = toUnc(d, `${wslHomeL}/${rel}`)
      log(`${entry.isDirectory() ? '目录' : '文件'} ${rel} …`)
      if (entry.isDirectory()) {
        mkdirSync(dst, { recursive: true })
        cpSync(src, dst, { recursive: true, filter: isSyncable })
      } else {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
      copied++
    }
  } catch (e) {
    // 配置层复制失败才视为同步失败（不影响已复制部分）
    return { ok: false, message: '同步失败: ' + (e as Error).message }
  }
  // 会话 cwd 适配（v0.2.1 缺陷修复）：Windows 侧会话 header.cwd 是 Windows 路径
  // （如 D:\ai\测试），dsh 的 workspace 挂载要求 cwd 解析为真实目录且等于工作区，
  // 否则同步来的会话在 WSL 内不可见。复制后把 cwd 改写为 WSL 工作区路径并迁移
  // 会话目录到匹配的 projectKey 目录（Windows 侧原始数据不动）。best-effort：
  // 失败仅记日志，不阻断同步与服务启动。
  try {
    const ws = wslWorkspaceLinux()
    const wslSessions = wslDshHomeWindows()
    if (ws && wslSessions && existsSync(join(wslSessions, 'sessions'))) {
      const st = await migrateSessionCwds(join(wslSessions, 'sessions'), ws)
      if (st.rewritten > 0 || st.failed.length > 0) {
        log(`会话 cwd 适配 WSL 工作区（${ws}）：改写 ${st.rewritten}，迁移 ${st.moved}，跳过 ${st.skipped}${st.failed.length ? '，失败 ' + st.failed.length + '：' + st.failed.join('；') : ''}`)
      }
    }
  } catch (e) {
    pushLog('同步: 会话 cwd 适配失败: ' + (e as Error).message)
  }
  // 插件依赖重建（尽力而为：失败不阻断，服务可直接启动，稍后可手动重试）
  log('WSL 内 pnpm install 重建插件依赖（平台正确）…')
  const gh = await ensureWslGithubAccess(d, allowUac)
  if (!gh.ok) {
    pushLog('同步: GitHub 不可达 - ' + gh.message)
    await degradeToPureProfile(d)
    return { ok: true, message: `配置/预设/会话已同步（${copied} 项）；插件依赖重建跳过（${gh.message}）。WSL 服务以纯净模式启动，稍后可在「从本机同步」时授权打通 GitHub 后重试` }
  }
  const r = await runPnpm(['install'])
  if (r.code !== 0) {
    const last = r.output.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
    await degradeToPureProfile(d)
    return { ok: true, message: `配置/预设/会话已同步（${copied} 项）；插件依赖重建失败（${last || 'exit ' + r.code}）。WSL 服务以纯净模式启动，稍后可手动重试同步` }
  }
  return { ok: true, message: `已从本机同步插件/预设/会话到 WSL（${copied} 项，依赖已重建）` }
}

/**
 * 插件依赖重建失败时，把 WSL profile 的 package.json 降级为**标准默认形态**
 * （备份原声明到 package.json.syncbak）——否则 dsh 启动时解析缺失的 bundle
 * 直接崩溃（cannot resolve profile bundle）；也不能写成空壳（实测 dsh 对
 * name≠dsh-profile-web 且无默认 bundles 的 package.json 会启动卡死）。
 * 标准形态 = dsh 首次启动自动生成的默认 web 组合（dsh-base + dsh-web-app）。
 * 手动同步成功（pnpm install 重写依赖）后自动恢复插件。
 */
const PURE_PROFILE_PACKAGE_JSON =
  JSON.stringify(
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    },
    null,
    2
  ) + '\n'

export async function degradeToPureProfile(d: string): Promise<void> {
  const wslHomeL = wslDshHomeLinux()
  const profileL = wslHomeL ? `${wslHomeL}/profiles/web` : null
  if (!profileL) return
  const pkgPath = toUnc(d, `${profileL}/package.json`)
  try {
    if (existsSync(pkgPath)) {
      const bak = toUnc(d, `${profileL}/package.json.syncbak`)
      if (!existsSync(bak)) copyFileSync(pkgPath, bak)
    }
    writeFileSync(pkgPath, PURE_PROFILE_PACKAGE_JSON, 'utf8')
    pushLog('同步: 插件依赖重建失败，WSL profile 已降级为默认 web 组合（原声明备份为 package.json.syncbak）')
  } catch (e) {
    pushLog('同步: 纯净模式降级失败: ' + (e as Error).message)
  }
}

export async function backendDiagnose(): Promise<string[]> {
  const lines: string[] = []
  const status = await runWslGlobal(['--status'], { silent: true })
  lines.push('--- wsl --status ---')
  lines.push(status.stdout.trim() || status.stderr.trim() || '(空)')
  const { distros, error } = await listDistros()
  lines.push('--- wsl -l -v ---')
  if (error) lines.push('枚举失败: ' + error)
  for (const d of distros) lines.push(`${d.name}  ${d.state}  WSL${d.version}${d.deployable ? '' : '（名称含特殊字符，不可部署）'}`)
  const distro = currentDistro()
  if (distro) {
    const ping = await pingDistro(distro, 15000)
    lines.push(`--- ping ${distro} ---`)
    lines.push(ping.ok ? 'ok' : ping.message)
    const node = wslNodeBin()
    if (node) {
      const nv = await runWsl([node, '--version'], { silent: true })
      lines.push(`node: ${nv.stdout.trim().split('\n')[0] || '不可用'}`)
    }
    lines.push(`dsh: ${wslInstalledVersion() ?? '未安装'}`)
  }
  return lines
}
