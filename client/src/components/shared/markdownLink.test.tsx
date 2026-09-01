import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownLinkComponents } from './markdownLink'

describe('markdownLinkComponents', () => {
  it('FE-MDLINK-001: a link in a note opens in its own tab instead of navigating the planner away', () => {
    render(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
        {'[opening hours](https://example.com/hours)'}
      </Markdown>
    )
    const link = screen.getByRole('link', { name: 'opening hours' })
    expect(link).toHaveAttribute('href', 'https://example.com/hours')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('FE-MDLINK-002: the opened page gets no handle on the app', () => {
    render(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
        {'[booking](https://example.com)'}
      </Markdown>
    )
    // Without noopener the target can navigate this window through window.opener,
    // and a note is content other trip members wrote.
    const link = screen.getByRole('link', { name: 'booking' })
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(link.getAttribute('rel')).toContain('nofollow')
  })

  it('FE-MDLINK-003: a bare URL typed into a note becomes a link too', () => {
    render(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
        {'tickets: https://example.com/tickets'}
      </Markdown>
    )
    expect(screen.getByRole('link', { name: 'https://example.com/tickets' })).toHaveAttribute('target', '_blank')
  })

  it('FE-MDLINK-004: unsafe URI schemes never become navigable links', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,boom', 'file:///etc/passwd']) {
      const { unmount } = render(
        <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
          {`[unsafe](${href})`}
        </Markdown>
      )
      expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull()
      unmount()
    }
  })

  it('FE-MDLINK-005: raw HTML in a note is inert without a raw-html plugin', () => {
    render(
      <Markdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
        {'before <script>window.__markdownUnsafe = true</script> after'}
      </Markdown>
    )
    expect(document.querySelector('script')).toBeNull()
    expect((window as typeof window & { __markdownUnsafe?: boolean }).__markdownUnsafe).toBeUndefined()
  })
})
