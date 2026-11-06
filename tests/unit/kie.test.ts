import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultStyle, site, type Style } from '#/config/site'
import { createKieProvider, kieCostCents } from '#/server/video/kie'
import { VideoProviderError } from '#/server/video/types'

// kie.ai 契约：https://docs.kie.ai/market/bytedance/seedance-2（provider 只把任务映射成 VideoStatus，退积分、下载成片在 jobs.ts）
// 媒体先经 kie 的 File Upload API 换托管地址再引用（docs.kie.ai/file-upload-api），不需要公网可达的站点地址
const env = (vars: Record<string, string> = {}) =>
  ({
    APP_ENV: 'production',
    SITE_URL: 'https://moonhop.ai',
    SESSION_SECRET: 'a'.repeat(64),
    KIE_API_KEY: 'kie_test',
    MEDIA: {
      get: async (key: string) =>
        key === 'missing'
          ? null
          : { arrayBuffer: async () => new TextEncoder().encode('binary').buffer, httpMetadata: { contentType: 'image/jpeg' } },
    },
    ...vars,
  }) as unknown as Env

const plainStyle: Style = { ...defaultStyle, prompt: null, scene: null }

const input = (overrides: Partial<Pick<import('#/server/video/types').VideoSubmitInput, 'webhookUrl' | 'durationSeconds'>> = {}, meta: Record<string, unknown> = {}, style: Style = plainStyle) => ({
  generationId: 'gen_1',
  style,
  durationSeconds: 12,
  imageUrl: 'https://moonhop.ai/media/uploads/upl_1?exp=1&sig=s',
  imageKey: 'uploads/usr_1/upl_1.jpg',
  sourceVideoUrl: 'https://moonhop.ai/media/templates/neon-12s.mp4',
  sourceVideoKey: 'templates/neon-12s.mp4',
  webhookUrl: 'https://moonhop.ai/api/webhooks/kie?gen=gen_1&token=t',
  meta,
  ...overrides,
})

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, code: 200, msg: 'success', data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
const bodyFail = (code: number, msg: string) => new Response(JSON.stringify({ code, msg, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })

// 上传接口的默认应答：downloadUrl 跟随请求里的 fileName，断言能区分多张图；没有 fileName 时给固定值
const UPLOAD_ROUTES = {
  'POST /api/file-base64-upload': (_url: URL, body: Record<string, unknown> | FormData | null) =>
    ok({ downloadUrl: `https://tempfile.redpandaai.co/shrimpreel/${(body as Record<string, string>)?.fileName ?? 'file'}` }),
  'POST /api/file-stream-upload': (_url: URL, body: Record<string, unknown> | FormData | null) =>
    ok({ downloadUrl: `https://tempfile.redpandaai.co/shrimpreel/${body instanceof FormData ? body.get('fileName') : 'file'}` }),
}

type Route = (url: URL, body: Record<string, unknown> | FormData | null) => Response
const mergedRoutes = (routes: Record<string, Route>): Record<string, Route> => ({ ...UPLOAD_ROUTES, ...routes })
function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ method: string; url: URL; body: Record<string, unknown> | FormData | null; headers: Record<string, string> }> = []
  const table = mergedRoutes(routes)
  vi.stubGlobal('fetch', async (raw: string, init?: RequestInit) => {
    const url = new URL(raw)
    const method = init?.method ?? 'GET'
    const body = init?.body
    const parsed = typeof body === 'string' ? JSON.parse(body) : body instanceof FormData ? body : null
    calls.push({ method, url, body: parsed, headers: init?.headers as Record<string, string> })
    const route = table[`${method} ${url.pathname}`]
    if (!route) throw new Error(`unexpected fetch ${method} ${url.pathname}`)
    return route(url, parsed)
  })
  return calls
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as VideoProviderError
  }
  throw new Error('expected rejection')
}

afterEach(() => vi.unstubAllGlobals())

describe('kie provider：提交', () => {
  it('媒体先上传换成托管地址；请求体取自站点配置；提示词按 meta.prompt > 风格 > 站点默认；时长夹到 4–15；HTTPS 才带 callBackUrl', async () => {
    const calls = stubFetch({ 'POST /api/v1/jobs/createTask': () => ok({ taskId: 'task_1' }) })
    const provider = createKieProvider(env())
    expect(await provider.submit(input())).toEqual({ requestId: 'task_1', meta: {} })
    // 两个上传：base64（图片）+ multipart（视频），文件名按 generation id 固定
    const imagePost = calls.find((c) => c.url.pathname === '/api/file-base64-upload')!
    const videoPost = calls.find((c) => c.url.pathname === '/api/file-stream-upload')!
    expect(imagePost.headers).toMatchObject({ Authorization: 'Bearer kie_test' })
    expect((imagePost.body as Record<string, string>).base64Data).toContain('data:image/jpeg;base64,')
    expect((imagePost.body as Record<string, string>).fileName).toBe('gen_1-image')
    expect((videoPost.body as FormData).get('fileName')).toBe('gen_1-video')
    expect((videoPost.body as FormData).get('uploadPath')).toBe('shrimpreel')

    const post = calls.find((c) => c.url.pathname === '/api/v1/jobs/createTask')!
    expect(post.headers).toMatchObject({ Authorization: 'Bearer kie_test' })
    expect(post.body).toMatchObject({
      model: site.video.kie.model,
      callBackUrl: input().webhookUrl,
      input: {
        prompt: site.video.kie.prompt,
        reference_video_urls: ['https://tempfile.redpandaai.co/shrimpreel/gen_1-video'],
        reference_image_urls: ['https://tempfile.redpandaai.co/shrimpreel/gen_1-image'],
        resolution: site.video.kie.resolution,
        duration: 12,
        generate_audio: false,
      },
    })

    // 本地 http 回调不带 callBackUrl
    await provider.submit(input({ webhookUrl: 'http://127.0.0.1:3000/api/webhooks/kie?gen=gen_1&token=t' }))
    const post2 = calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[1]!
    expect(post2.body).not.toHaveProperty('callBackUrl')

    // 风格自己的 prompt 优先于站点默认
    await provider.submit(input(undefined, {}, { ...plainStyle, prompt: 'Swap the dancer' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[2]!.body).toMatchObject({ input: { prompt: 'Swap the dancer' } })

    // meta.prompt（补充指令）优先于风格
    await provider.submit(input(undefined, { prompt: '  Replace the object on the desk  ' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[3]!.body).toMatchObject({ input: { prompt: 'Replace the object on the desk' } })

    // 时长夹取：自定义视频路径放行并夹到 15
    await provider.submit(input({ durationSeconds: 18 }, { refUploadId: 'upl_v' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[4]!.body).toMatchObject({ input: { duration: 15 } })

    // 清晰度：请求带的 720p 透传；非法值回落站点默认
    await provider.submit(input(undefined, { resolution: '720p' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[5]!.body).toMatchObject({ input: { resolution: '720p' } })
    await provider.submit(input(undefined, { resolution: '1080p' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')[6]!.body).toMatchObject({ input: { resolution: site.video.kie.resolution } })
  })

  it('第二张参考图（Hotel Lobby 双人）：两张图都上传并按顺序引用；没有第二张时只引用一张', async () => {
    const calls = stubFetch({ 'POST /api/v1/jobs/createTask': () => ok({ taskId: 'task_1' }) })
    const provider = createKieProvider(env())
    await provider.submit({ ...input(), photo2Key: 'uploads/usr_1/upl_2.jpg' })
    const uploads = calls.filter((c) => c.url.pathname.startsWith('/api/file-'))
    expect(uploads.map((c) => c.url.pathname)).toEqual(['/api/file-stream-upload', '/api/file-base64-upload', '/api/file-base64-upload'])
    const post = calls.find((c) => c.url.pathname === '/api/v1/jobs/createTask')!
    expect(post.body).toMatchObject({
      input: {
        reference_image_urls: ['https://tempfile.redpandaai.co/shrimpreel/gen_1-image', 'https://tempfile.redpandaai.co/shrimpreel/gen_1-p2-image'],
      },
    })

    calls.length = 0
    await provider.submit(input())
    expect(calls.filter((c) => c.url.pathname === '/api/file-base64-upload')).toHaveLength(1)
    const post2 = calls.find((c) => c.url.pathname === '/api/v1/jobs/createTask')!
    expect(post2.body).toMatchObject({ input: { reference_image_urls: ['https://tempfile.redpandaai.co/shrimpreel/gen_1-image'] } })
  })

  it('模板路径超过 15 秒（Seedance 参考视频上限）快速失败，不发请求也不上传；自定义参考视频路径不受此限制', async () => {
    const calls = stubFetch({ 'POST /api/v1/jobs/createTask': () => ok({ taskId: 'task_1' }) })
    const provider = createKieProvider(env())
    const error = await rejection(provider.submit(input({ durationSeconds: 18 })))
    expect(error).toMatchObject({ code: 'kie_duration_exceeded', retryable: false })
    expect(calls).toHaveLength(0)
    await provider.submit(input({ durationSeconds: 18 }, { refUploadId: 'upl_v' }))
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')).toHaveLength(1)
  })

  it('R2 对象丢失：不可重试地失败，不创建任务', async () => {
    const calls = stubFetch({})
    const envNoObject = { ...env(), MEDIA: { get: async () => null } } as unknown as Env
    const error = await rejection(createKieProvider(envNoObject).submit(input()))
    expect(error).toMatchObject({ code: 'kie_video_missing', retryable: false })
    expect(calls.filter((c) => c.url.pathname === '/api/v1/jobs/createTask')).toHaveLength(0)
  })

  it('上传失败可重试、创建错误映射：body code 402/422 不可重试、429/500 可重试；message 不含密钥', async () => {
    stubFetch({ 'POST /api/file-stream-upload': () => new Response('<html>bad gateway</html>', { status: 502 }) })
    const uploadError = await rejection(createKieProvider(env()).submit(input()))
    expect(uploadError).toBeInstanceOf(VideoProviderError)
    expect(uploadError).toMatchObject({ code: 'kie_video-upload_502', retryable: true })

    for (const [code, retryable] of [[402, false], [422, false], [429, true], [500, true]] as const) {
      stubFetch({ 'POST /api/v1/jobs/createTask': () => bodyFail(code, 'boom') })
      const error = await rejection(createKieProvider(env()).submit(input()))
      expect(error).toBeInstanceOf(VideoProviderError)
      expect(error).toMatchObject({ code: `kie_submit_${code}`, retryable })
      expect(error.message).toContain('boom')
      expect(error.message).not.toContain('kie_test')
    }
    stubFetch({ 'POST /api/v1/jobs/createTask': () => new Response('<html>bad gateway</html>', { status: 502 }) })
    expect(await rejection(createKieProvider(env()).submit(input()))).toMatchObject({ code: 'kie_submit_502', retryable: true })
  })

  it('没配 key：不可重试，且不发请求', async () => {
    const calls = stubFetch({})
    const error = await rejection(createKieProvider(env({ KIE_API_KEY: '' })).submit(input()))
    expect(error).toMatchObject({ code: 'provider_not_configured', retryable: false })
    expect(calls).toHaveLength(0)
  })
})

describe('kie provider：查询', () => {
  const statusOf = (data: unknown) => {
    stubFetch({ 'GET /api/v1/jobs/recordInfo': () => ok(data) })
    return createKieProvider(env()).status('task_1', {})
  }

  it('waiting、queuing、generating 和未知状态都是处理中', async () => {
    for (const state of ['waiting', 'queuing', 'generating', 'something_new']) expect(await statusOf({ taskId: 'task_1', state })).toEqual({ state: 'pending' })
  })

  it('成功：解析 resultJson 取第一个 resultUrl；creditsConsumed 按 1 credit=$0.005 换算美分；没有输出算失败', async () => {
    const done = await statusOf({ taskId: 'task_1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.ai/out.mp4'] }), creditsConsumed: 115 })
    expect(done).toEqual({ state: 'completed', output: { url: 'https://cdn.kie.ai/out.mp4' }, costCents: 58 })
    expect(await statusOf({ taskId: 'task_1', state: 'success', resultJson: JSON.stringify({ resultUrls: [] }) })).toMatchObject({ state: 'failed', code: 'kie_no_video' })
    // resultJson 缺失或不是 JSON：失败而不是抛异常
    expect(await statusOf({ taskId: 'task_1', state: 'success' })).toMatchObject({ state: 'failed', code: 'kie_no_video' })
    expect(await statusOf({ taskId: 'task_1', state: 'success', resultJson: 'not-json' })).toMatchObject({ state: 'failed', code: 'kie_no_video' })
  })

  it('失败：错误码带 failCode，一律不可自动重试（failCode 语义没有公开清单，避免烧钱重跑）', async () => {
    for (const failCode of ['content_policy', 'generate_failed', '']) {
      expect(await statusOf({ taskId: 'task_1', state: 'fail', failCode, failMsg: 'boom' })).toEqual({
        state: 'failed',
        code: `kie_${failCode || 'failed'}`.slice(0, 100),
        message: `${failCode || 'failed'}: boom`,
        retryable: false,
      })
    }
  })

  it('recordInfo 返回 body code 404（任务不存在）不可重试', async () => {
    stubFetch({ 'GET /api/v1/jobs/recordInfo': () => bodyFail(404, 'recordInfo is null') })
    expect(await rejection(createKieProvider(env()).status('task_1', {}))).toMatchObject({ code: 'kie_status_404', retryable: false })
  })
})

describe('kieCostCents', () => {
  it('估算 = 单价 × (参考视频时长 + 成片时长)，两段都夹到 4–15', () => {
    const rate = site.video.kie.costCentsPerSecond
    expect(kieCostCents(6)).toBe(Math.round(6 * 2 * rate))
    expect(kieCostCents(2)).toBe(Math.round(4 * 2 * rate))
    expect(kieCostCents(18)).toBe(Math.round(15 * 2 * rate))
  })
})
