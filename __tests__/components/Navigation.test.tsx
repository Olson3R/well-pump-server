import { render, screen, fireEvent } from '@testing-library/react'
import { Navigation } from '@/components/Navigation'

// Mock next-auth
const mockSignOut = jest.fn()
const mockUseSession = jest.fn()

jest.mock('next-auth/react', () => ({
  useSession: mockUseSession,
  signOut: mockSignOut,
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
    
    // Mobile menu should not be visible initially
    expect(screen.queryByText('testuser (ADMIN)')).not.toBeVisible()
    
    // Click hamburger menu
    const menuButton = screen.getByRole('button', { name: /menu/i })
    fireEvent.click(menuButton)
    
    // Mobile menu should be visible
    expect(screen.getByText('testuser (ADMIN)')).toBeVisible()
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