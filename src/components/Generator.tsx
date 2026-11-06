import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { STYLES, cheapestPackageCovering, defaultStyle, formatPrice, site } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useCheckout } from '#/lib/checkout'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'
import { AiBadge, ErrorText, GoogleIcon, LocalLink, Spinner, formatDate } from './ui'

type Photo = { file: File; previewUrl: string; uploadId: string | null }

const POLL_MS = 3000

// styleId / onStyleChange：首页把风格状态提到外面，让 hero 标签和生成器同步；不传时生成器自己管
export function Generator({ styleId: controlledStyleId, onStyleChange }: { styleId?: string; onStyleChange?: (id: string) => void } = {}) {
  const c = useContent()
  const g = c.generator
  const lp = useLocalePath()
  const locale = useLocale()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading, refresh } = useSession()
  const inputRef = useRef<HTMLInputElement>(null)
  const refVideoInputRef = useRef<HTMLInputElement>(null)
  const [photo, setPhoto] = useState<Photo | null>(null)
  // 可选的自定义参考视频（VIDEO_PROVIDER=kie 时后端支持）：替换参考视频里的人/物，而不是模板视频
  const [refVideo, setRefVideo] = useState<{ file: File; uploadId: string | null } | null>(null)
  // 参考视频的实际时长（浏览器读元数据）：积分按它算，Seedance 收 4–15 秒
  const [refSeconds, setRefSeconds] = useState<number | null>(null)
  // 补充指令与清晰度对任何 provider 都可以填：mock 忽略，kie 传给 Seedance
  const [prompt, setPrompt] = useState('')
  const [resolution, setResolution] = useState<'480p' | '720p'>('480p')
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [ownStyleId, setOwnStyleId] = useState<string>(defaultStyle.id)
  const styleId = controlledStyleId ?? ownStyleId
  const selectStyle = onStyleChange ?? setOwnStyleId
  // 时长选择器已移除：上传参考视频时成片时长跟随参考视频（4–15 秒），未上传时生成最短的模板视频档
  const defaultDuration = site.durations[0]!
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)

  const checkout = useCheckout()
  // 积分：有参考视频时按它的实际时长算（4–15 秒，向上取整），没有时按最短模板档
  const credits = refVideo && refSeconds ? Math.min(15, Math.max(4, Math.ceil(refSeconds))) : defaultDuration.credits
  const shortfall = user ? Math.max(0, credits - user.credits) : 0
  // 余额不足时直接在这里下单够用的最便宜积分包；没有够用的包就退回去价格页
  const coverPack = shortfall > 0 ? cheapestPackageCovering(shortfall) : undefined

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.previewUrl)
  }, [photo])

  // 轮询当前任务直到结束；结束后刷新余额（失败时积分已退回）
  useEffect(() => {
    if (!generation || !isActiveGeneration(generation)) return
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ generation: Generation }>(`/api/generations/${generation.id}`)
        setGeneration(data.generation)
        if (!isActiveGeneration(data.generation)) await refresh()
      } catch (err) {
        setError(errorCode(err))
        setGeneration({ ...generation })
      }
    }, POLL_MS)
    return () => clearTimeout(timer)
  }, [generation, refresh])

  async function upload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const data = await api<{ upload: { id: string } }>('/api/uploads', { form })
      return data.upload.id
    } finally {
      setUploading(false)
    }
  }

  async function selectFile(file: File | undefined) {
    if (!file) return
    setError(null)
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    const next: Photo = { file, previewUrl: URL.createObjectURL(file), uploadId: null }
    setPhoto(next)
    setGeneration(null)
    if (!user) return
    try {
      const uploadId = await upload(file)
      setPhoto((current) => (current?.file === file ? { ...current, uploadId } : current))
    } catch (err) {
      setError(errorCode(err))
    }
  }

  // 浏览器读视频元数据拿时长：本地拿不到时长的文件（编码异常等）直接拒绝
  function readVideoSeconds(file: File) {
    return new Promise<number>((resolve, reject) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      const url = URL.createObjectURL(file)
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url)
        resolve(video.duration)
      }
      video.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('metadata'))
      }
      video.src = url
    })
  }

  async function selectRefVideo(file: File | undefined) {
    if (!file) return
    setError(null)
    if (file.type !== 'video/mp4') return setError('unsupported_file_type')
    if (file.size > site.upload.maxVideoBytes) return setError('file_too_large')
    let seconds: number
    try {
      seconds = await readVideoSeconds(file)
    } catch {
      return setError('ref_video_unreadable')
    }
    // Seedance 参考视频 2–15 秒：超限在选择时就拒绝，避免扣积分后被服务商退回
    if (!Number.isFinite(seconds) || seconds < 2 || seconds > 15) return setError('ref_video_too_long')
    setRefSeconds(seconds)
    setRefVideo({ file, uploadId: null })
    setGeneration(null)
    if (!user) return
    try {
      const uploadId = await upload(file)
      setRefVideo((current) => (current?.file === file ? { ...current, uploadId } : current))
    } catch (err) {
      setError(errorCode(err))
    }
  }

  async function generate() {
    if (!photo) return setError('invalid_upload')
    setError(null)
    setSubmitting(true)
    try {
      const uploadId = photo.uploadId ?? (await upload(photo.file))
      if (!photo.uploadId) setPhoto({ ...photo, uploadId })
      const refVideoUploadId = refVideo ? refVideo.uploadId ?? (await upload(refVideo.file)) : undefined
      if (refVideo && !refVideo.uploadId) setRefVideo({ ...refVideo, uploadId: refVideoUploadId! })
      const data = await api<{ generation: Generation }>('/api/generations', {
        json: {
          uploadId,
          // durationId 只是记账用的模板档位；上传参考视频时真实时长走 durationSeconds
          durationId: defaultDuration.id,
          styleId,
          locale,
          ...(refVideoUploadId ? { refVideoUploadId } : {}),
          ...(refVideo && refSeconds ? { durationSeconds: refSeconds } : {}),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(resolution !== '480p' ? { resolution } : {}),
        },
      })
      track('generate_video', { style_id: styleId, duration_id: defaultDuration.id, credits: data.generation.creditsCost })
      setGeneration(data.generation)
      await refresh()
    } catch (err) {
      setError(errorCode(err))
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setGeneration(null)
    setError(null)
  }

  const busy = uploading || submitting || (generation !== null && isActiveGeneration(generation))

  return (
    <section
      className="card space-y-5 p-5 shadow-[0_1px_0_var(--line),0_20px_40px_-24px_rgba(0,0,0,0.25)] sm:p-6"
      aria-labelledby="generator-title"
      data-testid="generator"
    >
      {/* 标题只给读屏和大纲用：页面 H1 之后接 H2，步骤标题是 H3 */}
      <h2 id="generator-title" className="sr-only">
        {g.title}
      </h2>
      {/* 1. 照片 */}
      <section className="space-y-3">
        <StepTitle n={1}>{g.stepPhoto}</StepTitle>
        {/* 键盘与读屏从下面的按钮进入，隐藏的 input 不占 Tab 位 */}
        <input
          ref={inputRef}
          type="file"
          accept={site.upload.contentTypes.join(',')}
          className="sr-only"
          tabIndex={-1}
          aria-label={g.dropTitle}
          data-testid="photo-input"
          onChange={(event) => {
            void selectFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            void selectFile(event.dataTransfer.files?.[0])
          }}
          className={`flex w-full items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
            dragging ? 'border-accent bg-accent/5' : 'border-line hover:border-fg/40'
          }`}
        >
          {photo ? (
            <span className="flex items-center gap-4 text-left">
              <img src={photo.previewUrl} alt="" className="size-20 rounded-lg object-cover" />
              <span className="space-y-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {uploading ? <Spinner /> : <CircleCheck className="size-4 text-emerald-600" />}
                  {uploading ? g.uploading : g.uploaded}
                </span>
                <span className="block text-xs text-muted underline">{g.change}</span>
              </span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2.5">
              <span className="grid size-11 place-items-center rounded-full bg-ink text-ink-fg">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-semibold">{g.dropTitle}</span>
              <span className="text-xs text-muted">{g.dropHint}</span>
            </span>
          )}
        </button>
        <p className="text-xs leading-5 text-muted">{g.guidance}</p>
      </section>

      {/* 可选：自定义参考视频 + 提示词（替换模式）。选了视频才显示提示词输入框 */}
      <section className="space-y-2 rounded-xl border border-dashed border-line p-3" data-testid="ref-video-section">
        <input
          ref={refVideoInputRef}
          type="file"
          accept="video/mp4"
          className="sr-only"
          tabIndex={-1}
          aria-label={g.refVideoTitle}
          data-testid="ref-video-input"
          onChange={(event) => {
            void selectRefVideo(event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" disabled={busy} className="btn-ghost px-3 py-1.5 text-xs" onClick={() => refVideoInputRef.current?.click()} data-testid="ref-video-button">
            {refVideo ? <CircleCheck className="size-4 text-emerald-600" /> : <Upload className="size-4" />}
            {refVideo ? (uploading && !refVideo.uploadId ? g.uploading : g.refVideoUploaded) : g.refVideoButton}
          </button>
          <span className="text-xs text-muted">{g.refVideoHint}</span>
        </div>
        {refVideo ? <p className="text-xs text-muted">{g.refVideoNote}</p> : null}

        {/* 补充指令：常驻可选，不依赖参考视频 */}
        <label className="block space-y-1.5 pt-1">
          <span className="block text-xs font-semibold text-fg">{g.promptLabel}</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            maxLength={1200}
            placeholder={g.promptPlaceholder}
            className="input w-full text-sm"
            data-testid="ref-prompt"
          />
        </label>

        {/* 清晰度选择：默认 480p（成本最低） */}
        <div className="space-y-1.5">
          <span className="block text-xs font-semibold text-fg">{g.resolutionLabel}</span>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-bg-soft p-1" role="radiogroup" aria-label={g.resolutionLabel}>
            {(['480p', '720p'] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={resolution === r}
                disabled={busy}
                data-testid={`resolution-${r}`}
                onClick={() => setResolution(r)}
                className={`rounded-lg px-2 py-1.5 text-center text-sm font-semibold uppercase transition ${resolution === r ? 'bg-card shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}
              >
                {r}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{g.resolutionHint}</p>
        </div>
      </section>

      {/* 2. 风格：只有一种风格时不显示 */}
      {STYLES.length > 1 ? (
        <section className="space-y-3">
          <StepTitle n={2}>{g.stepStyle}</StepTitle>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={g.stepStyle}>
            {STYLES.map((style) => {
              const active = style.id === styleId
              const copy = c.styles[style.id as keyof typeof c.styles]
              const thumb = style.examples.aiVersions[0]
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={busy}
                  data-testid={`style-${style.id}`}
                  onClick={() => selectStyle(style.id)}
                  className={`flex items-center gap-3 rounded-xl p-2 text-left transition ${active ? 'bg-card shadow-sm ring-2 ring-ink' : 'bg-bg-soft text-muted ring-1 ring-line hover:text-fg'}`}
                >
                  {thumb ? <img src={thumb.poster} alt="" loading="lazy" className="aspect-[3/4] w-10 shrink-0 rounded-md object-cover" /> : null}
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{copy.name}</span>
                    <span className="block text-xs text-muted">{copy.tagline}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* 时长说明：不再提供选择器，成片时长跟随参考视频 */}
      <section className="space-y-1" data-testid="length-note">
        {STYLES.length > 1 ? null : <StepTitle n={2}>{g.stepLength}</StepTitle>}
        <p className="text-xs leading-5 text-muted">
          {refVideo && refSeconds
            ? g.lengthFollowsRefVideo(Math.ceil(refSeconds), credits)
            : g.lengthDefault(defaultDuration.seconds, defaultDuration.credits)}
        </p>
      </section>

      <label className="flex items-start gap-3 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
          data-testid="consent"
        />
        <span>{g.consent}</span>
      </label>

      {/* CTA */}
      <div className="space-y-2">
        {loading ? (
          <div className="btn-primary w-full py-3.5 opacity-60">
            <Spinner />
          </div>
        ) : !user ? (
          <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-primary w-full py-3.5" data-testid="generator-sign-up">
            <GoogleIcon /> {g.ctaSignUp}
          </a>
        ) : shortfall > 0 && coverPack ? (
          <>
            <button
              type="button"
              className="btn-primary w-full py-3.5"
              disabled={checkout.pending !== null || checkout.paused}
              onClick={() => checkout.buy(coverPack.id)}
              data-testid="generator-buy"
            >
              {checkout.paused ? (
                c.pricing.paused
              ) : checkout.pending === coverPack.id ? (
                <>
                  <Spinner /> {c.pricing.buying}
                </>
              ) : (
                g.ctaBuyPack(coverPack.credits, formatPrice(coverPack.priceCents, coverPack.currency))
              )}
            </button>
            <p className="text-center text-xs">
              <LocalLink to="/pricing" className="text-muted underline" data-testid="generator-see-packs">
                {g.seePacks}
              </LocalLink>
            </p>
            <ErrorText code={checkout.error} />
          </>
        ) : shortfall > 0 ? (
          <LocalLink to="/pricing" className="btn-primary w-full py-3.5" data-testid="generator-buy">
            {g.ctaBuy}
          </LocalLink>
        ) : (
          <button
            type="button"
            className="btn-primary w-full py-3.5"
            disabled={busy || !photo || !consent}
            onClick={generate}
            data-testid="generate"
          >
            {submitting ? <Spinner /> : null}
            {g.ctaGenerate(credits)}
          </button>
        )}
        {user ? (
          <p className="text-center text-xs text-muted" data-testid="generator-balance">
            {g.balance(user.credits)}
            {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
          </p>
        ) : null}
        {user && photo && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
        <ErrorText code={error} />
      </div>

      {generation ? <GenerationResult generation={generation} onReset={reset} /> : null}
    </section>
  )
}

function StepTitle({ n, children }: { n: number; children: string }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] text-ink-fg">{n}</span>
      {children}
    </h3>
  )
}

function GenerationResult({ generation, onReset }: { generation: Generation; onReset: () => void }) {
  const g = useContent().generator
  const locale = useLocale()
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-soft p-4" data-testid="generation-status" data-status={generation.status}>
      {isActiveGeneration(generation) ? (
        <p className="flex items-start gap-2 text-sm">
          <Spinner className="mt-0.5 size-4 shrink-0" />
          {generation.status === 'queued' ? g.queued : g.processing}
        </p>
      ) : generation.status === 'succeeded' && generation.videoUrl ? (
        <>
          <p className="flex items-center gap-2 text-sm font-semibold">
            <CircleCheck className="size-4 text-emerald-600" /> {g.succeeded}
          </p>
          <div className="relative mx-auto w-fit">
            <AiBadge />
            <video src={generation.videoUrl} controls playsInline className="max-h-[420px] rounded-lg bg-black" data-testid="generation-video" />
          </div>
          <p className="text-xs text-muted" data-testid="ai-notice">
            {g.aiNotice}
            {generation.expiresAt ? ` ${g.expiresOn(formatDate(generation.expiresAt, locale))}` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${generation.videoUrl}?download=1`} className="btn-primary px-4 py-2" download>
              <Download className="size-4" /> {g.download}
            </a>
            <LocalLink to="/dashboard" className="btn-ghost px-4 py-2">
              {g.viewAll}
            </LocalLink>
            <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
              {g.makeAnother}
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-600 dark:text-red-400">
            <CircleAlert className="size-4" /> {g.failed}
          </p>
          {generation.refunded ? <p className="text-muted">{g.refunded}</p> : null}
          <button type="button" className="btn-ghost px-4 py-2" onClick={onReset}>
            {g.makeAnother}
          </button>
        </div>
      )}
    </div>
  )
}
