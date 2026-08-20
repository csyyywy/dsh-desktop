import { describe, expect, it } from 'vitest'
import {
  extractDuplicateLoaderEntryId,
  extractFailureCause,
  extractOffendingPlugins,
  extractSlotConflictName,
  isActionablePluginReference,
  isPackageReference
} from '../src/main/plugin-recovery-detection'

describe('isPackageReference', () => {
  it('接受普通与 scoped 包名', () => {
    expect(isPackageReference('dsh-better-sidebar')).toBe(true)
    expect(isPackageReference('@sanqi-normal/dsh-webui-market-plugin')).toBe(true)
  })
  it('拒绝内部标识与空串', () => {
    expect(isPackageReference('cordis:include')).toBe(false)
    expect(isPackageReference('')).toBe(false)
    expect(isPackageReference('  ')).toBe(false)
  })
})

describe('isActionablePluginReference', () => {
  it('排除核心 bundle 与 @deepseek-ai/*', () => {
    expect(isActionablePluginReference('@deepseek-ai/dsh-base')).toBe(false)
    expect(isActionablePluginReference('@deepseek-ai/dsh-web-app')).toBe(false)
    expect(isActionablePluginReference('dshmarket')).toBe(false)
    expect(isActionablePluginReference('@deepseek-ai/dsh')).toBe(false)
  })
  it('保留第三方插件', () => {
    expect(isActionablePluginReference('dsh-better-sidebar')).toBe(true)
    expect(isActionablePluginReference('@linxin666/dsh-web-ui-all')).toBe(true)
  })
})

describe('extractFailureCause', () => {
  it('优先取 DSH entry failed', () => {
    const lines = ['[stderr] DSH entry failed: cannot resolve profile bundle "@bad/plugin"', '[stderr] bootstrap']
    expect(extractFailureCause(lines)).toBe('cannot resolve profile bundle "@bad/plugin"')
  })
  it('取 uncaught exception', () => {
    const lines = ['[stderr] hello', 'uncaught exception: TypeError: x is not a function']
    expect(extractFailureCause(lines)).toBe('TypeError: x is not a function')
  })
  it('回退到最后的错误行', () => {
    const lines = ['[stderr] warn something', '[stderr] Error: boom']
    expect(extractFailureCause(lines)).toBe('Error: boom')
  })
})

describe('extractOffendingPlugins', () => {
  it('从 loader entry 失败提取包名', () => {
    const lines = ['[stderr] failed to apply loader entry 1 (@linxin666/dsh-web-ui-all)']
    expect(extractOffendingPlugins(lines)).toContain('@linxin666/dsh-web-ui-all')
  })
  it('跨行提取「Failed to load plugins」错误卡清单', () => {
    const lines = ['[stderr] Failed to load plugins', '@bad/plugin', 'dsh-other', '', '[stderr] rest']
    const list = extractOffendingPlugins(lines)
    expect(list).toContain('@bad/plugin')
    expect(list).toContain('dsh-other')
    expect(list).not.toContain('rest')
  })
  it('错误卡中排除核心 bundle', () => {
    const lines = ['[stderr] Failed to load plugins', '@deepseek-ai/dsh-base', 'dsh-better-sidebar']
    const list = extractOffendingPlugins(lines)
    expect(list).not.toContain('@deepseek-ai/dsh-base')
    expect(list).toContain('dsh-better-sidebar')
  })
  it('提取 plugin(s) failed to load', () => {
    const lines = ['[stderr] plugin(s) failed to load: @scope/bad']
    expect(extractOffendingPlugins(lines)).toContain('@scope/bad')
  })
})

describe('extractDuplicateLoaderEntryId', () => {
  it('提取 loader 条目 id', () => {
    expect(extractDuplicateLoaderEntryId(['duplicate loader entry id: "storage"'])).toBe('storage')
  })
  it('保留内部标识（不直接卸载）', () => {
    expect(extractDuplicateLoaderEntryId(['duplicate loader entry id: cordis:include'])).toBe('cordis:include')
  })
})

describe('extractSlotConflictName', () => {
  it('single slot 冲突', () => {
    expect(extractSlotConflictName(['single slot "sidebar/api" already has a registration'])).toBe('sidebar/api')
  })
  it('UI slot 重复注册', () => {
    expect(extractSlotConflictName(['UI slot "x" has duplicate registrations'])).toBe('x')
  })
  it('duplicate prefix route', () => {
    expect(extractSlotConflictName(['duplicate prefix route "/sidebar/api"'])).toBe('/sidebar/api')
  })
})
