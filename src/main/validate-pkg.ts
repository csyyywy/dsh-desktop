// 包名 / 安装 spec 白名单（零依赖，供 plugin-manager 与恢复通道共用，可单测）。
// 背景：IPC 直传的字符串会拼进 pnpm argv——拒绝 `-` 开头（pnpm 旗标注入）
// 与空白/引号/shell 元字符；scoped 包名以 @ 开头（如 @scope/pkg）必须放行。

/** 合法 npm 包名（含 scoped）：首字符 @ 或字母数字，后续可含 . _ / @ - */
export function isSafePkgName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 214 && /^[@a-z0-9][a-z0-9._/@-]*$/i.test(name)
}

export function assertSafeName(name: string): void {
  if (!isSafePkgName(name)) {
    throw new Error(`非法的包名: ${String(name).slice(0, 80)}`)
  }
}

/** 安装 spec（npm 包名或 git/https 地址）：拒绝 `-` 开头与元字符 */
export function assertSafeSpec(spec: string): void {
  if (
    typeof spec !== 'string' ||
    spec.length === 0 ||
    spec.length > 500 ||
    spec.startsWith('-') ||
    /[\s"'`$;&|<>]/.test(spec)
  ) {
    throw new Error(`非法的安装地址: ${String(spec).slice(0, 80)}`)
  }
}
