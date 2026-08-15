# dsh-desktop 项目交接文档

> 本文档供接续开发者 / agent 接手 **dsh-desktop** 项目使用。
> 记录了项目现状、本机环境、关键机制与踩过的坑。
> 最后更新：2026-08-15（v0.1.3 发布后）。

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
- 应用自更新面板存在，但 electron-builder `publish` 配置仍注释掉（app-update.yml 由 package.json repository 生成）。当前靠手动下载新 setup 更新。
- 内置 dsh bundle（`resources/dsh-bundle`）在构建期 npm install 打包，版本随构建固化；应用「更新 dsh」走在线 npm 安装。
- `dsh.profile.bundles` 的插件装配只在 dsh 启动时生效，HMR 不处理新增 bundle 层 → 装插件必须重启服务（已由 `restartForPluginChange` 自动做）。

---

## 3. 本机环境（接手者必须知道）

- **Windows 11**（bash = Git Bash）。路径含中文（`d:\ai\测试\...`），写脚本注意编码。
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
- **两个 dsh 世界（重要）**：裸 `dsh` 命令默认 `DSH_HOME=~/.dsh`；应用用 `%AppData%\dsh-desktop\dsh-home`。用 CLI 管理**应用**的插件必须 `DSH_HOME="C:\Users\1\AppData\Roaming\dsh-desktop\dsh-home" dsh plugin --profile web add ...`，或用应用插件面板。用户已踩过（装进 `~/.dsh` 应用看不到）。
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
4. release notes 放 `d:\ai\测试\宣传稿\release-notes-v*.md`。

---

## 6. 本机当前运行状态（交接时刻）

- **应用**：装在 `D:\Program Files (x86)\1\DeepSeek Harness`，当前是 **20:02 测试版**（缺 F5/自动刷新）。**用户选择暂不更新**；已发布 v0.1.3（20:20）含刷新修复，另有 `f251ee2`（git 构建自动放行）未发版（可打 v0.1.4）。数据在 `C:\Users\1\AppData\Roaming\dsh-desktop`（保持现状不迁移）。
- **dsh 服务状态**：当前 **stopped**（无 node 进程、3080 无监听）。Electron 壳在跑（DeepSeek Harness.exe ×5 属正常）。
- **已装插件**（`$DSH_HOME/profiles/web`，全部已注册 bundle、`dump-config` 已合成，**均待服务重启生效**）：
  - `@linxin666/dsh-web-ui-all@0.1.12`（web UI 全家桶）
  - `@dsh-external/dsh-super-injector@0.3.3`（注入器，link 自 `d:\ai\测试\dsh-routing-suite\release-injector\package`）
  - `dsh-better-sidebar@0.12.1`（VSCode 风格侧边栏工作台；node-pty 原生模块已构建）
  - `@sanqi-normal/dsh-webui-market-plugin`（git 装，market 插件）
- **预设**：`router-standard` 已复制到 `$DSH_HOME/.agent-presets/router-standard/`。
- **`~/.dsh` 独立世界**：用户在 PowerShell 直接 `dsh plugin add` 建过（含 market-plugin 一份），与应用世界无关，**用户保留不清理**。
- **待办**：重启 dsh 服务（`dev_plugin_status` 验证注入器；侧边栏应出现 better-sidebar 工作台；新会话可选 Router Standard 预设）。
- **装注入器的来源**：`d:\ai\测试\dsh-routing-suite\release-injector\package`（从 yjh051108/dsh-super-injector v0.3.3 release tgz 解压，免构建）。套装仓库 `d:\ai\测试\dsh-routing-suite\`（含 submodule）。

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
