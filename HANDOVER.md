# dsh-desktop 项目交接文档

> 本文档供接续开发者 / agent 接手 **dsh-desktop** 项目使用。
> 记录了项目现状、本机环境、关键机制与踩过的坑。
> 最后更新：2026-08-15（v0.1.4 发布后）。

---

## 1. 项目概述

**dsh-desktop** 是 DeepSeek 开源 agent harness（[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，CLI 为 `dsh`）的 **Electron 桌面封装**，开源在 https://github.com/csyyywy/dsh-desktop 。

**核心原则（不可违背）**：`dsh` 原样运行（从 npm 安装、不 fork、不注入其前端），外壳只负责**安装 / 启动 / 托盘 / 更新 / 设置 / 插件管理**。插件生态与官方升级全部保留。

```
dsh-desktop/
├── src/
│   ├── main/                # Electron 主进程
│   │   ├── index.ts         # 生命周期、窗口、IPC 注册、单实例锁
│   │   ├── controller.ts    # 服务状态机（start/stop/restart + phase）
│   │   ├── dsh-manager.ts   # dsh 安装/版本/更新/回滚/内置 bundle 恢复
│   │   ├── server.ts        # dsh 进程管理 + 端口健康探测
│   │   ├── plugin-manager.ts# 插件安装/卸载/搜索/备份回滚（pnpm）
│   │   ├── updater.ts       # 应用自更新（GitHub Releases）
│   │   ├── settings.ts      # 设置读写 + 数据目录判定（便携/安装版）
│   │   ├── net.ts           # curlJson：外部请求统一走系统 curl
│   │   ├── log.ts           # 环形日志缓冲（内存，不落盘）
│   │   ├── tray.ts          # 系统托盘
│   │   └── ipc.ts           # IPC handler 注册
│   ├── preload/index.ts
│   └── renderer/            # 外壳 UI（React 19 + Tailwind v4）
│       └── src/Dashboard.tsx# 状态/设置/更新/日志/插件 面板
├── resources/
│   ├── installer.nsh        # NSIS 自定义脚本（安装/卸载页）★ 构建期专用
│   ├── node/ pnpm/ dsh-bundle/  # 构建产物（gitignore）
├── scripts/                 # 构建脚本（下载 node/pnpm、打包 dsh、图标、Electron 修复）
└── electron-builder.yml     # nsis + portable 配置
```

技术栈：Electron 43 / electron-vite 5 / electron-builder 26 / React 19 / Tailwind v4 / TS 5.9。

---

## 2. 当前状态（v0.1.3）

**已发布**：v0.1.3（2026-08-15）→ https://github.com/csyyywy/dsh-desktop/releases/tag/v0.1.3
产物：`setup.exe`（NSIS）/ `portable.exe` / `win-x64.zip`（绿色版）。

v0.1.3 相对 v0.1.2 的改动（git 提交，按时间倒序）：

| 提交 | 内容 |
|---|---|
| `f251ee2` | `parseIgnoredBuilds` 支持 git 依赖的构建拦截 key（`@name@git+url#commit`）→ 应用内 git 插件也能自动放行 |
| `c0b6f10` | 主窗口 F5/Ctrl+R 刷新 + 托盘重开自动刷新过期页面（webUIStale 标记）|
| `8e984e1` | 插件变更重启 dsh 后自动刷新主窗口 |
| `5df2127` | `allowBuilds` 中 scoped 包名（`@` 开头）加引号，否则 YAML 解析失败 |
| `eff71fe` | pnpm 11 拦截构建脚本（ERR_PNPM_IGNORED_BUILDS）→ 自动放行+重试 |
| `a0bad6b` | NSIS 安装器「数据位置说明」页 + 卸载器可勾选删除运行数据 |
| `3e97936` | git 安装无 package.json 的仓库（占位包）时明确报错 |

**待办 / 已知缺口**：
- ~~应用自更新~~：v0.1.4 起已实现「面板内下载 setup.exe → NSIS 静默安装」（见 §4.6），不再需要手动下载。
- 内置 dsh bundle（`resources/dsh-bundle`）在构建期 npm install 打包，版本随构建固化；应用「更新 dsh」走在线 npm 安装。
- `dsh.profile.bundles` 的插件装配只在 dsh 启动时生效，HMR 不处理新增 bundle 层 → 装插件必须重启服务（已由 `restartForPluginChange` 自动做）。

**v0.1.4（已发布 2026-08-15）**：`f251ee2`（git 依赖构建自动放行，v0.1.3 未含）+ 应用自更新（§4.6）。Release 附带 `latest.yml`。

**v0.1.5（测试中）**：插件备份删除（`plugins:deleteBackup`，备份名白名单 `\d{8}-\d{6}` 防路径穿越 + 面板每行删除按钮）+ 自更新版本比较改语义化（仅 latest > current 才提示，防测试版被误判降级）。测试包经 `-c <完整配置副本>.yml` + `directories.output` 输出到独立目录（注意：electron-builder 26 的 `-c` 是**替换**配置而非合并，缺失 files/extraResources 会把整个项目打进 asar——8.2GB asar 事故）。

**v0.2.0（已发布 2026-08-16）**：**WSL 后端 + 文件桥**（见 §4.7/§4.8）。已在真实发行版（Ubuntu，默认用户，sudo 免密）完成 PoC 与部署冒烟：npm 装 dsh 走 npmmirror（1 分钟 532 包）、启动 → HTTP 200 → 进程组停止零残留。应用内自动换阿里 apt 源 + 装 build-essential（node-pty 编译必需）。**实测修复链**：①WSL 独立端口 `wslPort`（默认 3081）；②启动互斥 + 健康探测验证 dsh 响应；③文件桥盘符根 + localStorage 位置记忆；④「从本机同步插件与数据」→ WSL（配置层 + pnpm 重建，失败自动降级标准默认组合）；⑤`.credentials.yaml` 在 WSL 内致 dsh 启动卡死 → 启动前移走 + API Key env 注入；⑥降级 package.json 必须用 dsh 标准形态（`dsh-profile-web` + dsh-base/dsh-web-app bundles，空壳会卡死）；⑦主窗口 URL 动态随端口/后端重导航（openMain URL 比较 + reloadMain）；⑧WSL 启动后主窗口不弹（openMain 守卫适配 wslIsRunning）。

---

## 3. 本机环境（接手者必须知道）

- **Windows 11**（bash = Git Bash）。工作目录路径可能含中文/空格，写脚本注意编码与引号。
- **自定义 CA 代理**：Node 的 fetch/https 会抛 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。
  → **所有外部 HTTP 请求一律走系统 `curl`**（见 `src/main/net.ts` 的 `curlJson`，`spawn('curl', ...)`）。不要再引入 fetch。
- 系统全局 node = v26；**应用自带** `resources/node/node.exe`（v22.21.1）和 `resources/pnpm`（11.21.0）。构建期用自带 node/pnpm 保持一致。
- 环境变量 `ELECTRON_RUN_AS_NODE=1` 存在 → 用 `env -u ELECTRON_RUN_AS_NODE` 才能当真正 Electron 运行。
- electron/npm 走 npmmirror 镜像（`.npmrc` 里的 `electron_mirror` 等，npm 会 warn 但无碍）。

---

## 4. 关键机制与坑（都是踩出来的）

### 4.1 数据目录 / 便携 vs 安装版（`settings.ts`）
- 安装版（装在 Program Files 下）→ 数据在 `%APPDATA%\dsh-desktop`（userData）。
- 便携/绿色版 → 数据在 exe 同级 `data/`；单文件便携用 `PORTABLE_EXECUTABLE_FILE` 取原始路径。
- `dshHome()` = `dataDir()/dsh-home`（dsh 的 `$DSH_HOME`，profile/插件/预设/会话都在这里）。
- 卸载 NSIS 版 **不会清 AppData 数据**；v0.1.3 卸载器可勾选删除。

### 4.2 插件系统（`plugin-manager.ts`）
- 插件装到 `$DSH_HOME/profiles/web`（profile），`pnpm add` 写 `package.json` 依赖。
- **bundle 机制**：包声明 `dsh.bundle.patch` 才算可激活 profile 层 → `reconcileBundles` 把包名写进 `pkg.dsh.profile.bundles`，dsh 启动时按序合成（`cordis.yml` 是占位，运行时合成不落盘；用 `dsh web --dump-config` 查合成结果）。
- **pnpm 11 默认拦截依赖构建脚本** → `ERR_PNPM_IGNORED_BUILDS`（致命，exit 1）。修复：解析被拦包名，写入 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds: {name: true}`，重试最多 3 轮。
  - **`allowBuilds` 是「开关」**：一旦定义了 `allowBuilds`（哪怕只有几条），pnpm 进入**严格模式**——任何未批准的构建脚本都是致命错误；反之（完全没有 `allowBuilds` 段）pnpm 是宽松模式，只警告不失败（`~/.dsh` 那种环境就因此装 git 包不报错）。
  - `@scope/pkg` 这类 key 必须加引号：`"@scope/pkg": true`（`yamlKey()`）。
  - **git 依赖的 key 格式**：`"@name@git+https://...git"` —— 带 `@name@` 前缀、去掉 `#commit`、加引号。pnpm 用 `getGitRepoAllowBuildKeyFromDepPath` 匹配（name 匹配对 git 依赖无效，因 trustPackageIdentity 为 false）。见 `ignoredBuildKey()`。
  - package.json 里 `pnpm.onlyBuiltDependencies` 已被 pnpm 11 **忽略**（构建时会有 WARN），别依赖它。
- **minimumReleaseAge**：pnpm 11 默认拦截「太新」的包（防供应链攻击）→ 常把包钉到旧版（如 dsh-better-sidebar 首装成 0.11.0）。对策：显式装版本号 `pnpm add pkg@x.y.z`，或让 pnpm 自动写 `minimumReleaseAgeExclude`。
- **两个 dsh 世界（重要）**：裸 `dsh` 命令默认 `DSH_HOME=~/.dsh`；应用用 `%APPDATA%\dsh-desktop\dsh-home`。用 CLI 管理**应用**的插件必须 `DSH_HOME="<dataDir>\dsh-home" dsh plugin --profile web add ...`，或用应用插件面板。用户已踩过（装进 `~/.dsh` 应用看不到）。
- git 装一个根目录没有 package.json 的仓库（如「套装」型：submodule + install.ps1）→ pnpm 生成占位包 → `inspectInstalled` 检测 `_pnpmPlaceholder` 并明确报错。**「套装」型仓库要按仓库自己的机制装**（如 dsh-routing-suite：clone --recurse-submodules + release tgz 装配 injector + 复制 preset 到 `$DSH_HOME/.agent-presets/<id>`），不能走 pnpm。
- 装插件成功 → 自动 `restartForPluginChange`（重启 dsh + reload 主窗口）。

### 4.3 NSIS 定制（`resources/installer.nsh` + electron-builder）
- `nsis.include`（默认名 `installer.nsh`，放 buildResources）会 `!include` 进**共享 header**，安装器/卸载器**分开编译**（`BUILD_UNINSTALLER` define）。
- 共享 header 在模板之前解析 → 必须自带 `!include "LogicLib.nsh"` / `"nsDialogs.nsh"`（防重入，安全）。
- `Var /GLOBAL` 不能放 `customHeader` 宏里（模板里晚于本文件展开）→ 直接放文件顶层，且按 `BUILD_UNINSTALLER` 分编译段，避免 `-WX`（warning 当 error）报「未引用函数/变量」。
- 安装器加页用 `customPageAfterChangeDir`（顶层插入点，只能放 `Page custom`，不能放运行时指令）；卸载器换页用 `customUnWelcomePage`。
- `${isUpdated}`/`${Silent}` 是运行时 LogicLib 测试，只能在函数/段里用；`${isUpdated}` 内部走 `StdUtils` 插件，而 `!addplugindir` 顺序不定 → 别在 header 里用 StdUtils 依赖的东西（nsDialogs 是默认插件目录，安全）。
- 卸载器删数据：勾选后 `customUnInstall` 里 `RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"`；静默模式由模板内置 `--delete-app-data` 处理。

### 4.4 Electron 二进制
- PowerShell `Expand-Archive` 解 electron zip **不完整**（只出部分文件，窗口空白）。必须用 `node_modules/electron-winstaller/vendor/7z.exe` 完整解压。固化脚本：`npm run electron:restore`（`scripts/restore-electron.mjs`，curl 下载 + 7z 解压 + sentinel 校验）。
- electron-builder 会硬编码排除 extraResources 顶层 node_modules → 通过嵌套 `resources/` 子目录绕过（`resources/node` 等）。

### 4.5 dsh 本体
- 启动：`node <dsh-bin> --profile web --port 3080`，`DSH_HOME` = dataDir/dsh-home。入口 `node_modules/@deepseek-ai/dsh/lib/bin.js`。
- dsh API 走 **WebSocket `/api/rpc`**；REST `/api/*` 返回 404 是**预期行为**，不是 bug。
- 查合成树：`DSH_HOME=... node lib/bin.js web --dump-config`。
- 插件管理：`dsh plugin --profile web add <pkg|本地目录>`（转发 pnpm + 自动 reconcile bundles）。

### 4.6 应用自更新（v0.1.4+，`updater.ts`）
- **硬约束**：查版本走 `curlJson`（GitHub API）；下载二进制用 `spawn('curl', ['-sS','-L','--fail','--retry','3','-o',part,url])`。Node fetch/https 在自定义 CA 代理下不可用，别换。
- **版本判定**：`releases/latest` 的 `tag_name`（去 `v`）与 `app.getVersion()` 字符串比对；只认名字匹配 `-setup.exe` 的资产（NSIS 安装包，artifactName `${productName}-${version}-setup.${ext}`）。
- **下载**：到 `<dataDir>/updates/dsh-desktop-<version>-setup.exe`（在数据目录，升级不丢）；校验 = 文件大小与资产 size 一致 + 不小于 1MB；进度由主进程轮询 `.part` 文件（300ms）推 `app:updateProgress`。
- **安装**：`spawn(installer, ['/S','--force-run'], {detached:true, stdio:'ignore'})` + `unref()` → 1s 后 `quitting=true; app.quit()`（before-quit 停 dsh 服务）。NSIS 模板等旧进程退出后替换文件，`--force-run` 装完自动拉起新版本。**v0.2.0 起：WSL 后端运行时先 stopServer 再启动安装器**（避免新实例端口冲突）。
- **发布联动**：`electron-builder --win` 因 publish 配置（`csyyywy/dsh-desktop`）会在 dist 生成 `latest.yml`（升级信息），gh release create 时一并上传（当前内置更新器不依赖它，留作 electron-updater 备用通道）。

### 4.7 WSL 后端（v0.2.0，`wsl.ts` / `server.ts` / `dsh-manager.ts` / `plugin-manager.ts`）

**架构**：dsh 运行在 WSL2 发行版内（数据在发行版 `~/.dsh-desktop`，与 Windows dataDir 语义镜像：`node/` Linux Node、`pnpm/` 纯 JS、`node_modules/` npm --prefix 安装、`dsh-home/`=$DSH_HOME、`backups/plugins/`、`dsh.pid`（存 `<pid> <pgid>`）、`logs/dsh.log`）。Windows 侧经 UNC `\\wsl.localhost\<distro>\...` 读写（仅非关键批量操作）。

**必须知道的坑（全部 PoC 实测）**：
- **dsh 只监听 127.0.0.1**（`dsh-host-webserver` Config 仅允许 127.0.0.1/0.0.0.0；`dsh-web-app` 显式拒绝 `--host 0.0.0.0` 防 RCE）。→ Windows 访问 WSL dsh 的**唯一通道是 WSL2 localhost 转发**（NAT=wslrelay；mirrored=回环共享）。`localhostForwarding=false`（.wslconfig）或 Windows 侧端口被占 → 启动前明确报错 + 指引。**没有 wslIp 兜底**（对回环监听无效）。
- **wsl.exe 输出默认 UTF-16LE**（中文系统乱码）→ spawn 一律 env `WSL_UTF8=1`；输出按 buffer 收，含 `\0` 按 utf16le 解码（双保险）。
- **受限令牌下 wsl.exe 报 E_ACCESSDENIED**（沙箱/提权环境）→ 应用正常令牌无碍；枚举调用必须容错并给指引。
- **wsl.exe 外层 shell 会预展开 `$`**：`$!` 被吃空、`$(id -un)` 依赖外层环境。→ `runWslBash` 统一把脚本中 `$` 转义为 `\$`，由内层 bash 展开。
- **外层 shell 会剥掉单引号**：含空格参数（pgrep/pkill pattern）断词。→ `bashQuote` 用**双引号形式**（转义 `\` `"` `$` 反引号）。
- **wsl 的 bash 是进程组长 → `setsid` 必然 fork → `$!` 不是进程组 id**。→ 启动后 `pgrep -u $(id -un) -f <pattern> | grep -vw $$ | head -1` 找实际 pid，`ps -o pgid=` 读 pgid，pidfile 存 `<pid> <pgid>`；停止 `kill -- -<pgid>`（组）→ 单 pid → 轮询 kill -0 → 残留 pkill（限用户）→ UI 强制清理。**绝不 terminate 发行版**（杀用户其他 WSL 进程）。`&` 是分隔符，**其后不能接 `;`/`&&`**（合并 `& sleep 1.5` 一行）。
- **npm/pnpm 安装必须 export PATH**（`~/.dsh-desktop/node/bin`）：postinstall 脚本（koffi/node-pty 等）用 `sh -c node`，PATH 缺失报 `node: not found`。
- **node-pty 等原生包需要 build-essential + python3**：backendSetup 自动检测并 apt 安装（自动换阿里源，失败容忍）；缺失时 npm install 会 node-gyp 失败。
- **Linux Node 部署**：构建期只存 `resources/node-linux.tar.xz`（不提前解压，~25MB），部署时 UNC 拷贝 → WSL 内 `tar -xJf --strip-components=1 -C node`（保留执行位）+ `chmod +x` 保险。
- **镜像**：npm 默认走 `https://registry.npmmirror.com`（设置面板可改）；WSL 内安装实测 1 分钟装完 532 包。
- **版本策略**：WSL 首次部署/无参更新 = `settings.dshVersion` 显式值 ?? 内置 bundle 版本（`resources/dsh-bundle`，构建期固化），**不自动 latest**；显式选版本才升级。
- **备份原子性**：WSL 模式插件安装/卸载/回退 = 记录 wasRunning → stop → 快照（UNC cpSync，失败回退 `wsl cp -r`）→ 恢复原运行状态。
- 状态原语（pidfile/kill -0/残留）**必须走 wsl.exe**（实时+权限正确），不用 UNC（9P 偶发 EPERM/延迟）。

### 4.8 文件桥（v0.2.0，`fs-bridge.ts`）
- 双端浏览（win 原生 / wsl 经 UNC），路径在 IPC 中始终 Linux 形态；UNC 只由 `toUnc` 构造（不信任渲染层拼接）。
- **可中断流式复制**：64KB 块 + 背压；目标写 `<name>.dshpart`，成功 rename 落名（冲突默认拒绝/可覆盖）；取消/失败 destroy 流 + 删 .dshpart（**不残留半成品**）。`rs.destroy()` 无参不触发 error 事件——取消靠 data 轮询 flag（已实现）。
- 并发上限 2，其余排队（进度事件含 queued）；同侧移动优先 `fs.rename`（EXDEV 回退复制+删源）。
- `translate`：返回 `windows`（UNC，任意 WSL 路径有效）+ `windowsLocal`（wslpath -w 盘符映射，仅 /mnt/* 有效）+ `linux`；`\\wsl.localhost\`/盘符/`/` 开头四分支判定。
- 实测性能：UNC→本地 120MB/s、本地→UNC 102MB/s（1GB 约 8-10s），无需 wsl cp 混合模式。
- 拖拽：preload 经 `webUtils.getPathForFile` 取本地路径。

---

## 5. 构建与发布

```bash
npm run dev          # 开发态
npm run typecheck    # 双 tsconfig 类型检查
npm run pack:win     # 完整打包：icon → 下载 node/pnpm → 打包 dsh bundle → build → nsis+portable
```

发布（已在 v0.1.2/0.1.3 验证过）：
1. `npm run pack:win` → 产出 setup.exe / portable.exe / win-unpacked/。
2. 绿色版 zip：`rm -rf dist/DeepSeek\ Harness && cp -r dist/win-unpacked "dist/DeepSeek Harness"`，再用 `node_modules/electron-winstaller/vendor/7z.exe a -tzip -mx=1 "dist/DeepSeek Harness-0.1.x-win-x64.zip" "dist/DeepSeek Harness"`（zip 顶层含 `DeepSeek Harness\` 文件夹）。
3. `gh release create v0.1.x <三个产物> --title v0.1.x --notes-file <notes>`（gh 在 `/c/Program Files/GitHub CLI/gh.exe`）。
   - 自 v0.1.4 起（publish 已配置）多传 `dist/latest.yml`；应用内自更新走 API 直取安装包，不依赖它，但上传后可选切换 electron-updater。
4. release notes 放本地 `release-notes-v*.md`（如 `D:\宣传稿\` 之类自定位置）。

---

## 6. 本机当前运行状态（交接时刻）

- **应用**：安装在系统盘 `Program Files (x86)` 下某目录（测试版），数据在 `%APPDATA%\dsh-desktop`（安装版语义，保持现状不迁移）。
- **dsh 服务状态**：当前 **stopped**（无 node 进程、3080 无监听）。Electron 壳在跑（DeepSeek Harness.exe ×5 属正常）。
- **已装插件**（`$DSH_HOME/profiles/web`，全部已注册 bundle、`dump-config` 已合成，**均待服务重启生效**）：
  - `@linxin666/dsh-web-ui-all@0.1.12`（web UI 全家桶）
  - `@dsh-external/dsh-super-injector@0.3.3`（注入器，link 自本地 `release-injector/package`）
  - `dsh-better-sidebar@0.12.1`（VSCode 风格侧边栏工作台；node-pty 原生模块已构建）
  - `@sanqi-normal/dsh-webui-market-plugin`（git 装，market 插件）
- **预设**：`router-standard` 已复制到 `$DSH_HOME/.agent-presets/router-standard/`。
- **`~/.dsh` 独立世界**：用户在 PowerShell 直接 `dsh plugin add` 建过（含 market-plugin 一份），与应用世界无关，**用户保留不清理**。
- **待办**：重启 dsh 服务（`dev_plugin_status` 验证注入器；侧边栏应出现 better-sidebar 工作台；新会话可选 Router Standard 预设）。
- **装注入器的来源**：本地 `release-injector/package`（从 yjh051108/dsh-super-injector v0.3.3 release tgz 解压，免构建）。套装仓库 `dsh-routing-suite/`（含 submodule，本地自维护）。

---

## 7. 建议给接手者的验证路径

1. 改动主进程/渲染进程后先 `npm run typecheck`。
2. 涉及外部请求的改动，用 `curlJson`（net.ts），别用 fetch。
3. 涉及 NSIS 的改动，跑 `npx electron-builder --win nsis` 验证编译（不跑全量）。
4. 涉及插件安装的改动，先在沙箱 profile 里用自带 node+pnpm 复现（如 `@linxin666/dsh-web-ui-all` 依赖 ssh2/cloudflared，会触发构建脚本拦截）。
5. 改完发布走第 5 节流程。

## 8. 联系方式 / 背景

- 目标：让 dsh-desktop 成为稳定、可自更新、不破坏 dsh 插件生态的桌面入口。
- 开源动机：发布到 GitHub 公开仓库；不写宣传帖。
- 有疑问先看本文件 + git 提交信息 + `src/main/*` 注释（关键坑都写在代码注释里）。
