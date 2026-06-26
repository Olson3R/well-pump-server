import { render, screen, act } from '@testing-library/react'
import { LastUpdated, formatRelativeTime } from '@/components/LastUpdated'

describe('formatRelativeTime', () => {
  it('returns "just now" for very recent updates', () => {
    expect(formatRelativeTime(0)).toBe('just now')
    expect(formatRelativeTime(4_999)).toBe('just now')
  })

  it('formats seconds, minutes, hours and days', () => {
    expect(formatRelativeTime(12_000)).toBe('12s ago')
    expect(formatRelativeTime(90_000)).toBe('1m ago')
    expect(formatRelativeTime(3 * 60 * 60 * 1000)).toBe('3h ago')
    expect(formatRelativeTime(2 * 24 * 60 * 60 * 1000)).toBe('2d ago')
  })

  it('clamps negative durations to "just now"', () => {
    expect(formatRelativeTime(-5_000)).toBe('just now')
  })
})

describe('LastUpdated', () => {
  it('shows "Loading…" on the very first load', () => {
    render(<LastUpdated date={null} loading />)
    expect(screen.getByTestId('last-updated')).toHaveTextContent('Loading…')
  })

  it('shows "Not yet updated" when idle with no date', () => {
    render(<LastUpdated date={null} loading={false} />)
    expect(screen.getByTestId('last-updated')).toHaveTextContent(
      'Not yet updated'
    )
  })

  it('shows "Updating…" when refreshing with an existing date', () => {
    render(<LastUpdated date={new Date()} loading />)
    expect(screen.getByTestId('last-updated')).toHaveTextContent('Updating…')
  })

  it('renders a relative label and an absolute title for a date', () => {
    const date = new Date(Date.now() - 12_000)
    render(<LastUpdated date={date} />)
    const el = screen.getByTestId('last-updated')
    expect(el).toHaveTextContent(/Updated 1[12]s ago/)
    expect(el).toHaveAttribute('title', date.toLocaleString())
  })

  it('indicates the paused state', () => {
    render(<LastUpdated date={new Date()} isPaused />)
    expect(screen.getByTestId('last-updated')).toHaveTextContent('(paused)')
  })

  it('ticks the relative label as time passes', async () => {
    jest.useFakeTimers()
    try {
      const date = new Date(Date.now())
      render(<LastUpdated date={date} />)
      expect(screen.getByTestId('last-updated')).toHaveTextContent('just now')

      await act(async () => {
        jest.advanceTimersByTime(10_000)
      })
      expect(screen.getByTestId('last-updated')).toHaveTextContent(/10s ago/)
    } finally {
      jest.useRealTimers()
    }
  })
})
