import React, { ReactElement } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { SessionProvider } from 'next-auth/react'

// Mock session data
const defaultSession = {
  user: {
    id: '1',
    username: 'testuser',
    email: 'test@example.com',
    role: 'ADMIN',
  },
  expires: '2023-12-31',
}

// Custom render function with providers
interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  session?: any
}

function AllTheProviders({ children, session = defaultSession }: { children: React.ReactNode, session?: any }) {
  return (
    <SessionProvider session={session}>
      {children}
    </SessionProvider>
  )
}

const customRender = (
  ui: ReactElement,
  { session, ...options }: CustomRenderOptions = {}
) => render(ui, { wrapper: (props) => <AllTheProviders {...props} session={session} />, ...options })

// Re-export everything
export * from '@testing-library/react'

// Override render method
export { customRender as render }

// Mock data generators
export const createMockSensorData = (overrides = {}) => ({
  id: 'sensor-1',
  device: 'well-pump-monitor',
  location: 'Pump House',
  timestamp: new Date().toISOString(),
  startTime: new Date().toISOString(),
  endTime: new Date().toISOString(),
  sampleCount: 60,
  tempMin: 18.0,
  tempMax: 22.0,
  tempAvg: 20.0,
  humMin: 60.0,
  humMax: 70.0,
  humAvg: 65.0,
  pressMin: 35.0,
  pressMax: 45.0,
  pressAvg: 40.0,
  current1Min: 0.0,
  current1Max: 5.0,
  current1Avg: 2.5,
  current1RMS: 2.8,
  dutyCycle1: 0.3,
  current2Min: 0.0,
  current2Max: 0.5,
  current2Avg: 0.2,
  current2RMS: 0.3,
  dutyCycle2: 0.1,
  createdAt: new Date().toISOString(),
  ...overrides,
})

export const createMockEvent = (overrides = {}) => ({
  id: 'event-1',
  device: 'well-pump-monitor',
  location: 'Pump House',
  timestamp: new Date().toISOString(),
  type: 'HIGH_CURRENT',
  value: 8.5,
  threshold: 7.0,
  startTime: new Date().toISOString(),
  duration: '30000',
  active: true,
  description: 'High current detected',
  acknowledged: false,
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: new Date().toISOString(),
  ...overrides,
})

export const createMockUser = (overrides = {}) => ({
  id: '1',
  username: 'testuser',
  email: 'test@example.com',
  role: 'ADMIN',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastLoginAt: new Date().toISOString(),
  ...overrides,
})

export const createMockNotificationSettings = (overrides = {}) => ({
  id: 'settings-1',
  userId: '1',
  pushEnabled: true,
  pushoverEnabled: false,
  pushoverToken: null,
  pushoverUser: null,
  highCurrentAlert: true,
  lowPressureAlert: true,
  lowTemperatureAlert: true,
  sensorErrorAlert: true,
  missingDataAlert: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
})

// Mock fetch response helper
export const createMockFetchResponse = (data: any, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(data),
  text: () => Promise.resolve(JSON.stringify(data)),
})

// Mock error response helper
export const createMockErrorResponse = (message: string, status = 500) => ({
  ok: false,
  status,
  json: () => Promise.resolve({ error: message }),
  text: () => Promise.resolve(JSON.stringify({ error: message })),
})

// Wait for async operations
export const waitForAsync = () => new Promise(resolve => setTimeout(resolve, 0))

// Mock console methods to avoid noise in tests
export const mockConsole = () => {
  const originalConsole = { ...console }
  
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.assign(console, originalConsole)
  })
}