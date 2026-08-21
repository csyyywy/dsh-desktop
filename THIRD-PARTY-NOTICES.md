# 第三方致谢（Third-Party Notices）

本项目（csyyywy/dsh-desktop）基于 MIT License 发布。

## 运行时随包分发的 npm 组件（MIT）

以下组件经 vite 编译后随应用产物分发，按 MIT 许可要求保留其版权与许可声明：

- **react**（https://github.com/facebook/react）— Copyright (c) Meta Platforms, Inc. and affiliates.
- **react-dom**（https://github.com/facebook/react）— Copyright (c) Meta Platforms, Inc. and affiliates.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- **tailwindcss**（https://github.com/tailwindlabs/tailwindcss）— Copyright (c) Tailwind Labs, Inc.（MIT，许可文本同上）

## 内置运行时（随安装包分发）

- **Node.js**（https://nodejs.org）— MIT 及随包 LICENSE 文件（resources/node/LICENSE，含第三方组件清单）。
- **pnpm**（https://pnpm.io）— MIT（LICENSE 随 resources/pnpm 附带）。
- **@deepseek-ai/dsh** — MIT（LICENSE 随 resources/dsh-bundle 附带）。
- **Electron / Chromium** — electron-builder 自动附带 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

---

v0.3.0 的部分功能实现参考了以下 MIT 开源项目的思路与方法（实现为等价功能，未整体复制其源码）。按 MIT 许可要求，在此保留其版权与许可声明并致谢。

## dataelement/dsh-desktop（MIT）

- 项目：https://github.com/dataelement/dsh-desktop
- 参考内容：启动失败恢复（#81 重置数据 / #94 插件冲突自动识别与一键卸载 / #96 恢复态机与稳定健康窗口 / #98 内部加载器故障的插件恢复映射），本项目的 `src/main/plugin-recovery-detection.ts` / `src/main/plugin-recovery.ts` / `src/renderer/src/RecoveryActions.tsx` / `src/preload/main-window-preload.ts` 据此实现。
- MIT 许可文本：

```
MIT License

Copyright (c) 2026 dataelement

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## mishibeikejie/zat-dsh-engine（MIT）

- 项目：https://github.com/mishibeikejie/zat-dsh-engine
- 参考内容：插件市场/搜索与安装的「预安装冲突门禁 + 健康检查」思路，本项目的插件安装冲突预检（`src/main/plugin-manager.ts` 的 `preflightPluginInstall`）据此实现。
- MIT 许可文本：

```
MIT License

Copyright (c) 2026 mishibeikejie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
