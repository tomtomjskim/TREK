import { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'
import type {
  Place,
  PlaceEnrichmentApplyResult,
  PlaceEnrichmentPreviewResult,
} from '@trek/shared'
import { placesApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useTripStore } from '../../store/tripStore'

interface PlaceEnrichmentModalProps {
  isOpen: boolean
  onClose: () => void
  tripId: number
  places: Place[]
}

type Phase = 'intro' | 'scanning' | 'results' | 'applying' | 'done'

function responseError(error: unknown): { code?: string; message?: string } {
  const response = (error as { response?: { data?: { code?: string; error?: string } } })?.response
  return { code: response?.data?.code, message: response?.data?.error }
}

export function PlaceEnrichmentModal({ isOpen, onClose, tripId, places }: PlaceEnrichmentModalProps) {
  const { t, language } = useTranslation()
  const loadTrip = useTripStore((state) => state.loadTrip)
  const [phase, setPhase] = useState<Phase>('intro')
  const [preview, setPreview] = useState<PlaceEnrichmentPreviewResult | null>(null)
  const [applyResult, setApplyResult] = useState<PlaceEnrichmentApplyResult | null>(null)
  const [choices, setChoices] = useState<Record<number, string>>({})
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const firstActionRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const footerCloseRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  const busyRef = useRef(false)

  const closeModal = () => {
    const shouldRefresh = applyResult !== null
    onClose()
    // The mutation response and websocket already carry the saved rows. Delay
    // the broader trip reconciliation until after the user has seen the result,
    // so a parent remount cannot erase the completion state.
    if (shouldRefresh) void loadTrip(tripId).catch(() => undefined)
  }

  onCloseRef.current = closeModal
  busyRef.current = phase === 'scanning' || phase === 'applying'

  const eligible = useMemo(() => places.filter((place) =>
    !place.google_place_id?.trim()
    && typeof place.lat === 'number'
    && typeof place.lng === 'number',
  ).slice(0, 100), [places])

  useEffect(() => {
    if (!isOpen) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => firstActionRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      previous?.focus?.()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || (phase !== 'results' && phase !== 'done')) return
    const frame = requestAnimationFrame(() => {
      if (phase === 'done') {
        footerCloseRef.current?.focus()
        return
      }
      const resultControl = dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled])',
      )
      ;(resultControl ?? footerCloseRef.current ?? dialogRef.current)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [isOpen, phase])

  useEffect(() => {
    if (!isOpen) {
      setPhase('intro')
      setPreview(null)
      setApplyResult(null)
      setChoices({})
      setSelected(new Set())
      setError(null)
    }
  }, [isOpen])

  if (!isOpen) return null

  const scan = async () => {
    setPhase('scanning')
    setError(null)
    try {
      const result = await placesApi.previewEnrichment(tripId, { lang: language })
      const nextChoices: Record<number, string> = {}
      const nextSelected = new Set<number>()
      for (const entry of result.entries) {
        const candidate = entry.candidates[0]
        if (!candidate) continue
        nextChoices[entry.place_id] = candidate.google_place_id
        if (candidate.confidence === 'safe') nextSelected.add(entry.place_id)
      }
      setPreview(result)
      setChoices(nextChoices)
      setSelected(nextSelected)
      setPhase('results')
    } catch (caught) {
      const detail = responseError(caught)
      setError(detail.code === 'GOOGLE_API_MONTHLY_CAP_REACHED'
        ? t('places.enrichmentQuotaReached')
        : detail.message || t('places.enrichmentFailed'))
      setPhase('intro')
    }
  }

  const apply = async () => {
    const matches = [...selected].flatMap((placeId) => {
      const googlePlaceId = choices[placeId]
      return googlePlaceId ? [{ place_id: placeId, google_place_id: googlePlaceId }] : []
    })
    if (!matches.length) return
    setPhase('applying')
    setError(null)
    try {
      const result = await placesApi.applyEnrichment(tripId, { matches, lang: language })
      setApplyResult(result)
      setPhase('done')
    } catch (caught) {
      const detail = responseError(caught)
      setError(detail.code === 'GOOGLE_API_MONTHLY_CAP_REACHED'
        ? t('places.enrichmentQuotaReached')
        : detail.message || t('places.enrichmentApplyFailed'))
      setPhase('results')
    }
  }

  const toggleSelected = (placeId: number) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(placeId)) next.delete(placeId)
      else next.add(placeId)
      return next
    })
  }

  const textSearchUsage = preview?.usage.find((row) => row.sku === 'text_search_pro')
  const busy = phase === 'scanning' || phase === 'applying'

  return ReactDOM.createPortal(
    <div
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) closeModal() }}
      className="bg-[rgba(0,0,0,0.48)]"
      style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="place-enrichment-title"
        tabIndex={-1}
        className="bg-surface-card text-content"
        style={{
          width: '100%', maxWidth: 720, maxHeight: 'min(86vh, 820px)', borderRadius: 18,
          boxShadow: '0 24px 70px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          border: '1px solid var(--border-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 20px 14px', borderBottom: '1px solid var(--border-faint)' }}>
          <div style={{
            width: 36, height: 36, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
          }}>
            <RefreshCw size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="place-enrichment-title" style={{ margin: 0, fontSize: 'calc(17px * var(--fs-scale-title, 1))', lineHeight: 1.25 }}>
              {t('places.enrichmentTitle')}
            </h2>
            <p className="text-content-faint" style={{ margin: '5px 0 0', fontSize: 'calc(12px * var(--fs-scale-body, 1))', lineHeight: 1.45 }}>
              {t('places.enrichmentIntro')}
            </p>
          </div>
          <button
            ref={footerCloseRef}
            onClick={closeModal}
            disabled={busy}
            aria-label={t('common.close')}
            style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: 5, cursor: busy ? 'default' : 'pointer', borderRadius: 8 }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 20, overflowY: 'auto', minHeight: 0 }}>
          {phase === 'intro' && (
            <>
              <div className="bg-surface-tertiary" style={{ borderRadius: 12, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <ShieldCheck size={18} color="var(--accent)" style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  <div style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', fontWeight: 650 }}>{t('places.enrichmentBillingTitle')}</div>
                  <div className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', lineHeight: 1.5, marginTop: 3 }}>
                    {t('places.enrichmentBillingHint')}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 16, fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>
                {eligible.length > 0
                  ? t('places.enrichmentEligible', { count: eligible.length })
                  : t('places.enrichmentNoEligible')}
              </div>
            </>
          )}

          {phase === 'scanning' && (
            <div aria-live="polite" style={{ minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <Loader2 size={26} className="animate-spin" color="var(--accent)" />
              <span>{t('places.enrichmentScanning')}</span>
            </div>
          )}

          {(phase === 'results' || phase === 'applying') && preview && (
            <>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 650 }}>
                  {t('places.enrichmentResults', { count: preview.entries.length })}
                </span>
                {textSearchUsage && (
                  <span className="text-content-faint" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))' }}>
                    Text Search Pro: {textSearchUsage.used.toLocaleString()} / {textSearchUsage.cap.toLocaleString()}
                  </span>
                )}
              </div>

              <div style={{ display: 'grid', gap: 9 }}>
                {preview.entries.map((entry) => {
                  const choice = choices[entry.place_id] || ''
                  const chosen = entry.candidates.find((candidate) => candidate.google_place_id === choice)
                  const hasCandidates = entry.candidates.length > 0
                  return (
                    <div key={entry.place_id} className="bg-surface-tertiary" style={{ borderRadius: 12, padding: 12, border: '1px solid var(--border-faint)' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(entry.place_id)}
                          disabled={!hasCandidates || phase === 'applying'}
                          onChange={() => toggleSelected(entry.place_id)}
                          aria-label={t('places.enrichmentSelect', { name: entry.place_name })}
                          style={{ marginTop: 3, accentColor: 'var(--accent)' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 650, fontSize: 'calc(13px * var(--fs-scale-body, 1))' }}>{entry.place_name}</div>
                          {!hasCandidates ? (
                            <div className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))', marginTop: 4 }}>
                              {t('places.enrichmentNoMatch')}
                            </div>
                          ) : (
                            <>
                              <select
                                value={choice}
                                disabled={phase === 'applying'}
                                onChange={(event) => setChoices((current) => ({ ...current, [entry.place_id]: event.target.value }))}
                                aria-label={t('places.enrichmentCandidate', { name: entry.place_name })}
                                className="bg-surface-card text-content"
                                style={{ width: '100%', marginTop: 7, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '7px 9px', fontFamily: 'inherit' }}
                              >
                                {entry.candidates.map((candidate) => (
                                  <option key={candidate.google_place_id} value={candidate.google_place_id}>
                                    {candidate.name} · {candidate.distance_meters}m
                                  </option>
                                ))}
                              </select>
                              {chosen && (
                                <div className="text-content-faint" style={{ fontSize: 'calc(11px * var(--fs-scale-caption, 1))', marginTop: 5, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                                  <span>{chosen.confidence === 'safe' ? t('places.enrichmentSafe') : t('places.enrichmentReview')}</span>
                                  {chosen.address && <span>{chosen.address}</span>}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {preview.errors.length > 0 && (
                <div role="alert" style={{ marginTop: 12, display: 'flex', gap: 8, color: 'var(--warning, #b45309)', fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                  {preview.errors.length === 1
                    ? t('places.enrichmentScanErrorSingular')
                    : t('places.enrichmentScanErrors', { count: preview.errors.length })}
                </div>
              )}

              {preview.stopped && (
                <div style={{ marginTop: 12, display: 'flex', gap: 8, color: 'var(--warning, #b45309)', fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                  {preview.stopped.code === 'GOOGLE_API_MONTHLY_CAP_REACHED'
                    ? t('places.enrichmentQuotaReached')
                    : preview.stopped.error}
                </div>
              )}
            </>
          )}

          {phase === 'done' && applyResult && (
            <div aria-live="polite" style={{ minHeight: 180, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 10 }}>
              <CheckCircle2 size={34} color="var(--success, #16a34a)" />
              <div style={{ fontWeight: 700, fontSize: 'calc(16px * var(--fs-scale-subtitle, 1))' }}>
                {applyResult.updated.length === 1
                  ? t('places.enrichmentUpdatedSingular')
                  : t('places.enrichmentUpdated', { count: applyResult.updated.length })}
              </div>
              <div className="text-content-faint" style={{ fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                {t('places.enrichmentDoneHint')}
              </div>
              {applyResult.stopped && (
                <div role="alert" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--warning, #b45309)', fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                  {applyResult.stopped.code === 'GOOGLE_API_MONTHLY_CAP_REACHED'
                    ? t('places.enrichmentQuotaReached')
                    : applyResult.stopped.error}
                </div>
              )}
              {applyResult.errors.length > 0 && (
                <div role="alert" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--warning, #b45309)', fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
                  <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                  {applyResult.errors.length === 1
                    ? t('places.enrichmentApplyErrorSingular')
                    : t('places.enrichmentApplyErrors', { count: applyResult.errors.length })}
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'flex-start', color: 'var(--danger, #dc2626)', fontSize: 'calc(12px * var(--fs-scale-body, 1))' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} /> {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '13px 20px 18px', borderTop: '1px solid var(--border-faint)' }}>
          <button
            onClick={closeModal}
            disabled={busy}
            style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-primary)', cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit' }}
          >
            {phase === 'done' ? t('common.close') : t('common.cancel')}
          </button>
          {phase === 'intro' && (
            <button
              ref={firstActionRef}
              onClick={scan}
              disabled={eligible.length === 0}
              className={eligible.length ? 'bg-accent text-accent-text' : 'bg-surface-tertiary text-content-faint'}
              style={{ padding: '8px 14px', borderRadius: 9, border: 'none', cursor: eligible.length ? 'pointer' : 'default', fontFamily: 'inherit', fontWeight: 600 }}
            >
              {eligible.length === 1
                ? t('places.enrichmentScanSingular')
                : t('places.enrichmentScan', { count: eligible.length })}
            </button>
          )}
          {(phase === 'results' || phase === 'applying') && (
            <button
              onClick={apply}
              disabled={selected.size === 0 || phase === 'applying'}
              className={selected.size && phase !== 'applying' ? 'bg-accent text-accent-text' : 'bg-surface-tertiary text-content-faint'}
              style={{ minWidth: 130, padding: '8px 14px', borderRadius: 9, border: 'none', cursor: selected.size && phase !== 'applying' ? 'pointer' : 'default', fontFamily: 'inherit', fontWeight: 600 }}
            >
              {phase === 'applying'
                ? t('places.enrichmentApplying')
                : t('places.enrichmentApply', { count: selected.size })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
