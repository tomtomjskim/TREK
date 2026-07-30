import { useEffect, useState, useCallback, useRef } from 'react'
import type { MouseEvent } from 'react'
import { useVacayStore } from '../../store/vacayStore'
import { addListener, removeListener } from '../../api/websocket'

/**
 * Vacay page logic — pulls the vacay store, owns the page-local UI state
 * (settings modal, delete-year prompt, mobile drawer), wires the WebSocket live
 * sync and the per-year (re)loads, and exposes the add-prev/next-year helpers.
 * VacayPage stays a wiring container around its sidebar/calendar JSX.
 * Behaviour is identical to the previous in-component logic.
 */
export function useVacay() {
  const {
    years, selectedYear, setSelectedYear, addYear, removeYear,
    loadAll, loadPlan, loadEntries, loadStats, loadHolidays,
    loading, incomingInvites, pendingInvites, acceptInvite, declineInvite,
    plan, isFused,
  } = useVacayStore()
  const [showSettings, setShowSettings] = useState<boolean>(false)
  const [deleteYear, setDeleteYear] = useState<number | null>(null)
  const [isRemovingYear, setIsRemovingYear] = useState<boolean>(false)
  const [deleteYearError, setDeleteYearError] = useState<boolean>(false)
  const [yearRemovalNotice, setYearRemovalNotice] = useState<'fused' | 'pending' | null>(null)
  const [showMobileSidebar, setShowMobileSidebar] = useState<boolean>(false)
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

    const frame = window.requestAnimationFrame(
      () => mobileDrawerCloseButtonRef.current?.focus()
    )
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMobileSidebar()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeMobileSidebar, showMobileSidebar])

  // Live sync via WebSocket
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
  }, [selectedYear])

  useEffect(() => {
    addListener(handleWsMessage)
    return () => removeListener(handleWsMessage)
  }, [handleWsMessage])
  useEffect(() => {
    if (selectedYear) { loadEntries(selectedYear); loadStats(selectedYear); loadHolidays(selectedYear) }
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
    if (
      deleteYear === null
      || yearRemovalReadOnlyReason !== null
      || isRemovingYear
    ) return

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

  return {
    years, selectedYear, setSelectedYear, loading,
    incomingInvites, acceptInvite, declineInvite, plan,
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
