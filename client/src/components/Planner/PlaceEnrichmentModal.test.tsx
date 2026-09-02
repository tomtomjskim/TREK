import React from 'react'
import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render'
import userEvent from '@testing-library/user-event'
import Modal from '../shared/Modal'
import { PlaceEnrichmentModal } from './PlaceEnrichmentModal'
import { placesApi } from '../../api/client'
import { resetBodyScrollLock } from '../../utils/bodyScrollLock'

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client')
  return { ...actual, placesApi: { ...actual.placesApi, previewEnrichment: vi.fn(), applyEnrichment: vi.fn() } }
})

const places = [{ id: 1, name: 'Cafe', lat: 35, lng: 138, google_place_id: null }] as any

describe('PlaceEnrichmentModal infrastructure', () => {
  beforeEach(() => {
    resetBodyScrollLock()
    document.body.style.overflow = ''
  })

  it('locks body scrolling while open and restores it after close', async () => {
    const user = userEvent.setup()
    function Fixture() {
      const [open, setOpen] = React.useState(true)
      return <PlaceEnrichmentModal isOpen={open} onClose={() => setOpen(false)} tripId={1} places={places} />
    }
    render(<Fixture />)
    expect(document.body.style.overflow).toBe('hidden')
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(document.body.style.overflow).toBe('')
  })

  it('does not let a lower-z common modal consume Escape', () => {
    const enrichmentClose = vi.fn()
    const commonClose = vi.fn()
    render(
      <>
        <Modal isOpen onClose={commonClose} title="Common" />
        <PlaceEnrichmentModal isOpen onClose={enrichmentClose} tripId={1} places={places} />
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(enrichmentClose).toHaveBeenCalledOnce()
    expect(commonClose).not.toHaveBeenCalled()
  })

  it('lets a higher-z common modal consume Escape instead', () => {
    const enrichmentClose = vi.fn()
    const commonClose = vi.fn()
    render(
      <>
        <Modal isOpen onClose={commonClose} title="Common" zIndex={200000} />
        <PlaceEnrichmentModal isOpen onClose={enrichmentClose} tripId={1} places={places} />
      </>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(commonClose).toHaveBeenCalledOnce()
    expect(enrichmentClose).not.toHaveBeenCalled()
  })

  it('keeps the shared body lock until the last modal closes', async () => {
    const user = userEvent.setup()
    const commonClose = vi.fn()
    function Fixture() {
      const [enrichmentOpen, setEnrichmentOpen] = React.useState(true)
      return (
        <>
          <Modal isOpen onClose={commonClose} title="Common" />
          <PlaceEnrichmentModal isOpen={enrichmentOpen} onClose={() => setEnrichmentOpen(false)} tripId={1} places={places} />
        </>
      )
    }
    render(<Fixture />)
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('focuses the first action and ignores Escape while scanning', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    vi.mocked(placesApi.previewEnrichment).mockReturnValueOnce(new Promise(() => undefined))
    render(<PlaceEnrichmentModal isOpen onClose={onClose} tripId={1} places={places} />)
    const scan = screen.getByRole('button', { name: /scan 1 place/i })
    await waitFor(() => expect(scan).toHaveFocus())
    await user.click(scan)
    expect(await screen.findByText(/scanning/i)).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
