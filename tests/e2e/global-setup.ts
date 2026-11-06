import type { FullConfig } from '@playwright/test'
import { defaultStyle, site } from '../../src/config/site'

// e2e 全程跑 mock 服务商：dev server 若配了真实 VIDEO_PROVIDER，测试会真的调外部 API 花钱。
// 启动前先查当前生效的服务商，不是 mock 就拒绝跑测试
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]!.use.baseURL!
  const providerResponse = await fetch(`${baseURL}/api/dev/video-provider`)
  if (!providerResponse.ok) {
    throw new Error(`无法确认 dev server 的视频服务商（HTTP ${providerResponse.status}）：e2e 只能在本地 dev server 上跑`)
  }
  const { provider } = (await providerResponse.json()) as { provider: string }
  if (provider !== 'mock') {
    throw new Error(
      `dev server 的 VIDEO_PROVIDER 是 ${provider}，e2e 只能在 mock 模式下跑（真实服务商会让测试真的花钱）。` +
        `请把 .dev.vars 里的 VIDEO_PROVIDER 改为 mock 并重启 dev server`,
    )
  }
  // mock 生成会直接复用 R2 里的模板源视频；没 seed 时尽早给出明确提示
  const response = await fetch(`${baseURL}/media/templates/${defaultStyle.sources[site.durations[0]!.id]}`, { method: 'HEAD' })
  if (!response.ok) {
    throw new Error(`模板视频不可用（HTTP ${response.status}），请先运行 npm run seed:local`)
  }
}
