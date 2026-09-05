# DeepSeek Harness 桌面客户端（dsh-desktop）

把 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek 开源的 agent harness，架构「一切皆插件」）打包成 Windows 本地桌面程序。

## 设计原则

- **原样运行官方 `@deepseek-ai/dsh`**：不 fork、不改源码、不注入其前端，插件 / 配置体系完整保留，官方升级无缝跟随。
- **Electron 外壳**只负责「安装 / 启动 / 系统托盘 / 一键更新 / 设置 / 日志」，Web UI 用原生窗口承载。
- **内置便携 Node v22**：绿色版解压即用，无需系统预装 Node。

## 功能

- 首次启动从内置包恢复 dsh（**无需联网安装**，内置 **0.1.2-rc.1**），随后启动 `dsh web` 并打开原生窗口。dsh ≥ 0.1.2 的 Web 界面一次性 token 认证由外壳自动处理（从服务输出解析 launch token，持久 cookie 免重复认证）。
- 系统托盘：打开 Harness / 仪表盘 / 启动·停止 / 退出；关闭窗口最小化到托盘、服务后台常驻。
- 仪表盘：状态 / 设置（端口、工作区、API Key、版本、开机自启、**自定义背景**）/ 更新（一键升级 + 历史版本回滚）/ 日志 / **插件管理器** / **备份与回退**（独立面板，手动存档 + 自动快照）。
- **插件管理器**：浏览/搜索官方插件仓库（GitHub topic `dsh-plugin` / npm `dsh-plugin`，相关性过滤排序），一键安装（git 安装）/卸载；**安装前冲突预检**（同名/重复注册先报告）；内置 pnpm 离线可用；每次安装/卸载前自动备份。
- **端口自愈**：端口被本应用残留进程占用时自动释放；被其他程序占用时自动切换并保存。
- **WSL 后端**（可选）：一键部署发行版内运行环境，dsh 跑在 WSL 里、窗口仍在本机；「从本机同步」迁移配置/插件/会话。
- ~~**文件桥**：Windows ↔ WSL 双向文件浏览/复制/移动/重命名/删除与路径转换~~（v0.3.4 暂时下架，代码保留，`Dashboard.tsx` 的 `SHOW_FILE_BRIDGE` 开关可恢复）。
- **启动失败恢复**：自动识别问题插件 → 一键「卸载并重试」；支持「重置数据」（备份后重建）；内部加载器故障也能映射回真实插件包。

## 目录结构

```
dsh-desktop/
├── src/main/           # Electron 主进程（窗口/托盘/IPC/生命周期 + dsh 安装/进程管理）
├── src/preload/        # contextBridge 类型化桥接
├── src/renderer/       # 外壳 UI（splash + 仪表盘，React + Tailwind）
├── scripts/            # download-node.mjs（下载便携 Node）、make-icon.mjs（图标栅格化）
├── resources/          # icon.svg（黑色鲸鱼标志）、icons/、node/（构建产物）
├── data/               # 运行时数据（dsh 安装 + $DSH_HOME），绿色版位于 exe 同级
└── electron-builder.yml
```

## 开发

```sh
npm install       # 依赖（Electron 等；国内网络走 npmmirror，见 .npmrc）
npm run dev       # electron-vite 开发模式
npm run typecheck
npm test          # vitest 单元测试
```

## 打包

```sh
npm run pack:win  # 产出 dist/ 下的三种形态
```

产物：

| 文件 | 说明 |
|---|---|
| `dist/win-unpacked/` | 免安装绿色版文件夹（解压即用） |
| `dist/DeepSeek-Harness-<ver>-setup.exe` | NSIS 安装器（开始菜单/桌面快捷方式/卸载） |
| `dist/DeepSeek-Harness-<ver>-portable.exe` | 单文件便携版 |

发布时另打绿色 zip（`tar -a` 打 zip 实为存储不压缩，必须用自带 7z，`-mx=9` 体积最小）：
`node_modules/electron-winstaller/vendor/7z-x64.exe a -tzip -mx=9 dist/DeepSeek-Harness-<ver>-portable-win-x64.zip dist/win-unpacked`。

> 首次打包需下载 Electron 与便携 Node，耗时较长；国内网络下 `.npmrc` 与 `pack` 脚本已配置 npmmirror 镜像。

## 配置与扩展

- **数据目录**（配置 / 插件 / 会话）由外壳指向 `$DSH_HOME`：
  - 绿色版 / 便携版：exe 同级 `data/dsh-home/`
  - 安装版：`%APPDATA%/dsh-desktop/dsh-home/`（可用环境变量 `DSH_DESKTOP_DATA_DIR` 覆盖）
- **插件**：仪表盘「插件」页可浏览 npm `dsh-plugin` 官方仓库、搜索、一键安装/卸载；底层用内置 pnpm 写入 `$DSH_HOME/profiles/web` 并维护 `dsh.profile.bundles`。也可继续用 `dsh plugin --profile web <pnpm 参数>` 命令行管理。
- **用户配置**：`$DSH_HOME/cordis.patch.yml`（与官方机制一致，不影响升级）。
- **dsh 版本**：设置里可锁定 / 回滚（默认 latest），缓解 developer preview 的破坏性变更。
- **应用外壳自更新**：设置里填写 `appUpdateRepo`（`owner/repo`），更新面板即检查 GitHub Releases。

## 说明

- dsh 处于 developer preview，**存在破坏性变更**；用「更新 → 回滚」应对。
- 内置 Node v22（npm 10）供 dsh 本体安装使用，无 npm 脚本拦截问题；**插件安装走内置 pnpm 11**，其默认拦截依赖构建脚本（`ERR_PNPM_IGNORED_BUILDS`），应用会自动放行并重试，无需手动干预。
- **许可与致谢**：本项目 MIT。v0.3.0 的启动恢复与插件冲突检测参考了 MIT 项目 dataelement/dsh-desktop（#81/#94/#96/#98）与 mishibeikejie/zat-dsh-engine 的实现思路，详见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
