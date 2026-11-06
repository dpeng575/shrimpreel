// kie.ai（可选视频服务商，VIDEO_PROVIDER=kie）：https://docs.kie.ai
// 参考视频 + 参考图 + 提示词提交给 Seedance 2.0（多模态参考模式），用参考图里的人/物替换参考视频里的人/物，
// 复刻原视频的动作、镜头和节奏。
// 媒体不传公网地址（本地 dev 没有公网域名，线上也避免暴露用户照片）：先经 kie 的免费 File Upload API
// （https://kieai.redpandaai.co，上传免费，文件 24 小时后删除）换成它的托管地址再引用。文件名按 generation id 固定，
// 重复提交覆盖同一文件，托管地址保持稳定。
// kie.ai 没有创建幂等键，也查不到“最近任务”列表：抢占（jobs.ts 的 queued→processing）挡住队列重投，
// 但“创建请求已到达、响应在路上丢失”这种窗口仍可能重复创建任务重复计费——这是本 provider 已知的取舍。
// webhook 只当“该去查一下了”的信号，结果始终用 API key 重新拉取（不验签名）。
import { site } from '#/config/site'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const API = 'https://api.kie.ai'
const UPLOAD_API = 'https://kieai.redpandaai.co'
const UPLOAD_PATH = 'shrimpreel'
// Seedance 参考视频限制：每段 2–15 秒；成片时长参数也只接受 4–15。
// 模板源视频比这长的档位（如 18s）直接快速失败，提示换时长或裁剪源视频
const MAX_TEMPLATE_SECONDS = 15
const MIN_DURATION_SECONDS = 4
// Seedance 参考图/视频模式互斥规则不影响这里：我们只用 reference_video_urls + reference_image_urls 组合
// kie.ai 的错误以 HTTP 200 + body code 表达：401 密钥无效、402 余额不足、422 参数错误、429 限流、500 服务端
// 这些任务级失败可重试（上游排队/内部错误）：重试时由 jobs.ts 重新提交
const RETRYABLE_BODY_CODES = new Set([429, 500])

interface KieEnvelope {
  code?: number
  msg?: string
  data?: unknown
}

interface KieTask {
  taskId?: string
  state?: string
  // param / resultJson 都是 JSON 字符串，要二次解析
  resultJson?: string
  failCode?: string
  failMsg?: string
  creditsConsumed?: number
}

interface KieResultJson {
  resultUrls?: string[]
}

interface KieUploadData {
  downloadUrl?: string
}

export function createKieProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.KIE_API_KEY)

  async function call<T>(stage: string, path: string, body?: unknown): Promise<T> {
    if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
    let response: Response
    try {
      response = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown'
      throw new VideoProviderError(`kie_${stage}_network`, `kie ${stage} network error: ${reason}`.slice(0, 500), true)
    }
    const envelope = (await response.json().catch(() => null)) as KieEnvelope | null
    // HTTP 层失败（代理/网关）按状态码决定可否重试
    if (!response.ok) throw requestError(stage, response.status, `HTTP ${response.status}`, envelope)
    // kie.ai 约定：HTTP 200 也可能带 body code 错误，必须检查 code 字段
    if (!envelope || typeof envelope.code !== 'number') throw requestError(stage, response.status, 'malformed envelope', envelope)
    if (envelope.code !== 200) throw bodyError(stage, envelope)
    return envelope.data as T
  }

  // 从 R2 读媒体字节；对象丢失直接不可重试地失败（数据都没了，重试无意义）
  async function readMedia(stage: string, key: string, contentType: string) {
    const object = await env.MEDIA.get(key)
    if (!object) throw new VideoProviderError(`kie_${stage}_missing`, `kie ${stage}: R2 object ${key} not found`, false)
    return { bytes: await object.arrayBuffer(), contentType: object.httpMetadata?.contentType ?? contentType }
  }

  // File Upload API（免费）：换成 kie 的托管地址。图片走 base64 JSON，视频走 multipart 流。
  // 文件名按 generation id 固定：重复提交覆盖同一文件，downloadUrl 稳定
  async function uploadMedia(stage: string, generationId: string, media: { bytes: ArrayBuffer; contentType: string }, kind: 'image' | 'video') {
    if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
    const fileName = `${generationId}-${kind}`
    let response: Response
    try {
      if (kind === 'image') {
        const base64 = b64encode(media.bytes)
        response = await fetch(`${UPLOAD_API}/api/file-base64-upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64Data: `data:${media.contentType};base64,${base64}`, uploadPath: UPLOAD_PATH, fileName }),
        })
      } else {
        const form = new FormData()
        form.append('file', new Blob([media.bytes], { type: media.contentType }), fileName)
        form.append('uploadPath', UPLOAD_PATH)
        form.append('fileName', fileName)
        response = await fetch(`${UPLOAD_API}/api/file-stream-upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
        })
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown'
      throw new VideoProviderError(`kie_${stage}_network`, `kie ${stage} network error: ${reason}`.slice(0, 500), true)
    }
    const envelope = (await response.json().catch(() => null)) as KieEnvelope & { success?: boolean } | null
    if (!response.ok || !envelope || envelope.code !== 200 || !envelope.success) {
      throw requestError(stage, response.status, `HTTP ${response.status}`, envelope)
    }
    const downloadUrl = (envelope.data as KieUploadData | undefined)?.downloadUrl
    if (!downloadUrl) throw new VideoProviderError(`kie_${stage}_no_url`, `kie ${stage} upload returned no downloadUrl`, true)
    return downloadUrl
  }

  return {
    id: 'kie',
    async submit(input) {
      const customSeconds = input.durationSeconds > MAX_TEMPLATE_SECONDS
      // 自定义参考视频的实际时长服务端探不到（Worker 里没有 ffprobe），只对模板源视频快速失败
      if (!input.meta.refUploadId && customSeconds) {
        throw new VideoProviderError(
          'kie_duration_exceeded',
          `kie: Seedance 2.0 accepts reference videos up to ${MAX_TEMPLATE_SECONDS}s; trim the template source or pick a shorter duration`,
          false,
        )
      }
      const { model } = site.video.kie
      // 提示词优先级：生成请求带的（补充指令）> 风格自己的 > 站点默认
      const override = typeof input.meta.prompt === 'string' ? input.meta.prompt.trim() : ''
      const prompt = override || input.style.prompt || site.video.kie.prompt
      // 清晰度按生成请求的（480p/720p 两档，默认 480p 控制成本），没有就按站点默认
      const requested = input.meta.resolution
      const resolution = requested === '480p' || requested === '720p' ? requested : site.video.kie.resolution
      const input_body: Record<string, unknown> = {
        prompt,
        reference_video_urls: [
          await uploadMedia('video-upload', input.generationId, await readMedia('video', input.sourceVideoKey, 'video/mp4'), 'video'),
        ],
        reference_image_urls: [
          await uploadMedia('image-upload', input.generationId, await readMedia('image', input.imageKey, 'image/jpeg'), 'image'),
          // 第二张参考图（Hotel Lobby 双人风格）：有就一起传，Seedance 最多支持 9 张
          ...(input.photo2Key
            ? [await uploadMedia('image2-upload', `${input.generationId}-p2`, await readMedia('image2', input.photo2Key, 'image/jpeg'), 'image')]
            : []),
        ],
        resolution,
        // 成片时长跟参考视频走：夹在 Seedance 接受的 4–15 区间
        duration: Math.min(Math.max(Math.round(input.durationSeconds), MIN_DURATION_SECONDS), MAX_TEMPLATE_SECONDS),
        generate_audio: false,
      }
      const body: Record<string, unknown> = { model, input: input_body }
      // kie.ai 只接受 HTTPS 回调地址；本地 http 开发环境不带，靠轮询
      if (input.webhookUrl.startsWith('https://')) body.callBackUrl = input.webhookUrl
      const task = await call<KieTask>('submit', '/api/v1/jobs/createTask', body)
      if (!task.taskId) throw new VideoProviderError('kie_submit_no_id', 'kie submit returned no taskId', true)
      return { requestId: task.taskId, meta: {} }
    },

    async status(requestId): Promise<VideoStatus> {
      const task = await call<KieTask>('status', `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(requestId)}`)
      if (task.state === 'success') {
        const result = parseResultJson(task.resultJson)
        const url = result?.resultUrls?.[0]
        if (!url) return { state: 'failed', code: 'kie_no_video', message: 'kie task succeeded without an output video' }
        return { state: 'completed', output: { url }, costCents: consumedCents(task) }
      }
      if (task.state === 'fail') {
        const code = task.failCode || 'failed'
        return {
          state: 'failed',
          code: `kie_${code}`.slice(0, 100),
          message: `${code}: ${task.failMsg ?? 'kie task failed'}`.slice(0, 500),
          // kie.ai 的 failCode 语义没有公开清单：保守起见不自动重试，避免不可重试的错误烧钱重跑
          retryable: false,
        }
      }
      // waiting、queuing、generating 和未知状态都继续轮询
      return { state: 'pending' }
    },

    costCents: kieCostCents,
  }
}

// 成本估算（美分），出片后优先用 status 返回的 creditsConsumed。计费口径（官方文档）：
// 带参考视频时按 单价 × (参考视频总时长 + 成片时长)；模板场景两者都取请求时长，夹到 Seedance 上限。
// 单价与最新计费口径以 https://kie.ai/pricing 为准
export function kieCostCents(durationSeconds: number) {
  const billed = Math.min(Math.max(Math.round(durationSeconds), MIN_DURATION_SECONDS), MAX_TEMPLATE_SECONDS)
  return Math.round(billed * 2 * site.video.kie.costCentsPerSecond)
}

// creditsConsumed 的单位是 kie.ai 积分，1 credit = $0.005（= 0.5 美分）：先截到 6 位再取整，避免浮点误差少记 1 美分。
// 换算比例配置在 site.video.kie.creditUsdCents，以 kie.ai 定价页为准
function consumedCents(task: KieTask) {
  if (task.creditsConsumed === undefined || !Number.isFinite(task.creditsConsumed)) return undefined
  return Math.round(Number((task.creditsConsumed * site.video.kie.creditUsdCents).toFixed(6)))
}

function parseResultJson(raw: string | undefined): KieResultJson | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as KieResultJson
  } catch {
    return null
  }
}

// Worker 运行时有 btoa；base64 大字符串（图片 ≤10MB → 约 13MB 文本）一次拼出
function b64encode(bytes: ArrayBuffer) {
  let binary = ''
  const view = new Uint8Array(bytes)
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function bodyError(stage: string, envelope: KieEnvelope) {
  const code = envelope.code ?? 0
  // 401 密钥无效、402 余额不足、422 参数错误都不可重试；429/500 可重试
  return new VideoProviderError(
    `kie_${stage}_${code}`,
    `kie ${stage} failed (code ${code}): ${envelope.msg ?? 'no message'}`.slice(0, 500),
    RETRYABLE_BODY_CODES.has(code),
  )
}

function requestError(stage: string, status: number, detail: string, envelope: KieEnvelope | null) {
  const code = envelope?.code
  const parts = [`kie ${stage} failed (${detail})`, envelope?.msg, code !== undefined ? `code=${code}` : undefined]
  return new VideoProviderError(
    `kie_${stage}_${status}`,
    parts.filter(Boolean).join(': ').slice(0, 500),
    status === 408 || status === 429 || status >= 500,
  )
}
