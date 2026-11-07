import { describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { customRefCredits } from '#/lib/pricing'
import { kieCostCents } from '#/server/video/kie'

// 自定义参考视频的扣分规则：积分 = ceil(kie 成本(美分) × 毛利系数 ÷ 积分售价)。
// 成本口径 = 单价 × (参考视频时长 + 成片时长)，两段都夹在 4–15 秒；lib 的公式必须和 server 的 kieCostCents 同口径
describe('customRefCredits', () => {
  it('按 kie 成本倒推：4 秒→2、6 秒→3、10 秒→5、15 秒→7（成本 50% 毛利、积分售价 49.5 美分）', () => {
    expect(customRefCredits(4)).toBe(2)
    expect(customRefCredits(6)).toBe(3)
    expect(customRefCredits(10)).toBe(5)
    expect(customRefCredits(15)).toBe(7)
    expect(customRefCredits(2)).toBe(2) // 下限夹到 4 秒
    expect(customRefCredits(20)).toBe(7) // 上限夹到 15 秒
    expect(customRefCredits(0)).toBe(2)
  })

  it('lib 公式与 server 的 kieCostCents 同口径：同秒数下 成本×毛利系数÷售价 = 扣分', () => {
    for (const seconds of [4, 5, 6, 9, 12, 15]) {
      const expected = Math.max(1, Math.ceil((kieCostCents(seconds) * site.billing.marginFactor) / site.billing.creditValueCents))
      expect(customRefCredits(seconds)).toBe(expected)
    }
  })

  it('至少扣 1 积分：即便成本被配置成 0 也不出现 0 积分生成', () => {
    const rate = site.video.kie.costCentsPerSecond
    const kieConfig = site.video.kie as { costCentsPerSecond: number }
    kieConfig.costCentsPerSecond = 0
    try {
      expect(customRefCredits(6)).toBe(1)
    } finally {
      kieConfig.costCentsPerSecond = rate
    }
  })
})
