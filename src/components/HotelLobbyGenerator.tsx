import { useRouterState } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, Download, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cheapestPackageCovering, hotelLobbyCredits, hotelLobbyStyle, site } from '#/config/site'
import { api, errorCode, isActiveGeneration, type Generation } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useCheckout } from '#/lib/checkout'
import { useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'
import { AiBadge, ErrorText, LocalLink, Spinner, formatDate } from './ui'

type Photo = { file: File; previewUrl: string; uploadId: string | null }

const POLL_MS = 3000

// Hotel Lobby 双人生成器：两张照片（左/右各一人）+ 固定模板视频，走同一条生成管线（styleId = hotel-lobby-v1）。
// 成片时长跟随模板视频；视频无声，用户在 TikTok 里自己配趋势音频
export function HotelLobbyGenerator() {
  const c = useContent()
  const g = c.hotelLobby
  const lp = useLocalePath()
  const locale = useLocale()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading, refresh } = useSession()
  const leftRef = useRef<HTMLInputElement>(null)
  const rightRef = useRef<HTMLInputElement>(null)
  const [left, setLeft] = useState<Photo | null>(null)
  const [right, setRight] = useState<Photo | null>(null)
  const [uploading, setUploading] = useState(false)
  // 清晰度：480p 成本最低（约一半），默认选它；720p 更清晰
  const [resolution, setResolution] = useState<'480p' | '720p'>('480p')
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generation, setGeneration] = useState<Generation | null>(null)

  const checkout = useCheckout()
  // 成片时长跟随模板视频（15 秒），积分按 hotelLobbyCredits 固定收
  const credits = hotelLobbyCredits
  const shortfall = user ? Math.max(0, credits - user.credits) : 0
  const coverPack = shortfall > 0 ? cheapestPackageCovering(shortfall) : undefined

  useEffect(() => {
    if (!left) return
    return () => URL.revokeObjectURL(left.previewUrl)
  }, [left])
  useEffect(() => {
    if (!right) return
    return () => URL.revokeObjectURL(right.previewUrl)
  }, [right])

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

  function selectPhoto(slot: 'left' | 'right', file: File | undefined) {
    if (!file) return
    setError(null)
    if (!(site.upload.contentTypes as readonly string[]).includes(file.type)) return setError('unsupported_file_type')
    if (file.size > site.upload.maxBytes) return setError('file_too_large')
    const photo: Photo = { file, previewUrl: URL.createObjectURL(file), uploadId: null }
    ;(slot === 'left' ? setLeft : setRight)(photo)
    setGeneration(null)
    if (!user) return
    upload(file)
      .then((uploadId) => {
        const setter = slot === 'left' ? setLeft : setRight
        setter((current) => (current?.file === file ? { ...current, uploadId } : current))
      })
      .catch((err) => setError(errorCode(err)))
  }

  async function generate() {
    if (!left || !right) return setError('need_photos')
    setError(null)
    setSubmitting(true)
    try {
      const uploadId = left.uploadId ?? (await upload(left.file))
      if (!left.uploadId) setLeft({ ...left, uploadId })
      const photo2UploadId = right.uploadId ?? (await upload(right.file))
      if (!right.uploadId) setRight({ ...right, uploadId: photo2UploadId })
      const data = await api<{ generation: Generation }>('/api/generations', {
        json: {
          uploadId,
          photo2UploadId,
          styleId: hotelLobbyStyle.id,
          durationId: 'short',
          locale,
          ...(resolution !== '480p' ? { resolution } : {}),
        },
      })
      track('generate_video', { style_id: hotelLobbyStyle.id, duration_id: 'short', credits: data.generation.creditsCost })
      setGeneration(data.generation)
      await refresh()
    } catch (err) {
      setError(errorCode(err))
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const busy = uploading || submitting || (generation !== null && isActiveGeneration(generation))
  const photosReady = left && right

  function photoBox(slot: 'left' | 'right') {
    const photo = slot === 'left' ? left : right
    const inputRef = slot === 'left' ? leftRef : rightRef
    const label = slot === 'left' ? g.photoLeft : g.photoRight
    return (
      <div className="space-y-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-label={label}
          data-testid={`${slot}-photo-input`}
          onChange={(event) => {
            selectPhoto(slot, event.target.files?.[0])
            event.target.value = ''
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className={`flex aspect-[3/4] w-full items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center transition ${
            photo ? 'border-transparent' : 'border-line hover:border-fg/40'
          }`}
          data-testid={`${slot}-photo-button`}
        >
          {photo ? (
            <span className="relative block size-full">
              <img src={photo.previewUrl} alt="" className="absolute inset-0 size-full rounded-lg object-cover" />
              <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-xs text-ink-fg underline">
                {uploading && !photo.uploadId ? g.uploading : g.change}
              </span>
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2">
              <span className="grid size-11 place-items-center rounded-full bg-ink text-ink-fg">
                <Upload className="size-5" />
              </span>
              <span className="text-sm font-semibold">{label}</span>
              <span className="text-xs text-muted">{g.dropHint}</span>
            </span>
          )}
        </button>
        {photo ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-600">
            <CircleCheck className="size-3.5" /> {g.uploaded}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <section className="card space-y-5 p-5 shadow-[0_1px_0_var(--line),0_20px_40px_-24px_rgba(0,0,0,0.25)] sm:p-6" aria-labelledby="hotel-lobby-generator" data-testid="hotel-lobby-generator">
      <h2 id="hotel-lobby-generator" className="sr-only">
        {g.h1}
      </h2>
      <div className="grid grid-cols-2 gap-3">{photoBox('left')}{photoBox('right')}</div>
      <p className="text-xs text-muted">{g.creditsNote(credits)}</p>

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
              data-testid={`hl-resolution-${r}`}
              onClick={() => setResolution(r)}
              className={`rounded-lg px-2 py-1.5 text-center text-sm font-semibold uppercase transition ${resolution === r ? 'bg-card shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg'}`}
            >
              {r}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">{g.resolutionHint}</p>
      </div>

      <label className="flex items-start gap-3 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
          data-testid="hl-consent"
        />
        <span>{g.consent}</span>
      </label>

      <div className="space-y-2">
        {loading ? (
          <div className="btn-primary w-full py-3.5 opacity-60">
            <Spinner />
          </div>
        ) : !user ? (
          <a href={signInHref(config, pathname, lp('/sign-in'))} className="btn-primary w-full py-3.5" data-testid="hl-sign-up">
            {g.ctaGenerate(credits)}
          </a>
        ) : shortfall > 0 && coverPack ? (
          <button
            type="button"
            className="btn-primary w-full py-3.5"
            disabled={checkout.pending !== null || checkout.paused}
            onClick={() => checkout.buy(coverPack.id)}
            data-testid="hl-buy"
          >
            {checkout.paused ? c.pricing.paused : checkout.pending === coverPack.id ? <><Spinner /> {c.pricing.buying}</> : g.ctaGenerate(credits)}
          </button>
        ) : shortfall > 0 ? (
          <LocalLink to="/pricing" className="btn-primary w-full py-3.5" data-testid="hl-buy">
            {g.ctaBuy}
          </LocalLink>
        ) : (
          <button type="button" className="btn-primary w-full py-3.5" disabled={busy || !photosReady || !consent} onClick={generate} data-testid="hl-generate">
            {submitting ? <Spinner /> : null}
            {g.ctaGenerate(credits)}
          </button>
        )}
        {user ? (
          <p className="text-center text-xs text-muted" data-testid="hl-balance">
            {g.balance(user.credits)}
            {shortfall > 0 ? ` · ${g.needMore(shortfall)}` : ''}
          </p>
        ) : null}
        {user && photosReady && !consent && !generation ? <p className="text-center text-xs text-muted">{g.needConsent}</p> : null}
        {!photosReady && user ? <p className="text-center text-xs text-muted">{g.needPhotos}</p> : null}
        <ErrorText code={error} />
      </div>

      {generation ? <HotelLobbyResult generation={generation} onReset={() => setGeneration(null)} /> : null}
    </section>
  )
}

function HotelLobbyResult({ generation, onReset }: { generation: Generation; onReset: () => void }) {
  const g = useContent().hotelLobby
  const locale = useLocale()
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-soft p-4" data-testid="hl-generation-status" data-status={generation.status}>
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
            <video src={generation.videoUrl} controls playsInline className="max-h-[420px] rounded-lg bg-black" data-testid="hl-generation-video" />
          </div>
          <p className="text-xs text-muted" data-testid="hl-ai-notice">
            {g.aiNotice}
            {generation.expiresAt ? ` ${g.expiresOn(formatDate(generation.expiresAt, locale))}` : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={`${generation.videoUrl}?download=1`} className="btn-primary px-4 py-2" download>
              <Download className="size-4" /> {g.download}
            </a>
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
