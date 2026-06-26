/**
 * Data screen — range & pagination coverage.
 *
 * These tests pin the FRONTEND half of the "data pages don't show the full
 * selected range" fix (see PAGINATION_FINDINGS.md). They verify that the data
 * screen:
 *   1. consumes the corrected backend contract (raw / aggregated responses);
 *   2. follows `pagination.hasMore` to load the ENTIRE window across multiple
 *      pages ("load all in range"), accumulating every row;
 *   3. surfaces a coverage summary so the user can confirm the full window is
 *      represented;
 *   4. builds custom windows so the full selected range (incl. the final day)
 *      is requested;
 *   5. degrades gracefully on error and never loops forever.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import DataPage from '@/app/data/page'

const mockFetch = global.fetch as jest.Mock

/** Build a SensorData row with all numeric fields the table/chart read. */
function row(i: number, timestampMs: number) {
  return {
    id: `row-${i}`,
    timestamp: new Date(timestampMs).toISOString(),
    tempAvg: 20 + i,
    humAvg: 60 + i,
    pressAvg: 40 + i,
    current1Avg: 1 + i,
    current2Avg: 0.1,
    current1RMS: 2 + i,
    current2RMS: 0.2,
    dutyCycle1: 0.3,
    dutyCycle2: 0,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  }
}

/** Extract the URL string passed to the Nth fetch call (0-based). */
function fetchUrl(call: number): string {
  return mockFetch.mock.calls[call][0] as string
}

describe('DataPage — range & pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders a single-page (un-aggregated) window in full', async () => {
    const now = Date.now()
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(0, now - 60_000), row(1, now)],
        pagination: { total: 2, offset: 0, returned: 2, hasMore: false },
      })
    )

    render(<DataPage />)

    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent('2 data points')
    )
    // Exactly one request — nothing to page through.
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // The default range (24h) sends a bounded window with no aggregation/limit.
    const url = fetchUrl(0)
    expect(url).toContain('startDate=')
    expect(url).toContain('endDate=')
    expect(url).not.toContain('aggregate=')
    expect(url).not.toContain('limit=')
  })

  it('follows hasMore to load the ENTIRE window across multiple pages', async () => {
    const now = Date.now()
    // Page 0: newest 3 rows, server signals more remain.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(0, now), row(1, now - 60_000), row(2, now - 120_000)],
        pagination: { total: 5, offset: 0, returned: 3, hasMore: true },
      })
    )
    // Page 1: remaining 2 rows, no more.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(3, now - 180_000), row(4, now - 240_000)],
        pagination: { total: 5, offset: 3, returned: 2, hasMore: false },
      })
    )

    render(<DataPage />)

    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent('5 data points')
    )

    expect(mockFetch).toHaveBeenCalledTimes(2)
    // Page 1 is fetched as an explicit raw page at the running offset.
    const page1 = fetchUrl(1)
    expect(page1).toContain('limit=5000')
    expect(page1).toContain('offset=3')
    expect(screen.getByTestId('coverage-summary')).toHaveTextContent('2 pages')
  })

  it('renders every accumulated row in the table view', async () => {
    const now = Date.now()
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(0, now), row(1, now - 60_000)],
        pagination: { total: 4, offset: 0, returned: 2, hasMore: true },
      })
    )
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(2, now - 120_000), row(3, now - 180_000)],
        pagination: { total: 4, offset: 2, returned: 2, hasMore: false },
      })
    )

    render(<DataPage />)

    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent('4 data points')
    )

    // Switch to the table view and count rendered data rows.
    fireEvent.click(screen.getByRole('button', { name: /table/i }))
    const table = await screen.findByRole('table')
    const bodyRows = within(table).getAllByRole('row')
    // 1 header row + 4 data rows.
    expect(bodyRows).toHaveLength(5)
  })

  it('shows the aggregation label when the server downsamples a long range', async () => {
    // Mount (24h) — keep it trivial so we can drive the 7d switch next.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [], pagination: { total: 0, offset: 0, returned: 0, hasMore: false } })
    )
    // 7d switch — server returns an hourly-aggregated series.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(0, Date.now())],
        aggregation: {
          interval: 'hour',
          auto: true,
          startDate: new Date().toISOString(),
          endDate: new Date().toISOString(),
        },
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    render(<DataPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } })

    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent('hourly average')
    )
    // The 7d range requests hourly aggregation up front.
    expect(fetchUrl(1)).toContain('aggregate=hour')
  })

  it('requests the full custom window including the selected end day', async () => {
    // Mount fetch (24h).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [], pagination: { total: 0, offset: 0, returned: 0, hasMore: false } })
    )
    // Custom-range fetch.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [row(0, Date.parse('2026-06-10T12:00:00'))],
        aggregation: {
          interval: '6hour',
          auto: false,
          startDate: '2026-06-01T00:00:00.000Z',
          endDate: '2026-06-25T23:59:59.999Z',
        },
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    render(<DataPage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: '2026-06-01' },
    })
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: '2026-06-25' },
    })
    fireEvent.click(screen.getByRole('button', { name: /load data/i }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))

    const url = new URL(fetchUrl(1), 'http://localhost')
    const start = new Date(url.searchParams.get('startDate') as string)
    const end = new Date(url.searchParams.get('endDate') as string)
    // Start is local midnight of the first day; end is local end-of-day of the
    // LAST selected day (not clipped to the prior day in non-UTC zones).
    expect(start.getTime()).toBe(new Date('2026-06-01T00:00:00').getTime())
    expect(end.getTime()).toBe(new Date('2026-06-25T23:59:59.999').getTime())
    // A >7 day span aggregates by 6 hours.
    expect(url.searchParams.get('aggregate')).toBe('6hour')
  })

  it('shows an error banner when the request fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'))

    render(<DataPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.getByRole('alert')).toHaveTextContent(/failed to load/i)
  })

  it('treats a non-ok response as an error rather than rendering stale data', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false, 500))

    render(<DataPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('never loops forever when the server keeps signalling hasMore with no rows', async () => {
    // Defensive: hasMore=true but returned=0 must stop the load loop.
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [],
        pagination: { total: 9999, offset: 0, returned: 0, hasMore: true },
      })
    )

    render(<DataPage />)

    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent(
        /no data in the selected range/i
      )
    )
    // Exactly one request — the zero-progress response halts paging immediately.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('re-fetches the active window on manual refresh', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [row(0, Date.now())],
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    render(<DataPage />)
    await waitFor(() =>
      expect(screen.getByTestId('coverage-summary')).toHaveTextContent('1 data point')
    )

    fireEvent.click(screen.getByRole('button', { name: /refresh data/i }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
  })

  it('surfaces a "last updated" indicator once a load succeeds', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [row(0, Date.now())],
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    render(<DataPage />)

    const indicator = await screen.findByTestId('last-updated')
    await waitFor(() => expect(indicator).toHaveTextContent(/updated/i))
  })
})

/**
 * Live (auto) + manual refresh wiring.
 *
 * These pin the behaviour added by wiring the shared `useAutoRefresh` hook into
 * the data screen: a 1-minute poll, and — most importantly — that every refresh
 * (auto OR manual) re-queries the user's CURRENTLY selected range rather than
 * snapping back to a default. Uses fake timers so the interval can be driven
 * deterministically.
 */
describe('DataPage — live auto-refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const onePage = () =>
    jsonResponse({
      data: [row(0, Date.now())],
      pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
    })

  it('auto-refreshes on the 1-minute interval', async () => {
    mockFetch.mockResolvedValue(onePage())

    await act(async () => {
      render(<DataPage />)
    })
    // Mount fetch.
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // One minute later → one more refresh.
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)

    // And again on the next tick.
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('keeps the selected range intact across auto-refreshes (7d stays 7d)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [row(0, Date.now())],
        aggregation: {
          interval: 'hour',
          auto: true,
          startDate: new Date().toISOString(),
          endDate: new Date().toISOString(),
        },
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    await act(async () => {
      render(<DataPage />)
    })
    // Mount = 24h (no aggregation).
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(fetchUrl(0)).not.toContain('aggregate=')

    // Switch to 7d → an immediate re-query at the new range.
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '7d' } })
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(fetchUrl(1)).toContain('aggregate=hour')

    // The auto-refresh tick must re-query 7d — NOT snap back to the 24h default.
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(fetchUrl(2)).toContain('aggregate=hour')
  })

  it('does not poll a custom range until it is loaded, then refreshes the same window', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: [row(0, Date.parse('2026-06-10T12:00:00'))],
        aggregation: {
          interval: '6hour',
          auto: false,
          startDate: '2026-06-01T00:00:00.000Z',
          endDate: '2026-06-25T23:59:59.999Z',
        },
        pagination: { total: 1, offset: 0, returned: 1, hasMore: false },
      })
    )

    await act(async () => {
      render(<DataPage />)
    })
    expect(mockFetch).toHaveBeenCalledTimes(1) // mount (24h)

    // Switch to custom and enter both dates — nothing should fetch yet.
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/start date/i), {
        target: { value: '2026-06-01' },
      })
      fireEvent.change(screen.getByLabelText(/end date/i), {
        target: { value: '2026-06-25' },
      })
    })
    // A poll interval elapses while the window is only half-committed (no Load).
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockFetch).toHaveBeenCalledTimes(1) // still only the mount fetch

    // Explicitly load the custom window.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /load data/i }))
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const loadedUrl = fetchUrl(1)
    expect(loadedUrl).toContain('aggregate=6hour')

    // Now auto-refresh keeps that exact custom window (identical URL).
    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(mockFetch).toHaveBeenCalledTimes(3)
    expect(fetchUrl(2)).toBe(loadedUrl)
  })
})
