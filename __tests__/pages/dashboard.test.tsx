import { render, screen, waitFor } from '@testing-library/react'
import Dashboard from '@/app/page'

// Mock fetch
const mockFetch = jest.fn()
global.fetch = mockFetch

describe('Dashboard Page', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders dashboard with loading state initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})) // Never resolves

    render(<Dashboard />)

    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Real-time well pump monitoring and status')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument() // Loading spinner
  })

  it('displays latest sensor data when available', async () => {
    const mockSensorData = {
      data: [
        {
          id: '1',
          device: 'well-pump-monitor',
          location: 'Pump House',
          timestamp: '2023-01-01T12:00:00.000Z',
          tempAvg: 20.5,
          current1Avg: 2.3,
          current2Avg: 0.1,
          pressAvg: 40.2,
          humAvg: 65.0,
        },
      ],
    }

    const mockEventsData = {
      data: [],
    }

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSensorData),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEventsData),
      })

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('20.5°C')).toBeInTheDocument()
      expect(screen.getByText('40.20 psi')).toBeInTheDocument()
      expect(screen.getByText('2.30 A')).toBeInTheDocument()
      expect(screen.getByText('0.10 A')).toBeInTheDocument()
    })

    expect(screen.getByText('well-pump-monitor')).toBeInTheDocument()
    expect(screen.getByText('No active alerts')).toBeInTheDocument()
  })

  it('displays active events when present', async () => {
    const mockSensorData = {
      data: [
        {
          id: '1',
          timestamp: '2023-01-01T12:00:00.000Z',
          tempAvg: 20.5,
          current1Avg: 8.5, // High current
          current2Avg: 0.1,
          pressAvg: 40.2,
          humAvg: 65.0,
        },
      ],
    }

    const mockEventsData = {
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

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSensorData),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEventsData),
      })

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('High current detected on pump 1')).toBeInTheDocument()
      expect(screen.getByText('1')).toBeInTheDocument() // Active alerts count
    })

    // Check that system status shows warning
    expect(screen.getByText('warning')).toBeInTheDocument()
  })

  it('shows error state when API calls fail', async () => {
    mockFetch.mockRejectedValue(new Error('API Error'))

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('error')).toBeInTheDocument()
    })
  })

  it('shows no data available when no sensor data exists', async () => {
    const mockSensorData = { data: [] }
    const mockEventsData = { data: [] }

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSensorData),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEventsData),
      })

    render(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('No data available')).toBeInTheDocument()
      expect(screen.getByText('N/A')).toBeInTheDocument() // Last update time
    })
  })

  it('auto-refreshes data every 30 seconds', async () => {
    const mockSensorData = { data: [] }
    const mockEventsData = { data: [] }

    mockFetch
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockSensorData),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockEventsData),
      })

    render(<Dashboard />)

    // Initial calls
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    // Fast-forward 30 seconds
    jest.advanceTimersByTime(30000)

    // Should make additional calls
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(4)
    })
  })

  it('formats timestamp correctly', async () => {
    const mockSensorData = {
      data: [
        {
          id: '1',
          timestamp: '2023-01-01T12:30:45.000Z',
          tempAvg: 20.5,
          current1Avg: 2.3,
          current2Avg: 0.1,
          pressAvg: 40.2,
          humAvg: 65.0,
        },
      ],
    }

    const mockEventsData = { data: [] }

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockSensorData),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockEventsData),
      })

    render(<Dashboard />)

    await waitFor(() => {
      // Should display formatted time (actual format depends on locale)
      expect(screen.getByText(/12:30|30:45/)).toBeInTheDocument()
    })
  })

  it('cleans up interval on unmount', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval')
    
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    })

    const { unmount } = render(<Dashboard />)
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    unmount()

    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})