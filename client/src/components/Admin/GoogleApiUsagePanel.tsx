import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Gauge, Loader2, RefreshCw } from 'lucide-react'
import { adminApi, type GoogleApiSku, type GoogleApiUsage } from '../../api/client'
import { useTranslation } from '../../i18n'

const SKU_LABEL_KEYS: Record<GoogleApiSku, string> = {
  autocomplete: 'admin.googleUsage.sku.autocomplete',
  text_search_ids_only: 'admin.googleUsage.sku.textSearchIdsOnly',
  text_search_pro: 'admin.googleUsage.sku.textSearchPro',
  text_search_enterprise: 'admin.googleUsage.sku.textSearchEnterprise',
  place_details_ids_only: 'admin.googleUsage.sku.placeDetailsIdsOnly',
  place_details_enterprise: 'admin.googleUsage.sku.placeDetailsEnterprise',
  place_details_atmosphere: 'admin.googleUsage.sku.placeDetailsAtmosphere',
  place_photos: 'admin.googleUsage.sku.placePhotos',
}

export default function GoogleApiUsagePanel() {
  const { t, locale } = useTranslation()
  const [usage, setUsage] = useState<GoogleApiUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const data = await adminApi.getGoogleApiUsage()
      setUsage(Array.isArray(data.usage) ? data.usage : [])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const period = usage[0]

  return (
    <section className="rounded-xl border border-edge bg-surface-card overflow-hidden" aria-labelledby="google-api-usage-title">
      <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-edge">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-content-secondary">
            <Gauge className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h2 id="google-api-usage-title" className="font-semibold text-content">{t('admin.googleUsage.title')}</h2>
            <p className="mt-1 text-xs leading-relaxed text-content-faint">{t('admin.googleUsage.scope')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('admin.googleUsage.refresh')}
          className="inline-flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-xs font-medium text-content-secondary transition-colors hover:bg-surface-secondary disabled:cursor-wait disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span className="hidden sm:inline">{t('admin.googleUsage.refreshShort')}</span>
        </button>
      </div>

      {loading && usage.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-content-faint" role="status" aria-label={t('admin.googleUsage.loading')}>
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span>{t('admin.googleUsage.loading')}</span>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden="true" />
          <p className="text-sm text-content-secondary">{t('admin.googleUsage.loadError')}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-content px-3 py-2 text-xs font-medium text-surface-card"
          >
            {t('admin.googleUsage.retry')}
          </button>
        </div>
      ) : (
        <div className="p-6">
          {period && (
            <p className="mb-4 text-xs text-content-faint">
              {t('admin.googleUsage.period')}: <span className="font-medium text-content-secondary">{period.period}</span>
              {' · '}{period.timezone}
            </p>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {usage.map((item) => {
              const percentage = item.cap <= 0 ? 100 : Math.min(100, Math.round((item.used / item.cap) * 100))
              const label = t(SKU_LABEL_KEYS[item.sku])
              return (
                <article key={item.sku} className={`rounded-lg border p-4 ${item.exhausted ? 'border-red-200 bg-red-50/60 dark:border-red-900 dark:bg-red-950/20' : 'border-edge bg-surface-secondary/50'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium text-content">{label}</h3>
                      <p className="mt-1 text-xs text-content-faint">
                        {t('admin.googleUsage.remaining', { count: numberFormat.format(item.remaining) })}
                      </p>
                    </div>
                    {item.exhausted && (
                      <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-1 text-[10px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        {t('admin.googleUsage.exhausted')}
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-3 h-2 overflow-hidden rounded-full bg-edge"
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={item.cap}
                    aria-valuenow={Math.min(item.used, item.cap)}
                  >
                    <div
                      className={`h-full rounded-full transition-[width] ${item.exhausted ? 'bg-red-500' : percentage >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                    <span className="font-semibold tabular-nums text-content">
                      {numberFormat.format(item.used)} / {numberFormat.format(item.cap)}
                    </span>
                    <span className="text-right text-content-faint">
                      {item.official_free_cap === null
                        ? t('admin.googleUsage.officialUnlimited')
                        : t('admin.googleUsage.officialCap', { count: numberFormat.format(item.official_free_cap) })}
                    </span>
                  </div>
                </article>
              )
            })}
          </div>
          <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {t('admin.googleUsage.failedCalls')}
          </p>
        </div>
      )}
    </section>
  )
}
