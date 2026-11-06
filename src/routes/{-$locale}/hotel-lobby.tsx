import { createFileRoute } from '@tanstack/react-router'
import { HotelLobbyGenerator } from '#/components/HotelLobbyGenerator'
import { Breadcrumbs } from '#/components/ui'
import { getContent, localeFromParam, pageHead, useContent } from '#/lib/i18n'
import { breadcrumbJsonLd, jsonLdScript } from '#/lib/seo'

// Hotel Lobby 趋势内页（两张照片 → 直播间双人视频）。独立于首页生成器：固定模板 + 双人参考，
// 走同一条生成管线（styleId = hotel-lobby-v1）。成片无声，页面引导用户在 TikTok 里配趋势音频
const breadcrumbItems = (c: ReturnType<typeof getContent>) => [{ name: c.hotelLobby.h1, path: '/hotel-lobby' }]

export const Route = createFileRoute('/{-$locale}/hotel-lobby')({
  head: ({ params }) => {
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    return {
      ...pageHead(locale, '/hotel-lobby', c.hotelLobby.metaTitle, c.hotelLobby.metaDescription),
      scripts: [jsonLdScript(breadcrumbJsonLd(locale, c.meta.breadcrumbHome, breadcrumbItems(c)))],
    }
  },
  component: HotelLobbyPage,
})

function HotelLobbyPage() {
  const c = useContent()
  return (
    <div className="container-page space-y-16 py-16">
      <div>
        <Breadcrumbs items={breadcrumbItems(c)} />
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <p className="eyebrow text-accent-text">{c.hotelLobby.eyebrow}</p>
          <h1 className="mt-3 font-display text-5xl">{c.hotelLobby.h1}</h1>
          <p className="mt-4 text-muted">{c.hotelLobby.subtitle}</p>
        </div>
        <div className="mx-auto max-w-xl">
          <HotelLobbyGenerator />
          <div className="mt-6 space-y-2 rounded-xl border border-line bg-bg-soft p-4" data-testid="hl-sound-guide">
            <h2 className="text-sm font-semibold">{c.hotelLobby.soundTitle}</h2>
            <p className="text-xs leading-5 text-muted">{c.hotelLobby.soundBody}</p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl space-y-8" data-testid="hl-steps">
        <h2 className="text-center font-display text-3xl">{c.hotelLobby.stepsTitle}</h2>
        <ol className="space-y-4">
          {c.hotelLobby.steps.map((step) => (
            <li key={step.h} className="rounded-xl border border-line p-4">
              <h3 className="text-sm font-semibold">{step.h}</h3>
              {step.p.map((para) => (
                <p key={para} className="mt-1 text-sm leading-6 text-muted">
                  {para}
                </p>
              ))}
            </li>
          ))}
        </ol>
        <div className="space-y-2">
          <h2 className="text-center font-display text-2xl">{c.hotelLobby.trendTitle}</h2>
          <p className="text-sm leading-6 text-muted">{c.hotelLobby.trendBody}</p>
        </div>
      </div>
    </div>
  )
}
