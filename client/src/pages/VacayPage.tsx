import React, { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '../i18n'
import PageShell from '../components/Layout/PageShell'
import VacayCalendar from '../components/Vacay/VacayCalendar'
import VacayPersons from '../components/Vacay/VacayPersons'
import VacaySharedCalendars from '../components/Vacay/VacaySharedCalendars'
import VacayStats from '../components/Vacay/VacayStats'
import VacaySettings from '../components/Vacay/VacaySettings'
import { Plus, Minus, ChevronLeft, ChevronRight, Settings, CalendarDays, AlertTriangle, Eye, Pencil, Trash2, Unlink, ShieldCheck, SlidersHorizontal, X } from 'lucide-react'
import Modal from '../components/shared/Modal'
import { useVacay } from './vacay/useVacay'

export default function VacayPage(): React.ReactElement {
  // ViewportRoute in App.tsx picks the branch now, so the phone screen is a
  // chunk of its own instead of a dead limb in this one.
  return <VacayPageDesktop />
}

function VacayPageDesktop(): React.ReactElement {
  const { t } = useTranslation()
  const deleteYearCancelRef = useRef<HTMLButtonElement>(null)
  // Page = wiring container: vacay store, live sync + UI state live in the hook.
  const {
    years, selectedYear, setSelectedYear, loading,
    incomingInvites, acceptInvite, declineInvite, inviteAcceptError, plan, sharedCalendars,
    showSettings, setShowSettings,
    deleteYear, isRemovingYear, deleteYearError,
    yearRemovalReadOnlyReason, yearRemovalNotice,
    showMobileSidebar,
    mobileSidebarButtonRef, mobileDrawerCloseButtonRef,
    openMobileSidebar, closeMobileSidebar, openYearRemoval,
    handleAddNextYear, handleAddPrevYear,
    cancelYearRemoval, confirmYearRemoval,
  } = useVacay()

  const yearRemovalReasonText = yearRemovalReadOnlyReason === 'pending'
    ? t('vacay.yearRemovalPendingReason')
    : yearRemovalReadOnlyReason === 'fused'
      ? t('vacay.yearRemovalFusedReason')
      : null

  const hasVisibleShared = sharedCalendars.some(c => !c.hidden)

  if (loading) {
    return (
      <PageShell background="var(--vg-bg)" contentClassName="flex items-center justify-center" contentStyle={{ minHeight: 'calc(100vh - var(--nav-h))' }}>
        <div className="w-8 h-8 border-2 rounded-full animate-spin border-edge border-t-content" />
      </PageShell>
    )
  }

  // Sidebar content (shared between desktop sidebar and mobile drawer)
  const sidebarContent = (
    <>
      {/* Year Selector */}
      <div className="vg-card rounded-[22px]" style={{ padding: '14px 18px' }}>
        <div className="mb-3">
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--vg-ink3)' }}>{t('vacay.year')}</span>
        </div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={handleAddPrevYear} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--vg-ink3)' }} title={t('vacay.addPrevYear')}>
              <Plus size={14} />
            </button>
            <button type="button" onClick={() => { const idx = years.indexOf(selectedYear); if (idx > 0) setSelectedYear(years[idx - 1]) }} disabled={years.indexOf(selectedYear) <= 0} className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-20 transition-colors" style={{ color: 'var(--vg-ink3)' }}>
              <ChevronLeft size={16} />
            </button>
          </div>
          <span className="tabular-nums" style={{ fontSize: 22, fontWeight: 700, color: 'var(--vg-ink)' }}>{selectedYear}</span>
          <div className="flex items-center gap-0.5">
            <button type="button" onClick={() => { const idx = years.indexOf(selectedYear); if (idx < years.length - 1) setSelectedYear(years[idx + 1]) }} disabled={years.indexOf(selectedYear) >= years.length - 1} className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-20 transition-colors" style={{ color: 'var(--vg-ink3)' }}>
              <ChevronRight size={16} />
            </button>
            <button type="button" onClick={handleAddNextYear} className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: 'var(--vg-ink3)' }} title={t('vacay.addYear')}>
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5">
          {years.map(y => (
            <button key={y} type="button" onClick={() => setSelectedYear(y)}
              aria-pressed={y === selectedYear}
              className="rounded-[9px] text-center cursor-pointer transition-[background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{
                padding: '7px 0',
                fontSize: 12,
                fontWeight: 600,
                background: y === selectedYear ? 'var(--vg-ink)' : 'var(--vg-surf2)',
                color: y === selectedYear ? 'var(--vg-bg)' : 'var(--vg-ink2)',
              }}>
              {y}
            </button>
          ))}
        </div>
        {years.length > 1 && (
          <>
            <button
              type="button"
              onClick={openYearRemoval}
              disabled={yearRemovalReadOnlyReason !== null}
              aria-label={[
                t('vacay.removeYearConfirm', { year: selectedYear }),
                yearRemovalReasonText,
              ].filter(Boolean).join(' — ')}
              className="mt-2 min-h-11 w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-300 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-edge disabled:text-content-faint disabled:hover:bg-transparent"
            >
              <Minus size={14} aria-hidden="true" />
              <span>{t('vacay.removeYear')}</span>
              <span className="tabular-nums">{selectedYear}</span>
            </button>
            {yearRemovalReasonText && (
              <p className="mt-1.5 text-center text-xs text-content-muted">
                {yearRemovalReasonText}
              </p>
            )}
          </>
        )}
      </div>

      <VacayPersons />

      <VacaySharedCalendars />

      {/* Legend */}
      {(plan?.holidays_enabled || plan?.school_holidays_enabled || plan?.company_holidays_enabled || plan?.block_weekends || hasVisibleShared) && (
        <div className="vg-card rounded-[22px]" style={{ padding: '14px 18px' }}>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--vg-ink3)' }}>{t('vacay.legend')}</span>
          <div className="mt-3 flex flex-wrap gap-x-3.5 gap-y-2.5">
            {plan?.holidays_enabled && (plan?.holiday_calendars ?? []).filter(cal => (cal.type ?? 'public_holiday') === 'public_holiday').length === 0 && (
              <LegendItem color="#fecaca" label={t('vacay.publicHoliday')} />
            )}
            {plan?.holidays_enabled && (plan?.holiday_calendars ?? []).filter(cal => (cal.type ?? 'public_holiday') === 'public_holiday').map(cal => (
              <LegendItem key={cal.id} color={cal.color} label={cal.label || cal.region} />
            ))}
            {plan?.school_holidays_enabled && (plan?.holiday_calendars ?? []).filter(cal => cal.type === 'school_holiday').map(cal => (
              <LegendItem key={cal.id} color={cal.color} label={cal.label || cal.region} />
            ))}
            {plan?.company_holidays_enabled && <LegendItem color="#fde68a" label={t('vacay.companyHoliday')} />}
            {plan?.block_weekends && <LegendItem color="#e5e7eb" label={t('vacay.weekend')} />}
            {hasVisibleShared && <LegendItem ring label={t('vacay.sharedLegend')} />}
          </div>
        </div>
      )}

      <VacayStats />
    </>
  )

  return (
    <PageShell background="var(--vg-bg)">
        <div className="max-w-[1800px] mx-auto px-3 sm:px-4 lg:px-8 py-4 lg:py-9">
          {/* Mobile + tablet header (filter toggle lives here) */}
          <div className="lg:hidden flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-surface-secondary">
                <CalendarDays size={18} className="text-content" />
              </div>
              <h1 className="text-lg font-bold text-content">{t('admin.addons.catalog.vacay.name')}</h1>
            </div>
            <div className="flex items-center gap-2">
              <button type="button"
                ref={mobileSidebarButtonRef}
                aria-label={`${t('vacay.year')} ${t('common.open')}`}
                onClick={openMobileSidebar}
                className="lg:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors bg-surface-secondary text-content-muted"
              >
                <SlidersHorizontal size={14} />
              </button>
              <button type="button"
                onClick={() => setShowSettings(true)}
                aria-label={t('vacay.settings')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors bg-surface-secondary text-content-muted"
              >
                <Settings size={14} />
              </button>
            </div>
          </div>

          {/* Main layout */}
          <div className="flex gap-4 lg:gap-7 items-start">
            {/* Desktop Sidebar */}
            <div className="hidden lg:flex w-[300px] shrink-0 flex-col gap-[12px] sticky top-[84px]">
              {sidebarContent}
              <button type="button"
                onClick={() => setShowSettings(true)}
                className="vg-card flex items-center justify-center gap-2.5 rounded-[18px] transition-transform hover:-translate-y-px"
                style={{ padding: '13px 16px', fontSize: 14, fontWeight: 600, color: 'var(--vg-ink)', cursor: 'pointer' }}
              >
                <Settings size={16} strokeWidth={2.2} /> {t('vacay.settings')}
              </button>
            </div>

            {/* Calendar */}
            <div className="flex-1 min-w-0">
              <VacayCalendar />
            </div>
          </div>
        </div>

      {/* Mobile Sidebar Drawer */}
      {showMobileSidebar && createPortal(
        <div className="fixed inset-0 lg:hidden" style={{ zIndex: 99980 }}>
          <div aria-hidden="true" className="absolute inset-0 bg-[rgba(0,0,0,0.4)]" onClick={closeMobileSidebar} />
          <div role="dialog" aria-modal="true" aria-label={`${t('vacay.year')} ${t('vacay.settings')}`} className="absolute left-0 top-0 bottom-0 w-[280px] overflow-y-auto p-3 flex flex-col gap-3 bg-surface"
            style={{ boxShadow: '4px 0 24px rgba(0,0,0,0.15)', animation: 'slideInLeft 0.2s ease-out' }}>
            <div className="flex min-h-11 items-center justify-between">
              <h2 className="text-sm font-semibold text-content">{t('vacay.year')}</h2>
              <button
                ref={mobileDrawerCloseButtonRef}
                type="button"
                onClick={closeMobileSidebar}
                aria-label={t('common.close')}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-content-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            {sidebarContent}
          </div>
        </div>,
        document.body
      )}

      {/* Settings Modal */}
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title={t('vacay.settings')} size="3xl">
        <VacaySettings onClose={() => setShowSettings(false)} />
      </Modal>

      {yearRemovalNotice && (
        <p role="status" aria-live="polite" className="sr-only">
          {yearRemovalNotice === 'pending'
            ? t('vacay.yearRemovalPendingNotice')
            : t('vacay.yearRemovalFusedNotice')}
        </p>
      )}

      {/* Delete Year Modal */}
      <Modal
        isOpen={deleteYear !== null}
        onClose={cancelYearRemoval}
        title={deleteYear === null
          ? t('vacay.removeYear')
          : t('vacay.removeYearConfirm', { year: deleteYear })}
        size="sm"
        hideCloseButton={isRemovingYear}
        dialogRole="alertdialog"
        ariaDescribedBy="vacay-remove-year-description"
        closeLabel={t('common.close')}
        initialFocusRef={deleteYearCancelRef}
      >
        <div className="space-y-4">
          <div className="flex gap-3 p-3 rounded-lg bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.15)]">
            <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p id="vacay-remove-year-description" className="text-xs text-content-muted">
                {t('vacay.removeYearHint')}
              </p>
            </div>
          </div>
          {deleteYearError && (
            <p role="alert" className="text-sm text-red-600">
              {t('vacay.yearRemovalError')}
            </p>
          )}
          <div className="flex gap-3 justify-end">
            <button ref={deleteYearCancelRef} type="button" onClick={cancelYearRemoval} disabled={isRemovingYear} className="px-4 py-2 text-sm rounded-lg transition-colors border text-content-muted border-edge disabled:cursor-not-allowed disabled:opacity-50">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={confirmYearRemoval} disabled={isRemovingYear} aria-busy={isRemovingYear ? 'true' : undefined} aria-label={t('vacay.removeYearConfirm', { year: deleteYear ?? '' })} className="px-4 py-2 text-sm bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60">
              {isRemovingYear ? t('common.loading') : t('vacay.remove')}
            </button>
          </div>
        </div>
      </Modal>

      {/* Incoming invite — explicit accept/decline only. The no-op close handler
          keeps Escape and backdrop clicks from silently discarding an invitation,
          while Modal supplies the shared focus, stack and body-lock contract. */}
      <Modal
        isOpen={incomingInvites.length > 0}
        onClose={() => undefined}
        title={t('vacay.inviteTitle')}
        size="sm"
        hideCloseButton
        zIndex={99995}
      >
        <div className="space-y-4">
          {incomingInvites.map(inv => (
            <div key={inv.plan_id} className="trek-modal-enter rounded-2xl shadow-2xl overflow-hidden bg-surface-card">
              <div className="px-6 pt-2 pb-4 text-center">
                <div className="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center text-lg font-bold bg-surface-secondary text-content">
                  {inv.owner_username?.[0]?.toUpperCase()}
                </div>
                <p className="text-sm text-content-muted">
                  <span className="font-semibold text-content">{inv.owner_username}</span> {t('vacay.inviteWantsToFuse')}
                </p>
              </div>
              <div className="px-6 pb-4 space-y-2">
                <InfoItem icon={Eye} text={t('vacay.fuseInfo1')} />
                <InfoItem icon={Pencil} text={t('vacay.fuseInfo2')} />
                <InfoItem icon={Trash2} text={t('vacay.fuseInfo3')} />
                <InfoItem icon={ShieldCheck} text={t('vacay.fuseInfo4')} />
                <InfoItem icon={Unlink} text={t('vacay.fuseInfo5')} />
              </div>
              {inviteAcceptError?.planId === inv.plan_id && (
                <p role="alert" className="mx-6 mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                  {inviteAcceptError.message}
                </p>
              )}
              <div className="px-6 pb-6 flex gap-3">
                <button type="button" onClick={() => declineInvite(inv.plan_id)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors border text-content-muted border-edge">
                  {t('vacay.decline')}
                </button>
                <button type="button" onClick={() => acceptInvite(inv.plan_id)}
                  className="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl transition-colors bg-content text-surface-card">
                  {t('vacay.acceptFusion')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <style>{`
        @keyframes slideInLeft {
          from { transform: translateX(-100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </PageShell>
  )
}

function InfoItem({ icon: Icon, text }: { icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>; text: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-3 px-3 py-2 rounded-lg bg-surface-secondary">
      <Icon size={15} className="shrink-0 mt-0.5 text-content-muted" />
      <span className="text-xs text-content">{text}</span>
    </div>
  )
}

function LegendItem({ color, label, ring }: { color?: string; label: string; ring?: boolean }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-[7px]">
      {/* Shared calendars render as rings in the grid, so the legend swatch does too. */}
      {ring
        ? <span style={{ width: 18, height: 12, borderRadius: 4, flex: 'none', border: '2px solid var(--vg-ink2)' }} />
        : <span style={{ width: 18, height: 12, borderRadius: 4, flex: 'none', background: color }} />}
      <span style={{ fontSize: 12, color: 'var(--vg-ink2)' }}>{label}</span>
    </span>
  )
}
