import { render, screen, fireEvent, within } from '@testing-library/react'
import { Navigation } from '@/components/Navigation'

// Mock next-auth
const mockSignOut = jest.fn()
const mockUseSession = jest.fn()

// Reference the mocks lazily: the jest.mock factory is hoisted above the `const`
// declarations, so calling them directly there would hit the temporal dead zone.
// Wrapping in arrow functions defers the lookup until the mocked hook is actually
// invoked (by which time the consts are initialised).
jest.mock('next-auth/react', () => ({
  useSession: (...args: unknown[]) => mockUseSession(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}))

// Mock next/navigation
jest.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

describe('Navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
  })

  it('renders navigation with all admin menu items', () => {
    render(<Navigation />)
    
    expect(screen.getByText('Well Pump Monitor')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Data')).toBeInTheDocument()
    expect(screen.getByText('Alerts')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('testuser (ADMIN)')).toBeInTheDocument()
  })

  it('highlights current page', () => {
    render(<Navigation />)
    
    const dashboardLink = screen.getByText('Dashboard').closest('a')
    expect(dashboardLink).toHaveClass('border-white', 'text-white')
  })

  it('calls signOut when sign out button is clicked', () => {
    render(<Navigation />)
    
    const signOutButton = screen.getByText('Sign Out')
    fireEvent.click(signOutButton)
    
    expect(mockSignOut).toHaveBeenCalled()
  })

  it('toggles mobile menu', () => {
    render(<Navigation />)

    // The mobile menu panel is not mounted until the hamburger is toggled open.
    // (Visibility here is driven by mount/unmount, not CSS — jsdom does not apply
    // the Tailwind responsive classes that hide it on desktop.)
    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument()

    const menuButton = screen.getByRole('button', { name: /menu/i })
    expect(menuButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(menuButton)

    // Mobile menu panel is now open and exposes the signed-in user.
    const mobileMenu = screen.getByTestId('mobile-menu')
    expect(mobileMenu).toBeInTheDocument()
    expect(menuButton).toHaveAttribute('aria-expanded', 'true')
    expect(within(mobileMenu).getByText('testuser (ADMIN)')).toBeInTheDocument()
  })

  it('renders viewer navigation without settings', () => {
    mockUseSession.mockReturnValue({
      data: {
        user: {
          id: '1',
          username: 'viewer',
          role: 'VIEWER',
        },
      },
      status: 'authenticated',
    })

    render(<Navigation />)
    
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Data')).toBeInTheDocument()
    expect(screen.getByText('Alerts')).toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    expect(screen.getByText('viewer (VIEWER)')).toBeInTheDocument()
  })

  it('closes mobile menu when navigation item is clicked', () => {
    render(<Navigation />)
    
    // Open mobile menu
    const menuButton = screen.getByRole('button', { name: /menu/i })
    fireEvent.click(menuButton)
    
    // Click a navigation item in mobile menu
    const mobileDataLink = screen.getAllByText('Data')[1] // Second one is in mobile menu
    fireEvent.click(mobileDataLink)
    
    // Mobile menu should close (check for the close icon)
    expect(screen.queryByTestId('mobile-menu')).not.toBeInTheDocument()
  })
})