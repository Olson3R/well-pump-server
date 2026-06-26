import { act, renderHook } from '@testing-library/react'
import { useAutoRefresh, type UseAutoRefreshOptions } from '@/hooks/useAutoRefresh'

/**
 * Render the hook inside an async `act` so the immediate-refresh microtask
 * (a resolved/rejected callback settling `loading`) flushes within act and
 * never triggers a "not wrapped in act(...)" warning.
 */
async function setup(
  cb: (signal: AbortSignal) => void | Promise<void>,
  opts?: UseAutoRefreshOptions
) {
  let hook!: ReturnType<typeof renderHook<ReturnType<typeof useAutoRefresh>, unknown>>
  await act(async () => {
    hook = renderHook(() => useAutoRefresh(cb, opts))
  })
  return hook
}

/** Set document.hidden and fire the visibilitychange event the hook listens for. */
function setVisibility(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A promise whose resolve/reject are exposed so a test can control timing. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useAutoRefresh', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setVisibility(false)
  })

  afterEach(() => {
    // Discard (don't execute) any scheduled interval so switching back to real
    // timers can't fire a refresh outside act(). RTL auto-unmounts between tests.
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('runs an immediate refresh on mount and records lastUpdated', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    const { result } = await setup(cb)

    expect(cb).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.lastUpdated).toBeInstanceOf(Date)
    expect(result.current.error).toBeNull()
  })

  it('does not refresh on mount when immediate is false', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    await setup(cb, { immediate: false })

    expect(cb).not.toHaveBeenCalled()
  })

  it('reports loading=true while a refresh is in flight', async () => {
    const d = deferred()
    const cb = jest.fn().mockReturnValue(d.promise)
    const { result } = await setup(cb)

    expect(result.current.loading).toBe(true)

    await act(async () => {
      d.resolve()
    })
    expect(result.current.loading).toBe(false)
  })

  it('polls on the configured interval (default 60s)', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    await setup(cb)
    expect(cb).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(cb).toHaveBeenCalledTimes(2)

    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(cb).toHaveBeenCalledTimes(3)
  })

  it('honours a custom intervalMs', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    await setup(cb, { intervalMs: 5_000 })
    expect(cb).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(5_000)
    })
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('exposes a manual refresh trigger', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    const { result } = await setup(cb, { immediate: false })

    await act(async () => {
      await result.current.refresh()
    })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(result.current.lastUpdated).toBeInstanceOf(Date)
  })

  it('is single-flight: overlapping refreshes are ignored', async () => {
    const d = deferred()
    const cb = jest.fn().mockReturnValue(d.promise)
    const { result } = await setup(cb, { immediate: false })

    // Fire two refreshes while the first is still pending.
    act(() => {
      void result.current.refresh()
      void result.current.refresh()
    })
    expect(cb).toHaveBeenCalledTimes(1)

    await act(async () => {
      d.resolve()
    })

    // After it settles, a fresh refresh runs again.
    await act(async () => {
      await result.current.refresh()
    })
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('captures errors from a failed refresh', async () => {
    const cb = jest.fn().mockRejectedValue(new Error('boom'))
    const { result } = await setup(cb)

    expect(result.current.error).toEqual(new Error('boom'))
    expect(result.current.loading).toBe(false)
    expect(result.current.lastUpdated).toBeNull()
  })

  it('clears a prior error on the next successful refresh', async () => {
    const cb = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    const { result } = await setup(cb)

    expect(result.current.error).toEqual(new Error('boom'))

    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.lastUpdated).toBeInstanceOf(Date)
  })

  it('pauses polling while the document is hidden', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    const { result } = await setup(cb)
    expect(cb).toHaveBeenCalledTimes(1)

    act(() => {
      setVisibility(true)
    })
    expect(result.current.isPaused).toBe(true)

    // No ticks fire while hidden.
    await act(async () => {
      jest.advanceTimersByTime(180_000)
    })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('refreshes on return to visible when the interval has elapsed', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    const { result } = await setup(cb)
    expect(cb).toHaveBeenCalledTimes(1)

    act(() => {
      setVisibility(true)
    })
    // Let the (paused) interval window pass in wall-clock terms.
    await act(async () => {
      jest.advanceTimersByTime(90_000)
    })

    await act(async () => {
      setVisibility(false)
    })
    expect(result.current.isPaused).toBe(false)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('does not poll or refresh when disabled', async () => {
    const cb = jest.fn().mockResolvedValue(undefined)
    await setup(cb, { enabled: false })

    await act(async () => {
      jest.advanceTimersByTime(120_000)
    })
    expect(cb).not.toHaveBeenCalled()
  })

  it('passes an AbortSignal and aborts it on unmount', async () => {
    const d = deferred()
    let received: AbortSignal | null = null
    const cb = jest.fn((signal: AbortSignal) => {
      received = signal
      return d.promise
    })

    const { unmount } = await setup(cb)

    expect(received).not.toBeNull()
    expect((received as unknown as AbortSignal).aborted).toBe(false)

    unmount()
    expect((received as unknown as AbortSignal).aborted).toBe(true)

    // Resolving after unmount must not throw or warn.
    await act(async () => {
      d.resolve()
    })
  })

  it('keeps the latest callback without resetting the interval', async () => {
    const first = jest.fn().mockResolvedValue(undefined)
    const second = jest.fn().mockResolvedValue(undefined)

    let rerender!: (props: { fn: typeof first }) => void
    await act(async () => {
      ;({ rerender } = renderHook(({ fn }) => useAutoRefresh(fn), {
        initialProps: { fn: first },
      }))
    })
    expect(first).toHaveBeenCalledTimes(1)

    rerender({ fn: second })

    await act(async () => {
      jest.advanceTimersByTime(60_000)
    })
    // The interval should now call the updated callback, not the stale one.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
  })
})
