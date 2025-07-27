import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import bcrypt from 'bcryptjs'

// Mock Prisma
jest.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}))

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
}))

const mockPrisma = prisma as jest.Mocked<typeof prisma>
const mockBcrypt = bcrypt as jest.Mocked<typeof bcrypt>

describe('Auth Configuration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('CredentialsProvider', () => {
    const credentialsProvider = authOptions.providers[0]

    it('should return null for missing credentials', async () => {
      const result = await credentialsProvider.authorize({})
      expect(result).toBeNull()
    })

    it('should return null for missing username', async () => {
      const result = await credentialsProvider.authorize({
        password: 'password123',
      })
      expect(result).toBeNull()
    })

    it('should return null for missing password', async () => {
      const result = await credentialsProvider.authorize({
        username: 'testuser',
      })
      expect(result).toBeNull()
    })

    it('should return null for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null)

      const result = await credentialsProvider.authorize({
        username: 'nonexistent',
        password: 'password123',
      })

      expect(result).toBeNull()
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'nonexistent' },
      })
    })

    it('should return null for invalid password', async () => {
      const mockUser = {
        id: '1',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedpassword',
        role: 'ADMIN',
      }

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any)
      mockBcrypt.compare.mockResolvedValue(false)

      const result = await credentialsProvider.authorize({
        username: 'testuser',
        password: 'wrongpassword',
      })

      expect(result).toBeNull()
      expect(mockBcrypt.compare).toHaveBeenCalledWith('wrongpassword', 'hashedpassword')
    })

    it('should return user data for valid credentials', async () => {
      const mockUser = {
        id: '1',
        username: 'testuser',
        email: 'test@example.com',
        password: 'hashedpassword',
        role: 'ADMIN',
      }

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any)
      mockBcrypt.compare.mockResolvedValue(true)
      mockPrisma.user.update.mockResolvedValue(mockUser as any)

      const result = await credentialsProvider.authorize({
        username: 'testuser',
        password: 'correctpassword',
      })

      expect(result).toEqual({
        id: '1',
        username: 'testuser',
        email: 'test@example.com',
        role: 'ADMIN',
      })

      expect(mockBcrypt.compare).toHaveBeenCalledWith('correctpassword', 'hashedpassword')
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { lastLoginAt: expect.any(Date) },
      })
    })

    it('should handle user without email', async () => {
      const mockUser = {
        id: '1',
        username: 'testuser',
        email: null,
        password: 'hashedpassword',
        role: 'VIEWER',
      }

      mockPrisma.user.findUnique.mockResolvedValue(mockUser as any)
      mockBcrypt.compare.mockResolvedValue(true)
      mockPrisma.user.update.mockResolvedValue(mockUser as any)

      const result = await credentialsProvider.authorize({
        username: 'testuser',
        password: 'correctpassword',
      })

      expect(result).toEqual({
        id: '1',
        username: 'testuser',
        email: null,
        role: 'VIEWER',
      })
    })
  })

  describe('JWT Callback', () => {
    it('should add user data to token on sign in', async () => {
      const token = { sub: '1' }
      const user = {
        id: '1',
        username: 'testuser',
        role: 'ADMIN',
      }

      const result = await authOptions.callbacks.jwt({ token, user })

      expect(result).toEqual({
        sub: '1',
        role: 'ADMIN',
        username: 'testuser',
      })
    })

    it('should preserve existing token data', async () => {
      const token = {
        sub: '1',
        role: 'ADMIN',
        username: 'testuser',
        exp: 1234567890,
      }

      const result = await authOptions.callbacks.jwt({ token })

      expect(result).toEqual(token)
    })
  })

  describe('Session Callback', () => {
    it('should add user data to session', async () => {
      const session = {
        user: {},
        expires: '2023-12-31',
      }
      const token = {
        sub: '1',
        role: 'ADMIN',
        username: 'testuser',
      }

      const result = await authOptions.callbacks.session({ session, token })

      expect(result).toEqual({
        user: {
          id: '1',
          role: 'ADMIN',
          username: 'testuser',
        },
        expires: '2023-12-31',
      })
    })

    it('should handle missing token data', async () => {
      const session = {
        user: {},
        expires: '2023-12-31',
      }
      const token = {}

      const result = await authOptions.callbacks.session({ session, token })

      expect(result.user.id).toBeUndefined()
      expect(result.user.role).toBeUndefined()
      expect(result.user.username).toBeUndefined()
    })
  })

  describe('Configuration', () => {
    it('should use JWT strategy', () => {
      expect(authOptions.session.strategy).toBe('jwt')
    })

    it('should have custom sign in page', () => {
      expect(authOptions.pages.signIn).toBe('/auth/signin')
    })

    it('should use Prisma adapter', () => {
      expect(authOptions.adapter).toBeDefined()
    })
  })
})