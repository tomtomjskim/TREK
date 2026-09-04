import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { lockBodyScroll, bodyScrollLocks, resetBodyScrollLock } from './bodyScrollLock'

/**
 * The lock only became load-bearing with #1809 (below 768px the document is the
 * scroller), and the bug it has to rule out is an overlay clearing a lock that
 * another overlay still holds.
 */
describe('bodyScrollLock', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    resetBodyScrollLock()
    document.body.style.overflow = ''
    document.body.style.position = ''
    document.body.style.top = ''
    document.body.style.left = ''
    document.body.style.right = ''
    document.body.style.width = ''
    document.documentElement.style.overflow = ''
    document.documentElement.scrollLeft = 0
    document.documentElement.scrollTop = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'scrollX')
    Reflect.deleteProperty(window, 'scrollY')
  })

  it('FE-UTIL-SCROLLLOCK-001: locks the body and restores the previous value', () => {
    document.body.style.overflow = 'auto'
    document.documentElement.style.overflow = 'scroll'
    const release = lockBodyScroll()
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')
    release()
    expect(document.body.style.overflow).toBe('auto')
    expect(document.documentElement.style.overflow).toBe('scroll')
  })

  it('FE-UTIL-SCROLLLOCK-002: stacked overlays only unlock on the last release', () => {
    const first = lockBodyScroll()
    const second = lockBodyScroll()
    expect(bodyScrollLocks()).toBe(2)

    second()
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')

    first()
    expect(document.body.style.overflow).toBe('')
    expect(bodyScrollLocks()).toBe(0)
  })

  it('FE-UTIL-SCROLLLOCK-003: releasing twice leaves the other overlay lock intact', () => {
    const first = lockBodyScroll()
    const second = lockBodyScroll()

    second()
    second()
    second()

    expect(bodyScrollLocks()).toBe(1)
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.documentElement.style.overflow).toBe('hidden')
    first()
    expect(document.body.style.overflow).toBe('')
  })

  it('FE-UTIL-SCROLLLOCK-004: an unlock never sets a value the caller did not save', () => {
    document.body.style.overflow = 'scroll'
    document.documentElement.style.overflow = 'auto'
    const release = lockBodyScroll()
    const nested = lockBodyScroll()
    nested()
    release()
    expect(document.body.style.overflow).toBe('scroll')
    expect(document.documentElement.style.overflow).toBe('auto')
  })

  it('FE-UTIL-SCROLLLOCK-005: pins the body at the current viewport and restores that scroll position', () => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 240 })
    const scrollTo = vi.mocked(window.scrollTo)

    const release = lockBodyScroll()

    expect(document.body.style.position).toBe('fixed')
    expect(document.body.style.top).toBe('-240px')
    expect(document.body.style.left).toBe('-12px')
    expect(document.body.style.right).toBe('0px')
    expect(document.body.style.width).toBe('100%')

    release()

    expect(document.body.style.position).toBe('')
    expect(document.body.style.top).toBe('')
    expect(document.body.style.left).toBe('')
    expect(document.body.style.right).toBe('')
    expect(document.body.style.width).toBe('')
    expect(scrollTo).toHaveBeenCalledWith(12, 240)
  })

  it('FE-UTIL-SCROLLLOCK-006: restores the saved page origin after a lock at 0,0', () => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })

    const release = lockBodyScroll()
    document.documentElement.scrollLeft = 40
    document.documentElement.scrollTop = 300
    release()

    expect(window.scrollTo).toHaveBeenCalledWith(0, 0)
  })

  it('FE-UTIL-SCROLLLOCK-007: does not issue a redundant origin restore when the root never moved', () => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 })

    const release = lockBodyScroll()
    release()

    expect(window.scrollTo).not.toHaveBeenCalled()
  })
})
