import { createMockSensorData, createMockEvent, createMockUser } from './test-utils'

describe('Test Utilities', () => {
  it('should create mock sensor data with defaults', () => {
    const data = createMockSensorData()
    
    expect(data).toHaveProperty('id')
    expect(data).toHaveProperty('device', 'well-pump-monitor')
    expect(data).toHaveProperty('location', 'Pump House')
    expect(data).toHaveProperty('tempAvg', 20.0)
    expect(data).toHaveProperty('current1Avg', 2.5)
  })

  it('should create mock sensor data with overrides', () => {
    const data = createMockSensorData({
      device: 'custom-device',
      tempAvg: 25.0,
    })
    
    expect(data.device).toBe('custom-device')
    expect(data.tempAvg).toBe(25.0)
    expect(data.location).toBe('Pump House') // Should keep defaults
  })

  it('should create mock event with defaults', () => {
    const event = createMockEvent()
    
    expect(event).toHaveProperty('id')
    expect(event).toHaveProperty('type', 'HIGH_CURRENT')
    expect(event).toHaveProperty('active', true)
    expect(event).toHaveProperty('description', 'High current detected')
  })

  it('should create mock user with defaults', () => {
    const user = createMockUser()
    
    expect(user).toHaveProperty('id', '1')
    expect(user).toHaveProperty('username', 'testuser')
    expect(user).toHaveProperty('role', 'ADMIN')
  })
})