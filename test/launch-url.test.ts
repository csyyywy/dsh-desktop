// launch-url 纯逻辑单测：dsh ≥ 0.1.2 Web UI launch token 的解析与版本判断
import { describe, expect, it } from 'vitest'
import { dshHasWebAuth, extractLaunchUrl } from '../src/main/launch-url'

describe('extractLaunchUrl', () => {
  it('解析 dsh web 打印的标准 token URL', () => {
    const line = 'dsh web: http://127.0.0.1:3080/?token=Abc123_-xyz'
    expect(extractLaunchUrl(line)).toBe('http://127.0.0.1:3080/?token=Abc123_-xyz')
  })

  it('忽略行尾 (LAN: …) 后缀，且不误取 LAN 地址', () => {
    const line = 'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.2:3080/?token=abc123)'
    expect(extractLaunchUrl(line)).toBe('http://127.0.0.1:3080/?token=abc123')
  })

  it('取最后一条（WSL 日志跨启动追加，最新 token 在后）', () => {
    const log = [
      'dsh web: http://127.0.0.1:3081/?token=old',
      'dsh web: http://127.0.0.1:3081/?token=new'
    ].join('\n')
    expect(extractLaunchUrl(log)).toBe('http://127.0.0.1:3081/?token=new')
  })

  it('token 含 base64url / 百分号编码 / padding 字符', () => {
    const url = 'http://127.0.0.1:3080/?token=a-b_C.d~e%2Bf=g='
    expect(extractLaunchUrl(`dsh web: ${url}`)).toBe(url)
  })

  it('无 token URL 时返回 null', () => {
    expect(extractLaunchUrl('dsh web: listening on port 3080')).toBeNull()
    expect(extractLaunchUrl('')).toBeNull()
  })

  it('非 127.0.0.1 的地址不认', () => {
    expect(extractLaunchUrl('dsh web: http://localhost:3080/?token=abc')).toBeNull()
    expect(extractLaunchUrl('dsh web: https://127.0.0.1:3080/?token=abc')).toBeNull()
  })
})

describe('dshHasWebAuth', () => {
  it('0.1.2 及以上（含预发布）启用 token 认证', () => {
    expect(dshHasWebAuth('0.1.2-rc.1')).toBe(true)
    expect(dshHasWebAuth('0.1.2-alpha.5')).toBe(true)
    expect(dshHasWebAuth('0.1.2')).toBe(true)
    expect(dshHasWebAuth('0.1.10')).toBe(true)
    expect(dshHasWebAuth('0.2.0')).toBe(true)
    expect(dshHasWebAuth('1.0.0')).toBe(true)
  })

  it('0.1.1 及以下未启用', () => {
    expect(dshHasWebAuth('0.1.1-rc.2')).toBe(false)
    expect(dshHasWebAuth('0.1.0-rc.8')).toBe(false)
    expect(dshHasWebAuth('0.1.0')).toBe(false)
    expect(dshHasWebAuth('0.0.9')).toBe(false)
  })

  it('空值 / 非法版本返回 false', () => {
    expect(dshHasWebAuth(null)).toBe(false)
    expect(dshHasWebAuth(undefined)).toBe(false)
    expect(dshHasWebAuth('')).toBe(false)
    expect(dshHasWebAuth('latest')).toBe(false)
  })

  it('容忍 v 前缀与首尾空白', () => {
    expect(dshHasWebAuth(' v0.1.2-rc.1 ')).toBe(true)
    expect(dshHasWebAuth('v0.1.1')).toBe(false)
  })
})
