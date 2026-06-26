import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StatsSummary, resolveStatsRange } from '@/components/StatsSummary'

const mockFetch = jest.fn()
global.fetch = mockFetch

const stats = {
  pumpRunCount: 12,
  pumpDurationSeconds: 3661, // 1h 1m
  pumpDurationMs: 3_661_000,
  lowPressureEventCount: 2,
  lowPressureDurationSeconds: 600, // 10m
  lowPressureDurationMs: 600_000,
  sampleCount: 1440,
  averagePumpRunSeconds: 305, // 5m 5s
  averageLowPressureSeconds: 300, // 5m
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) }
}

/** Last fetched URL (string). */
function lastUrl(): string {
  const calls = mockFetch.mock.calls
  return String(calls[calls.length - 1][0])
}

describe('resolveStatsRange', () => {
  it('returns null bounds for the all-time range', () => {
    expect(resolveStatsRange('all')).toEqual({ start: null, end: null })
  })

  it('returns a 24h window ending now', () => {
    const { start, end } = resolveStatsRange('24h')
    expect(start).toBeInstanceOf(Date)
    expect(end).toBeInstanceOf(Date)
    const spanHours = (end!.getTime() - start!.getTime()) / (1000 * 60 * 60)
    expect(spanHours).toBeCloseTo(24, 1)
  })

  it('returns a 7d and 30d window of the right span', () => {
    const day = 1000 * 60 * 60 * 24
    const w7 = resolveStatsRange('7d')
    expect((w7.end!.getTime() - w7.start!.getTime()) / day).toBeCloseTo(7, 1)
    const w30 = resolveStatsRange('30d')
    expect((w30.end!.getTime() - w30.start!.getTime()) / day).toBeCloseTo(30, 1)
  })
})

describe('StatsSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockResolvedValue(jsonResponse({ stats }))
  })

  it('fetches and renders the four headline stats with formatting', async () => {
    render(<StatsSummary />)

    await waitFor(() => {
      expect(screen.getByTestId('stat-pump-runs-value')).toHaveTextContent('12')
    })
    expect(screen.getByTestId('stat-pump-runtime-value')).toHaveTextContent('1h 1m')
    expect(
      screen.getByTestId('stat-low-pressure-events-value')
    ).toHaveTextContent('2')
    expect(
      screen.getByTestId('stat-low-pressure-time-value')
    ).toHaveTextContent('10m')
  })

  it('renders derived averages as detail lines', async () => {
    render(<StatsSummary />)

    await waitFor(() => {
      expect(screen.getByTestId('stat-pump-runs-detail')).toHaveTextContent(
        'avg 5m 5s / run'
      )
    })
    expect(
      screen.getByTestId('stat-low-pressure-events-detail')
    ).toHaveTextContent('avg 5m / event')
  })

  it('defaults to a 24-hour range on first load', async () => {
    render(<StatsSummary />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    const url = new URL(lastUrl(), 'http://localhost')
    expect(url.searchParams.has('startDate')).toBe(true)
    expect(url.searchParams.has('endDate')).toBe(true)
  })

  it('passes a device filter when provided', async () => {
    render(<StatsSummary device="well-pump-monitor" />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    const url = new URL(lastUrl(), 'http://localhost')
    expect(url.searchParams.get('device')).toBe('well-pump-monitor')
  })

  it('re-queries when the range is changed and drops date bounds for all-time', async () => {
    const user = userEvent.setup()
    render(<StatsSummary />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    await user.selectOptions(screen.getByLabelText('Stats time range'), 'all')

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
    const url = new URL(lastUrl(), 'http://localhost')
    expect(url.searchParams.has('startDate')).toBe(false)
    expect(url.searchParams.has('endDate')).toBe(false)
  })

  it('manually refreshes when the refresh button is clicked', async () => {
    const user = userEvent.setup()
    render(<StatsSummary />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    await user.click(screen.getByRole('button', { name: /refresh stats/i }))

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  it('auto-refreshes every 60 seconds', async () => {
    jest.useFakeTimers()
    try {
      render(<StatsSummary />)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      expect(mockFetch).toHaveBeenCalledTimes(1)

      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2)
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('shows an error banner when the request fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500))

    render(<StatsSummary />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/failed to load stats/i)
    })
  })

  it('shows zeroed values when there is no data in range', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        stats: {
          pumpRunCount: 0,
          pumpDurationSeconds: 0,
          pumpDurationMs: 0,
          lowPressureEventCount: 0,
          lowPressureDurationSeconds: 0,
          lowPressureDurationMs: 0,
          sampleCount: 0,
          averagePumpRunSeconds: 0,
          averageLowPressureSeconds: 0,
        },
      })
    )

    render(<StatsSummary />)

    await waitFor(() => {
      expect(screen.getByTestId('stat-pump-runs-value')).toHaveTextContent('0')
    })
    expect(screen.getByTestId('stat-pump-runtime-value')).toHaveTextContent('0s')
    // No runs -> no average detail line.
    expect(screen.queryByTestId('stat-pump-runs-detail')).not.toBeInTheDocument()
  })
})
