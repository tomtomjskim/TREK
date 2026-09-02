import { useEffect, useState, useCallback, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useVacayStore } from '../../store/vacayStore'
import { addListener, removeListener } from '../../api/websocket'
import { getApiErrorMessage } from '../../utils/apiError'
import { lockBodyScroll } from '../../utils/bodyScrollLock'

/**
 * Vacay page logic — owns the page-local destructive-state and focus contracts
 * while preserving v4's shared-calendar reload paths.
 */
export function useVacay() {
  const {
    years, selectedYear, setSelectedYear, addYear, removeYear,
    loadAll, loadPlan, loadEntries, loadStats, loadHolidays,
    loadShares, loadSharedCalendars, sharedCalendars,
    loading, incomingInvites, pendingInvites,
    acceptInvite: acceptInviteRequest, declineInvite,
    plan, isFused,
  } = useVacayStore()
  const [showSettings, setShowSettings] = useState(false)
  const [deleteYear, setDeleteYear] = useState<number | null>(null)
  const [isRemovingYear, setIsRemovingYear] = useState(false)
  const [deleteYearError, setDeleteYearError] = useState(false)
  const [yearRemovalNotice, setYearRemovalNotice] = useState<'fused' | 'pending' | null>(null)
  const [inviteAcceptError, setInviteAcceptError] = useState<{ planId: number; message: string } | null>(null)
  const [showMobileSidebar, setShowMobileSidebar] = useState(false)
  const mobileSidebarButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileDrawerCloseButtonRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLButtonElement | null>(null)
  const previousDeleteYearRef = useRef<number | null>(deleteYear)
  const yearRemovalReadOnlyReason: 'fused' | 'pending' | null = isFused
    ? 'fused'
    : pendingInvites.length > 0
      ? 'pending'
      : null

  useEffect(() => { loadAll() }, [])

  // A live fusion/invitation transition invalidates an already-open destructive
  // prompt. The server repeats this check atomically when the request arrives.
  useEffect(() => {
    if (yearRemovalReadOnlyReason === null || deleteYear === null) return
    setDeleteYear(null)
    setDeleteYearError(false)
    setYearRemovalNotice(yearRemovalReadOnlyReason)
  }, [deleteYear, yearRemovalReadOnlyReason])

  useEffect(() => {
    const wasOpen = previousDeleteYearRef.current !== null
    previousDeleteYearRef.current = deleteYear
    if (!wasOpen || deleteYear !== null) return

    const frame = window.requestAnimationFrame(() => returnFocusRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [deleteYear])

  const closeMobileSidebar = useCallback(() => {
    setShowMobileSidebar(false)
    window.requestAnimationFrame(() => mobileSidebarButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!showMobileSidebar) return

    const releaseBodyScroll = lockBodyScroll()
    const frame = window.requestAnimationFrame(
      () => mobileDrawerCloseButtonRef.current?.focus()
    )
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = mobileDrawerCloseButtonRef.current?.closest('[role="dialog"]')
      if (!dialog) return
      if (event.key === 'Escape') {
        const nestedModal = Array.from(document.querySelectorAll<HTMLElement>('[data-trek-modal="true"]'))
          .some(modal => !dialog.contains(modal))
        if (nestedModal) return
        event.preventDefault()
        closeMobileSidebar()
        return
      }
      if (event.key !== 'Tab') return
      const nestedModal = Array.from(document.querySelectorAll<HTMLElement>('[data-trek-modal="true"]'))
        .some(modal => !dialog.contains(modal))
      if (nestedModal) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(el => el.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) return
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
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      releaseBodyScroll()
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMobileSidebar, showMobileSidebar])

  const handleWsMessage = useCallback((msg: { type: string }) => {
    if (msg.type === 'vacay:update' || msg.type === 'vacay:settings') {
      loadPlan()
      loadEntries(selectedYear)
      loadStats(selectedYear)
      if (msg.type === 'vacay:settings') loadAll()
    }
    if (msg.type === 'vacay:invite' || msg.type === 'vacay:accepted' || msg.type === 'vacay:declined' || msg.type === 'vacay:cancelled' || msg.type === 'vacay:dissolved') {
      loadAll()
    }
    if (msg.type === 'vacay:share' || msg.type === 'vacay:share-removed' || msg.type === 'vacay:shared-update') {
      loadShares()
      loadSharedCalendars(selectedYear)
    }
  }, [selectedYear])

  useEffect(() => {
    addListener(handleWsMessage)
    return () => removeListener(handleWsMessage)
  }, [handleWsMessage])

  useEffect(() => {
    if (!selectedYear) return
    loadEntries(selectedYear)
    loadStats(selectedYear)
    loadHolidays(selectedYear)
    loadSharedCalendars(selectedYear)
  }, [selectedYear])

  const handleAddNextYear = () => {
    const nextYear = years.length > 0 ? Math.max(...years) + 1 : new Date().getFullYear()
    addYear(nextYear)
  }

  const handleAddPrevYear = () => {
    const prevYear = years.length > 0 ? Math.min(...years) - 1 : new Date().getFullYear()
    addYear(prevYear)
  }

  const requestYearRemoval = (year: number) => {
    if (yearRemovalReadOnlyReason !== null || isRemovingYear) return
    setDeleteYearError(false)
    setYearRemovalNotice(null)
    setDeleteYear(year)
    setShowMobileSidebar(false)
  }

  const openYearRemoval = (event: MouseEvent<HTMLButtonElement>) => {
    returnFocusRef.current = showMobileSidebar
      ? mobileSidebarButtonRef.current
      : event.currentTarget
    requestYearRemoval(selectedYear)
  }

  const cancelYearRemoval = () => {
    if (isRemovingYear) return
    setDeleteYearError(false)
    setDeleteYear(null)
  }

  const confirmYearRemoval = async () => {
    if (deleteYear === null || yearRemovalReadOnlyReason !== null || isRemovingYear) return

    setIsRemovingYear(true)
    setDeleteYearError(false)
    try {
      await removeYear(deleteYear)
      setDeleteYear(null)
    } catch {
      setDeleteYearError(true)
      try {
        await loadPlan()
      } catch {
        // Keep the destructive prompt retryable even if state refresh also fails.
      }
    } finally {
      setIsRemovingYear(false)
    }
  }

  const acceptInvite = async (planId: number) => {
    setInviteAcceptError(null)
    try {
      await acceptInviteRequest(planId)
    } catch (error) {
      setInviteAcceptError({
        planId,
        message: getApiErrorMessage(error, 'Unable to accept invitation'),
      })
    }
  }

  return {
    years, selectedYear, setSelectedYear, loading,
    incomingInvites, acceptInvite, declineInvite, inviteAcceptError, plan, sharedCalendars,
    showSettings, setShowSettings,
    deleteYear, isRemovingYear, deleteYearError,
    yearRemovalReadOnlyReason, yearRemovalNotice,
    showMobileSidebar,
    mobileSidebarButtonRef, mobileDrawerCloseButtonRef,
    openMobileSidebar: () => setShowMobileSidebar(true),
    closeMobileSidebar, openYearRemoval,
    handleAddNextYear, handleAddPrevYear,
    requestYearRemoval, cancelYearRemoval, confirmYearRemoval,
  }
}
