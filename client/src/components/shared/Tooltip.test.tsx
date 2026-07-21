import { fireEvent, render, screen, waitFor } from '../../../tests/helpers/render'
import Tooltip from './Tooltip'

const triggerRect = {
  x: 100,
  y: 100,
  top: 100,
  left: 100,
  right: 140,
  bottom: 120,
  width: 40,
  height: 20,
  toJSON: () => ({}),
} as DOMRect

describe('Tooltip positioning', () => {
  it.each([
    { placement: 'top', top: 84, left: 110 },
    { placement: 'bottom', top: 126, left: 110 },
    { placement: 'left', top: 105, left: 74 },
    { placement: 'right', top: 105, left: 146 },
  ] as const)('positions a $placement tooltip from the measured trigger', async ({ placement, top, left }) => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(20)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(10)

    try {
      render(
        <Tooltip label="Details" placement={placement} delay={0}>
          <button type="button">Trigger</button>
        </Tooltip>,
      )
      const trigger = screen.getByRole('button', { name: 'Trigger' })
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(triggerRect)

      fireEvent.mouseEnter(trigger)

      const tooltip = await screen.findByRole('tooltip')
      await waitFor(() => {
        expect(tooltip.style.visibility).toBe('visible')
        expect(tooltip.style.top).toBe(`${top}px`)
        expect(tooltip.style.left).toBe(`${left}px`)
      })
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
  })
})
