import { describe, expect, it } from 'vitest'
import { assertSafeName, assertSafeSpec, isSafePkgName } from '../src/main/validate-pkg'

describe('isSafePkgName / assertSafeName', () => {
  it('放行常规与 scoped 包名', () => {
    expect(isSafePkgName('dsh-plugin-x')).toBe(true)
    // 回归用例：v0.3.1 的白名单要求首字符为字母数字，误伤了 @scope/pkg 形态的 scoped 包
    expect(isSafePkgName('@lk251066/dsh-tui')).toBe(true)
    expect(isSafePkgName('@scope/pkg.name-1')).toBe(true)
    expect(isSafePkgName('a')).toBe(true)
  })
  it('拒绝旗标注入、元字符、空值与超长', () => {
    expect(isSafePkgName('--frozen-lockfile')).toBe(false)
    expect(isSafePkgName('-x')).toBe(false)
    expect(isSafePkgName('a b')).toBe(false)
    expect(isSafePkgName('a;b')).toBe(false)
    expect(isSafePkgName("a'b")).toBe(false)
    expect(isSafePkgName('')).toBe(false)
    expect(isSafePkgName(null)).toBe(false)
    expect(isSafePkgName(42)).toBe(false)
    expect(isSafePkgName('x'.repeat(215))).toBe(false)
  })
  it('assertSafeName 对非法名抛错', () => {
    expect(() => assertSafeName('--rm')).toThrow()
    expect(() => assertSafeName('@scope/ok')).not.toThrow()
  })
})

describe('assertSafeSpec', () => {
  it('放行 npm 名与 git 地址，拒绝旗标与元字符', () => {
    expect(() => assertSafeSpec('@scope/pkg')).not.toThrow()
    expect(() => assertSafeSpec('git+https://github.com/u/p')).not.toThrow()
    expect(() => assertSafeSpec('--ignore-scripts')).toThrow()
    expect(() => assertSafeSpec('a`b')).toThrow()
    expect(() => assertSafeSpec('a&b')).toThrow()
    expect(() => assertSafeSpec('')).toThrow()
  })
})
