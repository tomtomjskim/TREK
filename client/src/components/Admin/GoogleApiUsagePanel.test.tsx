import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '../../../tests/helpers/render'
import { server } from '../../../tests/helpers/msw/server'
import { resetAllStores } from '../../../tests/helpers/store'
import GoogleApiUsagePanel from './GoogleApiUsagePanel'

const usage = [
  {
    period: '2026-07',
    timezone: 'America/Los_Angeles',
    sku: 'autocomplete',
    used: 120,
    cap: 8000,
    remaining: 7880,
    official_free_cap: 10000,
    exhausted: false,
  },
  {
    period: '2026-07',
    timezone: 'America/Los_Angeles',
    sku: 'place_photos',
    used: 800,
    cap: 800,
    remaining: 0,
    official_free_cap: 1000,
    exhausted: true,
  },
]

describe('GoogleApiUsagePanel', () => {
  beforeEach(() => {
    resetAllStores()
    server.use(
      http.get('/api/admin/google-api-usage', () => HttpResponse.json({ usage })),
    )
  })

  it('FE-ADMIN-GOOGLE-USAGE-001: renders TREK-local usage, period, caps, and exhausted state', async () => {
    render(<GoogleApiUsagePanel />)

    expect(screen.getByRole('status', { name: /loading Google Places usage/i })).toBeInTheDocument()
    expect(await screen.findByText('Google Places usage')).toBeInTheDocument()
    expect(screen.getByText(/TREK requests only/i)).toBeInTheDocument()
    expect(screen.getByText(/Google Cloud billing total/i)).toBeInTheDocument()
    expect(screen.getByText(/2026-07/)).toBeInTheDocument()
    expect(screen.getByText('Autocomplete')).toBeInTheDocument()
    expect(screen.getByText('Place Photos')).toBeInTheDocument()
    expect(screen.getByText('120 / 8,000')).toBeInTheDocument()
    expect(screen.getByText('800 / 800')).toBeInTheDocument()
    expect(screen.getByText('Limit reached')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: /Autocomplete/i })).toHaveAttribute('aria-valuenow', '120')
  })

  it('FE-ADMIN-GOOGLE-USAGE-002: refreshes the local ledger on demand', async () => {
    let requests = 0
    server.use(
      http.get('/api/admin/google-api-usage', () => {
        requests += 1
        return HttpResponse.json({
          usage: [{ ...usage[0], used: requests === 1 ? 120 : 121, remaining: requests === 1 ? 7880 : 7879 }],
        })
      }),
    )
    const user = userEvent.setup()
    render(<GoogleApiUsagePanel />)

    expect(await screen.findByText('120 / 8,000')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Refresh usage/i }))

    expect(await screen.findByText('121 / 8,000')).toBeInTheDocument()
    expect(requests).toBe(2)
  })

  it('FE-ADMIN-GOOGLE-USAGE-003: shows a retry action after a load failure', async () => {
    let requests = 0
    server.use(
      http.get('/api/admin/google-api-usage', () => {
        requests += 1
        return requests === 1
          ? HttpResponse.json({ error: 'unavailable' }, { status: 503 })
          : HttpResponse.json({ usage: [usage[0]] })
      }),
    )
    const user = userEvent.setup()
    render(<GoogleApiUsagePanel />)

    expect(await screen.findByText('Could not load Google Places usage.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/i }))

    await waitFor(() => expect(screen.getByText('120 / 8,000')).toBeInTheDocument())
    expect(requests).toBe(2)
  })
})
