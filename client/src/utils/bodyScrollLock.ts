/**
 * The one body scroll lock every overlay in the app shares.
 *
 * Below 768px the document itself is the scroller now (#1809), so locking is no
 * longer cosmetic: an overlay that resets `body.style.overflow` unconditionally
 * really does unlock the page behind another overlay that is still open (a
 * system notice re-running its effect used to do exactly that to an open
 * sheet). Overlays stack, so the first lock remembers the original value and
 * only the last release puts it back.
 */
let locks = 0
let savedOverflow = ''
let savedRootOverflow = ''
let savedPosition = ''
let savedTop = ''
let savedLeft = ''
let savedRight = ''
let savedWidth = ''
let savedScrollX = 0
let savedScrollY = 0

/**
 * Locks body scrolling and returns the matching release. Releasing twice is a
 * no-op, so the return value can be used directly as an effect cleanup.
 */
export function lockBodyScroll(): () => void {
  if (locks === 0) {
    savedOverflow = document.body.style.overflow
    savedRootOverflow = document.documentElement.style.overflow
    savedPosition = document.body.style.position
    savedTop = document.body.style.top
    savedLeft = document.body.style.left
    savedRight = document.body.style.right
    savedWidth = document.body.style.width
    savedScrollX = window.scrollX
    savedScrollY = window.scrollY
    document.body.style.overflow = 'hidden'
    // WebKit keeps the root element as document.scrollingElement. Locking only
    // body therefore leaves the page behind a modal programmatically scrollable.
    document.documentElement.style.overflow = 'hidden'
    // Safari/WebKit still honours programmatic root scrolling with overflow
    // hidden. Pinning the body keeps the page visually stationary for both
    // touch gestures and script-driven scroll while an overlay is open.
    document.body.style.position = 'fixed'
    document.body.style.top = `-${savedScrollY}px`
    document.body.style.left = `-${savedScrollX}px`
    document.body.style.right = '0'
    document.body.style.width = '100%'
  }
  locks += 1

  let released = false
  return () => {
    if (released) return
    released = true
    locks = Math.max(0, locks - 1)
    if (locks === 0) {
      document.body.style.overflow = savedOverflow
      document.documentElement.style.overflow = savedRootOverflow
      document.body.style.position = savedPosition
      document.body.style.top = savedTop
      document.body.style.left = savedLeft
      document.body.style.right = savedRight
      document.body.style.width = savedWidth
      const scrollingElement = document.scrollingElement ?? document.documentElement
      const rootMoved =
        scrollingElement.scrollLeft !== savedScrollX ||
        scrollingElement.scrollTop !== savedScrollY ||
        window.scrollX !== savedScrollX ||
        window.scrollY !== savedScrollY
      if (savedScrollX !== 0 || savedScrollY !== 0 || rootMoved) {
        window.scrollTo(savedScrollX, savedScrollY)
      }
    }
  }
}

/** How many locks are currently held. For tests and diagnostics. */
export function bodyScrollLocks(): number {
  return locks
}

/** Test seam: the counter is module state and outlives a single test case. */
export function resetBodyScrollLock(): void {
  locks = 0
  savedOverflow = ''
  savedRootOverflow = ''
  savedPosition = ''
  savedTop = ''
  savedLeft = ''
  savedRight = ''
  savedWidth = ''
  savedScrollX = 0
  savedScrollY = 0
}
