const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function createAdminUser(username, password, email) {
  try {
    // Validate arguments
    if (!username || !password) {
      console.error('Usage: node scripts/create-admin.js <username> <password> [email]')
      console.error('Example: node scripts/create-admin.js admin MySecurePass123! admin@example.com')
      process.exit(1)
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { username }
    })

    if (existingUser) {
      console.log(`User '${username}' already exists`)
      return
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    // Create admin user
    const user = await prisma.user.create({
      data: {
        username,
        email: email || `${username}@wellpump.local`,
        password: hashedPassword,
        role: 'ADMIN'
      }
    })

    console.log('Admin user created successfully:', {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role
    })

  } catch (error) {
    console.error('Error creating admin user:', error)
  } finally {
    await prisma.$disconnect()
  }
}

// Get command line arguments
const args = process.argv.slice(2)
const username = args[0]
const password = args[1]
const email = args[2]

createAdminUser(username, password, email)