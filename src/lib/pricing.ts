import { site } from '#/config/site'

// 自定义参考视频的扣分预估（前后端共用）：按供应商真实计费口径（单价 × (参考视频时长 + 成片时长)，
// 两段都夹在 4–15 秒）估出成本，再按积分售价和毛利系数换算成积分。
// 自定义参考视频只在 VIDEO_PROVIDER=kie（或 mock 供 e2e，mock 也按 kie 口径定价）下开放，
// 所以这里的成本公式与 src/server/video/kie.ts 的 kieCostCents 同口径——改单价时两处一起改，tests/unit/pricing.test.ts 会核对
export function customRefCredits(seconds: number) {
  const billed = Math.min(Math.max(Math.round(seconds), 4), 15)
  const costCents = Math.round(billed * 2 * site.video.kie.costCentsPerSecond)
  return Math.max(1, Math.ceil((costCents * site.billing.marginFactor) / site.billing.creditValueCents))
}
