import { isWeakSessionSecret } from './config-health'
import { ApiError, base64Url, constantTimeEqual, hmacSha256, isProduction } from './util'

// 生产环境的签名密钥缺失、过短或仍是示例值时拒绝签名，而不是签出可伪造的 URL
function signingSecret(env: Env) {
  const secret = env.SESSION_SECRET ?? ''
  if (isProduction(env) && isWeakSessionSecret(secret)) {
    throw new ApiError(503, 'server_misconfigured', 'SESSION_SECRET is missing, shorter than 32 characters, or still the example value')
  }
  return secret
}

// 给视频 provider 拉取用户上传图片用的短期签名 URL：/media/uploads/<uploadId>?exp=&sig=
// issuedAtMs 固定时 URL 也固定：同一任务重新提交时请求体不变（yir 的幂等键按请求体识别）
export async function signedUploadUrl(env: Env, uploadId: string, issuedAtMs = Date.now(), ttlSeconds = 2 * 3600) {
  const exp = Math.floor(issuedAtMs / 1000) + ttlSeconds
  const sig = base64Url(await hmacSha256(signingSecret(env), `upload:${uploadId}:${exp}`))
  return `${env.SITE_URL.replace(/\/$/, '')}/media/uploads/${uploadId}?exp=${exp}&sig=${sig}`
}

export async function verifyUploadSignature(env: Env, uploadId: string, exp: string | null, sig: string | null) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false
  const expected = base64Url(await hmacSha256(signingSecret(env), `upload:${uploadId}:${exp}`))
  return constantTimeEqual(expected, sig)
}

// fal webhook 回调地址里带的 token，防止伪造回调触发无意义的轮询
export async function jobToken(env: Env, generationId: string) {
  return base64Url(await hmacSha256(signingSecret(env), `job:${generationId}`))
}

export function templateSourceUrl(env: Env, file: string) {
  return `${env.SITE_URL.replace(/\/$/, '')}/media/templates/${file}`
}

// 从 R2 输出对象，支持 Range（视频拖动进度条必需）与条件请求
export async function serveR2Object(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { cacheControl: string; downloadName?: string },
) {
  const object = await bucket.get(key, { range: request.headers, onlyIf: request.headers })
  if (!object) return new Response('Not found', { status: 404 })

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('cache-control', options.cacheControl)
  if (options.downloadName) headers.set('content-disposition', `attachment; filename="${options.downloadName}"`)

  if (!('body' in object)) return new Response(null, { status: 304, headers })

  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined
  if (range && request.headers.has('range')) {
    const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0)
    const length = range.length ?? object.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
    headers.set('content-length', String(length))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}

// 只认真实图片：按文件头魔数判断，不信任客户端传的 Content-Type
export function sniffImageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return 'image/png'
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

// 只认真实 MP4：ISO BMFF 的 ftyp box 固定在第 4–8 字节（mp4 和 mov 都是）；WebM 是 EBML 魔数但 Seedance 不收，这里不放行
export function sniffVideoType(bytes: Uint8Array): 'video/mp4' | null {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') return 'video/mp4'
  return null
}

// 解析 MP4 的 mvhd box 拿成片时长（秒）。Worker 里没有 ffprobe，纯 JS 按 ISO BMFF box 结构遍历：
// 顶层找 moov，moov 里找 mvhd，按 version 读 timescale/duration。moov 可能在文件头也可能在尾（流式优化），
// 所以要整个文件的字节（调用方已有）。解析不出（损坏/不是完整 mp4）返回 null，由调用方拒绝
export function mp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = (off: number) => String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!)
  // 在 [start,end) 里找指定类型的子 box，返回其内容起始偏移与大小
  function findBox(start: number, end: number, want: string): { content: number; size: number } | null {
    let off = start
    while (off + 8 <= end) {
      let size = view.getUint32(off)
      const head = 8
      if (size === 1) {
        // 64 位大 box：真实媒体用不到这个量级，遇到就放弃解析
        return null
      }
      if (size === 0) size = end - off
      if (size < head || off + size > end) return null
      if (type(off) === want) return { content: off + head, size: size - head }
      off += size
    }
    return null
  }
  const moov = findBox(0, bytes.length, 'moov')
  if (!moov) return null
  const mvhd = findBox(moov.content, moov.content + moov.size, 'mvhd')
  if (!mvhd) return null
  const version = bytes[mvhd.content]!
  let timescale: number
  let duration: number
  if (version === 1) {
    if (mvhd.size < 32) return null
    timescale = view.getUint32(mvhd.content + 20)
    duration = Number(view.getBigUint64(mvhd.content + 24))
  } else {
    if (mvhd.size < 20) return null
    timescale = view.getUint32(mvhd.content + 12)
    duration = view.getUint32(mvhd.content + 16)
  }
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null
  const seconds = duration / timescale
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}
