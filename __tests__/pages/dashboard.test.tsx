import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Dashboard from '@/app/page'

// Mock fetch
const mockFetch = jest.fn()
global.fetch = mockFetch

const sensorRow = {
  id: '1',
  device: 'well-pump-monitor',
  location: 'Pump House',
  timestamp: '2023-01-01T12:30:45.000Z',
  tempAvg: 20.5,
  current1RMS: 2.3,
  current2RMS: 0.1,
  pressAvg: 40.2,
  humAvg: 65.0,
}

const zeroStats = {
  pumpRunCount: 0,
  pumpDurationSeconds: 0,
  pumpDurationMs: 0,
  lowPressureEventCount: 0,
  lowPressureDurationSeconds: 0,
  lowPressureDurationMs: 0,
  sampleCount: 0,
  averagePumpRunSeconds: 0,
  averageLowPressureSeconds: 0,
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) }
}

// The dashboard now fires three independent endpoints (sensors, events, stats),
// some from a separate auto-refreshing component, so ordering is not guaranteed.
// Route by URL instead of relying on call order.
let sensorsBody: unknown
let eventsBody: unknown
let statsBody: unknown
let failAll = false

function routeFetch(input: RequestInfo | URL) {
  if (failAll) return Promise.reject(new Error('API Error'))
  const url = String(input)
  if (url.includes('/api/sensors')) return Promise.resolve(jsonResponse(sensorsBody))
  if (url.includes('/api/events')) return Promise.resolve(jsonResponse(eventsBody))
  if (url.includes('/api/stats')) return Promise.resolve(jsonResponse(statsBody))
  return Promise.resolve(jsonResponse({ data: [] }))
}

/** Count fetch calls whose URL contains `substr`. */
function callsTo(substr: string): number {
  return mockFetch.mock.calls.filter((c) => String(c[0]).includes(substr)).length
}

describe('Dashboard Page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    sensorsBody = { data: [] }
    eventsBody = { data: [] }
    statsBody = { stats: zeroStats }
    failAll = false
    mockFetch.mockImplementation((url: RequestInfo | URL) => routeFetch(url))
  })

  it('renders dashboard with loading state initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})) // Never resolves

    render(<Dashboard />)

    expect(
      screen.getByRole('heading', { name: 'Dashboard' })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Real-time well pump monitoring and status')
    ).toBeInTheDocument()
    // Loading spinner for current readings
    expect(screen.getByRole('status')).toBeInTheDocument()
    // The dashboard header last-updated indicator reflects the in-flight load.
    // (The stats panel renders a second indicator, hence getAllByTestId.)
    expect(screen.getAllByTestId('last-updated')[0]).toHaveTextContent('Loading…')
  })

  it('displays latest sensor data when available', async () => {
    sensorsBody = { data: [sensorRow] }

    render(<Dashboard />)

    await waitFor(() => {
      // Default temperature unit is Fahrenheit; sensor stores Fahrenheit so
      // 20.5 is a pass-through (the value is unrealistic but the test only
      // cares about the rendering path).
      expect(screen.getByText('20.5°F')).toBeInTheDocument()
    })
    expect(screen.getByText('40.20 psi')).toBeInTheDocument()
    expect(screen.getByText('2.30 A')).toBeInTheDocument()
    expect(screen.getByText('0.10 A')).toBeInTheDocument()
    expect(screen.getByText('well-pump-monitor')).toBeInTheDocument()
    expect(screen.getByText('No active alerts')).toBeInTheDocument()
  })

  it('displays active events when present and sets warning status', async () => {
    sensorsBody = { data: [sensorRow] }
    eventsBody = {
      data: [
        {
          id: 'event-1',
          type: 'HIGH_CURRENT',
          description: 'High current detected on pump 1',
          active: true,
          timestamp: '2023-01-01T12:00:00.000Z',
        },
      ],
    }

    render(<Dashboard />)

    await waitFor(() => {
      expect(
        screen.getByText('High current detected on pump 1')
      ).toBeInTheDocument()
    })
    expect(screen.getByText('warning')).toBeInTheDocument()
  })

  it('shows error state and banner when API calls fail', async () => {
    failAll = true

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('error')).toBeInTheDocument()
    })
    // The dashboard banner is one of potentially several alerts (the stats panel
    // surfaces its own) — assert the dashboard-specific copy is present.
    const alerts = screen.getAllByRole('alert')
    expect(
      alerts.some((el) => /failed to update dashboard data/i.test(el.textContent ?? ''))
    ).toBe(true)
  })

  it('shows no data available when no sensor data exists', async () => {
    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('No data available')).toBeInTheDocument()
    })
    // "Last Reading" card shows N/A when there is no reading.
    expect(screen.getByText('Last Reading')).toBeInTheDocument()
  })

  it('renders the aggregated operational stats panel', async () => {
    statsBody = {
      stats: {
        ...zeroStats,
        pumpRunCount: 12,
        pumpDurationSeconds: 3661, // 1h 1m
        averagePumpRunSeconds: 305, // 5m 5s
        lowPressureEventCount: 2,
        lowPressureDurationSeconds: 600, // 10m
        averageLowPressureSeconds: 300, // 5m
        sampleCount: 1440,
      },
    }

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Operational Stats')).toBeInTheDocument()
    })

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

  it('auto-refreshes sensor data every 60 seconds', async () => {
    jest.useFakeTimers()
    try {
      render(<Dashboard />)

      // Initial pass: exactly one sensors call.
      await waitFor(() => {
        expect(callsTo('/api/sensors')).toBe(1)
      })

      // Nothing at 30s (old interval) — proves the cadence is 60s.
      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      expect(callsTo('/api/sensors')).toBe(1)

      // Tick to 60s -> a second sensors refresh fires.
      await act(async () => {
        jest.advanceTimersByTime(30_000)
      })
      await waitFor(() => {
        expect(callsTo('/api/sensors')).toBe(2)
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('manually refreshes when the refresh button is clicked', async () => {
    const user = userEvent.setup()

    render(<Dashboard />)

    await waitFor(() => {
      expect(callsTo('/api/sensors')).toBe(1)
    })

    await user.click(screen.getByRole('button', { name: /refresh dashboard/i }))

    await waitFor(() => {
      expect(callsTo('/api/sensors')).toBe(2)
    })
  })

  it('refreshes the stats panel when its range is changed', async () => {
    const user = userEvent.setup()

    render(<Dashboard />)

    await waitFor(() => {
      expect(callsTo('/api/stats')).toBe(1)
    })

    await user.selectOptions(
      screen.getByLabelText('Stats time range'),
      '7d'
    )

    await waitFor(() => {
      expect(callsTo('/api/stats')).toBe(2)
    })
  })

  it('shows a last-updated indicator after a successful refresh', async () => {
    sensorsBody = { data: [sensorRow] }

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getAllByTestId('last-updated')[0]).toHaveTextContent(/Updated/)
    })
  })

  it('cleans up the polling interval on unmount', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

    const { unmount } = render(<Dashboard />)

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    unmount()
    expect(clearIntervalSpy).toHaveBeenCalled()
    clearIntervalSpy.mockRestore()
  })
})
