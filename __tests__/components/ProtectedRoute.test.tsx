import { render, screen } from '@testing-library/react'
import { ProtectedRoute } from '@/components/ProtectedRoute'

// Mock next/navigation
const mockPush = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}))

// Mock next-auth
const mockUseSession = jest.fn()
jest.mock('next-auth/react', () => ({
  useSession: () => mockUseSession(),
}))

describe('ProtectedRoute', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders children when user is authenticated with correct role', () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: '1',
          username: 'testuser',
          role: 'ADMIN',
        },
      },
      status: 'authenticated',
    })

    render(
      <ProtectedRoute requiredRole="ADMIN">
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
  })

  it('renders children when user is authenticated and no specific role required', () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: '1',
          username: 'testuser',
          role: 'VIEWER',
        },
      },
      status: 'authenticated',
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
  })

  it('shows loading spinner when session is loading', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'loading',
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(screen.getByRole('status')).toBeInTheDocument() // Loading spinner
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('redirects to signin when user is not authenticated', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    })

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(mockPush).toHaveBeenCalledWith('/auth/signin')
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('redirects to unauthorized when user lacks required role', () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: '1',
          username: 'testuser',
          role: 'VIEWER',
        },
      },
      status: 'authenticated',
    })

    render(
      <ProtectedRoute requiredRole="ADMIN">
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(mockPush).toHaveBeenCalledWith('/unauthorized')
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument()
  })

  it('allows admin to access viewer-required routes', () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: '1',
          username: 'testuser',
          role: 'ADMIN',
        },
      },
      status: 'authenticated',
    })

    render(
      <ProtectedRoute requiredRole="VIEWER">
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    expect(screen.getByText('Protected Content')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('does not redirect multiple times', () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: 'unauthenticated',
    })

    const { rerender } = render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    // Re-render with same props
    rerender(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>
    )

    // Should only call push once
    expect(mockPush).toHaveBeenCalledTimes(1)
  })
})