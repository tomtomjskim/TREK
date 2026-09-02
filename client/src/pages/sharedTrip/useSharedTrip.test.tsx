import { act, renderHook, waitFor } from '@testing-library/react'
import { shareApi } from '../../api/client'
import { useSharedTrip } from './useSharedTrip'

let routeParams: { token?: string } = { token: 'token-a' }

vi.mock('react-router', () => ({ useParams: () => routeParams }))
vi.mock('../../hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({ convert: vi.fn((amount: number) => amount) }),
}))

beforeEach(() => {
  routeParams = { token: 'token-a' }
  vi.restoreAllMocks()
})

describe('useSharedTrip', () => {
  it('FE-PAGE-SHARED-HOOK-001: ignores a stale token response and clears token-scoped view state', async () => {
    let resolveA: ((value: unknown) => void) | undefined
    let resolveB: ((value: unknown) => void) | undefined
    vi.spyOn(shareApi, 'getSharedTrip').mockImplementation(token => new Promise(resolve => {
      if (token === 'token-a') resolveA = resolve
      else resolveB = resolve
    }) as never)

    const { result, rerender } = renderHook(() => useSharedTrip())
    await waitFor(() => expect(shareApi.getSharedTrip).toHaveBeenCalledWith('token-a'))
    act(() => {
      result.current.setSelectedDay(42)
      result.current.setActiveTab('budget')
    })

    routeParams = { token: 'token-b' }
    rerender()
    await waitFor(() => expect(shareApi.getSharedTrip).toHaveBeenCalledWith('token-b'))
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBe(false)
    expect(result.current.selectedDay).toBeNull()
    expect(result.current.activeTab).toBe('plan')

    await act(async () => { resolveA?.({ trip: { title: 'stale-a' } }) })
    expect(result.current.data).toBeNull()

    await act(async () => { resolveB?.({ trip: { title: 'current-b' } }) })
    expect(result.current.data).toEqual({ trip: { title: 'current-b' } })
  })

  it('FE-PAGE-SHARED-HOOK-002: ignores an obsolete request failure', async () => {
    let rejectA: ((reason?: unknown) => void) | undefined
    vi.spyOn(shareApi, 'getSharedTrip')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectA = reject }) as never)
      .mockResolvedValueOnce({ trip: { title: 'current-b' } } as never)

    const { result, rerender } = renderHook(() => useSharedTrip())
    await waitFor(() => expect(shareApi.getSharedTrip).toHaveBeenCalledWith('token-a'))
    routeParams = { token: 'token-b' }
    rerender()
    await waitFor(() => expect(result.current.data).toEqual({ trip: { title: 'current-b' } }))

    await act(async () => { rejectA?.(new Error('stale failure')) })
    expect(result.current.error).toBe(false)
    expect(result.current.data).toEqual({ trip: { title: 'current-b' } })
  })
})
