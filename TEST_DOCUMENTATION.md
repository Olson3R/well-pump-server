# Test Documentation

## Overview

This project uses Jest and React Testing Library for comprehensive testing coverage across API endpoints, components, and integration scenarios.

## Test Structure

```
__tests__/
├── api/                    # API endpoint tests
│   ├── sensors.test.ts     # Sensor data ingestion and retrieval
│   ├── events.test.ts      # Event/alert management
│   └── health.test.ts      # System health monitoring
├── components/             # React component tests
│   ├── Navigation.test.tsx # Navigation component
│   └── ProtectedRoute.test.tsx # Route protection
├── lib/                    # Library/utility tests
│   └── auth.test.ts        # Authentication logic
├── pages/                  # Page component tests
│   └── dashboard.test.tsx  # Dashboard page
├── integration/            # Integration tests
│   └── data-flow.test.ts   # End-to-end data flow
└── utils/                  # Test utilities
    ├── test-utils.tsx      # Custom render functions and mocks
    └── test-utils.test.tsx # Test utility tests
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- sensors.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="should create sensor data"
```

## Test Categories

### 1. API Tests

**Sensors API (`__tests__/api/sensors.test.ts`)**
- ✅ POST endpoint validation and data creation
- ✅ GET endpoint with filtering and pagination
- ✅ Error handling for invalid data
- ✅ Database connection error scenarios

**Events API (`__tests__/api/events.test.ts`)**
- ✅ Event creation with type validation
- ✅ Event retrieval with filtering
- ✅ Event acknowledgment functionality
- ✅ BigInt serialization handling

**Health API (`__tests__/api/health.test.ts`)**
- ✅ System health status determination
- ✅ Data freshness monitoring
- ✅ Alert counting and status calculation
- ✅ Database connectivity testing

### 2. Component Tests

**Navigation (`__tests__/components/Navigation.test.tsx`)**
- ✅ Menu rendering based on user role
- ✅ Active page highlighting
- ✅ Mobile menu toggle functionality
- ✅ Sign out functionality

**ProtectedRoute (`__tests__/components/ProtectedRoute.test.tsx`)**
- ✅ Authentication state handling
- ✅ Role-based access control
- ✅ Loading state display
- ✅ Redirect logic for unauthorized access

**Dashboard (`__tests__/pages/dashboard.test.tsx`)**
- ✅ Real-time data display
- ✅ Loading states
- ✅ Error handling
- ✅ Auto-refresh functionality

### 3. Authentication Tests

**Auth Logic (`__tests__/lib/auth.test.ts`)**
- ✅ Credential validation
- ✅ Password verification
- ✅ User session management
- ✅ JWT token handling
- ✅ Database interaction mocking

### 4. Integration Tests

**Data Flow (`__tests__/integration/data-flow.test.ts`)**
- ✅ Complete ESP32 to dashboard flow
- ✅ Multiple event handling
- ✅ Health status updates
- ✅ Error propagation and recovery

## Mock Strategy

### Database Mocking
All tests mock the Prisma client to avoid database dependencies:

```typescript
jest.mock('@/lib/prisma', () => ({
  prisma: {
    sensorData: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    // ... other models
  },
}))
```

### Next.js Mocking
Next.js specific features are mocked in `jest.setup.js`:
- `next/navigation` (useRouter, usePathname)
- `next-auth/react` (useSession, signIn, signOut)
- `recharts` components
- Browser APIs (fetch, IntersectionObserver, etc.)

### Component Mocking
Complex components like charts are mocked to focus on logic testing:

```typescript
jest.mock('recharts', () => ({
  LineChart: ({ children }) => <div data-testid="line-chart">{children}</div>,
  // ... other chart components
}))
```

## Test Data Factories

The `test-utils.tsx` file provides factory functions for creating test data:

```typescript
// Create mock sensor data
const sensorData = createMockSensorData({
  tempAvg: 25.0,
  current1Avg: 8.5
})

// Create mock events
const event = createMockEvent({
  type: 'HIGH_CURRENT',
  active: true
})

// Create mock users
const user = createMockUser({
  role: 'ADMIN'
})
```

## Coverage Goals

- **API Routes**: 100% - Critical for data integrity
- **Components**: 90%+ - Focus on user interactions
- **Authentication**: 100% - Security critical
- **Integration**: Key workflows covered

## Current Coverage

Run `npm run test:coverage` to see detailed coverage reports.

## Testing Best Practices

### 1. Test Structure
- Use descriptive test names
- Group related tests with `describe` blocks
- Set up/tear down properly with `beforeEach`/`afterEach`

### 2. Mocking
- Mock external dependencies
- Use factory functions for test data
- Mock at the right abstraction level

### 3. Assertions
- Test behavior, not implementation
- Use specific matchers
- Test error scenarios

### 4. Component Testing
- Test user interactions
- Verify rendering based on props/state
- Test accessibility features

## Debugging Tests

### Common Issues

1. **Module Resolution**: Ensure `moduleNameMapper` in Jest config matches TypeScript paths
2. **Async Operations**: Use `waitFor` for async operations
3. **Mock Timing**: Clear mocks between tests
4. **DOM Cleanup**: React Testing Library handles cleanup automatically

### Debug Commands

```bash
# Run single test with verbose output
npm test -- --verbose sensors.test.ts

# Run tests with debug info
npm test -- --detectOpenHandles --forceExit

# Run tests in Node inspector
node --inspect-brk node_modules/.bin/jest --runInBand
```

## CI/CD Integration

Tests are designed to run in CI environments:
- No external dependencies
- Deterministic timing with fake timers
- Proper cleanup and isolation
- Fast execution (< 30 seconds for full suite)

## Future Enhancements

1. **E2E Tests**: Add Playwright/Cypress for full browser testing
2. **Performance Tests**: Add tests for large datasets
3. **Security Tests**: Add security-focused test cases
4. **Visual Regression**: Add screenshot testing for components
5. **API Contract Tests**: Add OpenAPI schema validation