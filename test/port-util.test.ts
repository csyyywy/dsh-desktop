import { describe, expect, it } from 'vitest'
import { parseNetstatPids } from '../src/main/port-util'

describe('parseNetstatPids', () => {
  const sample = `  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1256
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:3080         127.0.0.1:54321        ESTABLISHED     1234
  TCP    [::]:3080              [::]:0                 LISTENING       4321
  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       9999
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       7777
  UDP    0.0.0.0:3080           *:*                                    0
`
  it('提取监听指定端口的所有 PID（含通配/IPv6/多 PID）', () => {
    const pids = parseNetstatPids(sample, 3080)
    expect(pids).toContain(1234)
    expect(pids).toContain(4321)
    expect(pids).toContain(7777)
    expect(pids).not.toContain(9999) // 3081 不算
    expect(pids).not.toContain(0) // 忽略 System/UDP 行
    expect(pids).not.toContain(1256) // 135 不算
  })
  it('无匹配返回空', () => {
    expect(parseNetstatPids(sample, 9999)).toEqual([])
    expect(parseNetstatPids('', 3080)).toEqual([])
  })
})
