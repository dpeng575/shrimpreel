import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mp4DurationSeconds, sniffVideoType } from '#/server/media'

// 解析真实 mp4（seed 模板视频，moov 在文件头）：时长 = mvhd.duration / timescale
const seedVideo = () => new Uint8Array(readFileSync(join(import.meta.dirname, '../..', 'seed/templates/neon-shuffle-v1-6s.mp4')))

describe('mp4DurationSeconds', () => {
  it('解析 seed 模板视频：6 秒，类型识别为 video/mp4', () => {
    const bytes = seedVideo()
    expect(sniffVideoType(bytes)).toBe('video/mp4')
    expect(mp4DurationSeconds(bytes)).toBeCloseTo(6, 1)
  })

  it('不是 mp4 / 缺 moov / 缺 mvhd：返回 null 而不是抛异常', () => {
    expect(mp4DurationSeconds(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBeNull()
    const bytes = seedVideo()
    // 截断到只剩 ftyp：没有 moov
    expect(mp4DurationSeconds(bytes.slice(0, 32))).toBeNull()
    // ftyp 后接一段伪 box（无 moov）
    const fake = new Uint8Array(64)
    fake.set([0, 0, 0, 32], 0)
    fake.set([0x66, 0x74, 0x79, 0x70], 4) // ftyp
    fake.set([0, 0, 0, 32], 32)
    fake.set([0x66, 0x72, 0x65, 0x65], 36) // free
    expect(mp4DurationSeconds(fake)).toBeNull()
  })

  it('64 位大 box（size=1）按放弃解析处理，返回 null', () => {
    const fake = new Uint8Array(64)
    fake.set([0, 0, 0, 32], 0)
    fake.set([0x66, 0x74, 0x79, 0x70], 4) // ftyp
    fake.set([0, 0, 0, 1], 32) // size=1 → 走 64 位长度分支
    fake.set([0x6d, 0x6f, 0x6f, 0x76], 36) // moov
    expect(mp4DurationSeconds(fake)).toBeNull()
  })
})
