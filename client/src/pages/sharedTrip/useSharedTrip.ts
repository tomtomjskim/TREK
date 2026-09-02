import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router'
import { shareApi } from '../../api/client'
import { useExchangeRates } from '../../hooks/useExchangeRates'

function isPopupCloseControl(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('.leaflet-popup-close-button'))
}

/**
 * Shared-trip (public) data hook — owns the token lookup, the read-only share
 * fetch and the view state (selected day, active tab, language picker).
 * SharedTripPage is a pure wiring container; the post-load derivations
 * (sortedDays, map places, …) stay in the page next to the JSX that uses them.
 * Behaviour is identical to the previous in-component logic.
 */
export function useSharedTrip() {
  const { token } = useParams<{ token: string }>()
  // The shared payload is an open-ended snapshot (trip, days, assignments, …),
  // matched 1:1 from the public share endpoint — kept loosely typed as before.
  const [loadState, setLoadState] = useState<{ token: string | null; data: any; error: boolean }>({
    token: null,
    data: null,
    error: false,
  })
  // Never render token A's snapshot under token B, even for the single render
  // before the token-change effect resets the request state.
  const data = loadState.token === token ? loadState.data : null
  const error = loadState.token === token ? loadState.error : false
  const [selectedDay, setSelectedDay] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState('plan')
  const [showLangPicker, setShowLangPicker] = useState(false)
  const markerRefs = useRef(new Map<string, any>())
  const keyboardOpenerRef = useRef<{ key: string; element: HTMLElement } | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const popupListenerCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let current = true
    setSelectedDay(null)
    setActiveTab('plan')
    setShowLangPicker(false)
    markerRefs.current.clear()
    popupListenerCleanupRef.current?.()
    popupListenerCleanupRef.current = null
    keyboardOpenerRef.current = null
    shouldRestoreFocusRef.current = false

    if (!token) {
      setLoadState({ token: null, data: null, error: false })
      return () => { current = false }
    }

    setLoadState({ token, data: null, error: false })
    shareApi.getSharedTrip(token)
      .then(nextData => {
        if (current) setLoadState({ token, data: nextData, error: false })
      })
      .catch(() => {
        if (current) setLoadState({ token, data: null, error: true })
      })
    return () => { current = false }
  }, [token])

  // The server now withholds the whole itinerary when the owner disabled the map
  // (share_map=false), so the Plan tab has nothing to show — land on the first
  // section the owner actually shared instead of an empty map.
  useEffect(() => {
    if (!data) return
    const p = data.permissions || {}
    if (p.share_map === false && activeTab === 'plan') {
      setActiveTab(
        p.share_bookings ? 'bookings' : p.share_packing ? 'packing' : p.share_budget ? 'budget' : p.share_collab ? 'collab' : ''
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // Budget display currency = what the share owner sees in Costs (embedded in the
  // payload as baseCurrency), falling back to the trip's own currency, then EUR.
  // Convert every expense into it via live FX, mirroring CostsPanel — a public
  // viewer has no settings store, so the base comes from the payload (#1361).
  const base = String(data?.baseCurrency || data?.trip?.currency || 'EUR').toUpperCase()
  const { convert } = useExchangeRates(base)

  const clearKeyboardOpener = () => {
    popupListenerCleanupRef.current?.()
    popupListenerCleanupRef.current = null
    keyboardOpenerRef.current = null
    shouldRestoreFocusRef.current = false
  }

  const recordKeyboardOpener = (key: string, marker: any) => {
    const markerElement = marker?.getElement?.() ?? markerRefs.current.get(key)?.getElement?.()
    if (!markerElement) return
    popupListenerCleanupRef.current?.()
    popupListenerCleanupRef.current = null
    keyboardOpenerRef.current = { key, element: markerElement }
    shouldRestoreFocusRef.current = false
  }

  // Leaflet creates the close control outside React's Popup children. These
  // listeners are attached only to the opened Popup so this public page never
  // reaches into another map instance (or the rest of the document).
  const onMarkerPopupOpen = (key: string, event: any) => {
    const marker = event.target
    const markerElement = marker?.getElement?.()
    const opener = keyboardOpenerRef.current
    if (!markerElement || opener?.key !== key || opener.element !== markerElement) {
      clearKeyboardOpener()
    }

    const popupElement = marker?.getPopup?.()?.getElement?.()
    if (!popupElement) return
    popupListenerCleanupRef.current?.()
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') {
        keyboardEvent.preventDefault()
        keyboardEvent.stopPropagation()
        shouldRestoreFocusRef.current = true
        marker.closePopup?.()
      } else if (
        (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') &&
        isPopupCloseControl(keyboardEvent.target)
      ) {
        shouldRestoreFocusRef.current = true
      }
    }
    const onPointerDown = (pointerEvent: Event) => {
      if (isPopupCloseControl(pointerEvent.target)) shouldRestoreFocusRef.current = false
    }
    popupElement.addEventListener('keydown', onKeyDown, true)
    popupElement.addEventListener('pointerdown', onPointerDown, true)
    popupElement.addEventListener('touchstart', onPointerDown, true)
    popupListenerCleanupRef.current = () => {
      popupElement.removeEventListener('keydown', onKeyDown, true)
      popupElement.removeEventListener('pointerdown', onPointerDown, true)
      popupElement.removeEventListener('touchstart', onPointerDown, true)
    }
  }

  const onMarkerPopupClose = (key: string, event: any) => {
    popupListenerCleanupRef.current?.()
    popupListenerCleanupRef.current = null
    const opener = keyboardOpenerRef.current
    const markerElement = event.target?.getElement?.()
    if (opener?.key === key && opener.element === markerElement && shouldRestoreFocusRef.current) {
      queueMicrotask(() => opener.element.focus())
    }
    if (opener?.key === key) clearKeyboardOpener()
  }

  useEffect(() => () => popupListenerCleanupRef.current?.(), [])

  return {
    data,
    error,
    base,
    convert,
    selectedDay,
    setSelectedDay,
    activeTab,
    setActiveTab,
    showLangPicker,
    setShowLangPicker,
    markerRefs,
    clearKeyboardOpener,
    recordKeyboardOpener,
    onMarkerPopupOpen,
    onMarkerPopupClose,
  }
}
