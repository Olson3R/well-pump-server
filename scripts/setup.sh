#!/bin/bash

# Well Pump Monitor Setup Script

set -e

echo "🚀 Setting up Well Pump Monitor..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p ssl
mkdir -p backups
mkdir -p uploads

# Generate VAPID keys for push notifications
echo "🔑 Generating VAPID keys for push notifications..."
if command -v node &> /dev/null; then
    npx web-push generate-vapid-keys > vapid-keys.txt
    echo "VAPID keys saved to vapid-keys.txt"
else
    echo "⚠️  Node.js not found. Please generate VAPID keys manually using 'npx web-push generate-vapid-keys'"
fi

# Copy environment file
if [ ! -f .env.local ]; then
    echo "📝 Creating environment file..."
    cp .env.production .env.local
    echo "⚠️  Please edit .env.local with your actual configuration values"
else
    echo "✅ .env.local already exists"
fi

# Generate random secrets if not provided
if [ ! -f secrets.txt ]; then
    echo "🔐 Generating random secrets..."
    echo "DB_PASSWORD=$(openssl rand -base64 32)" > secrets.txt
    echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)" >> secrets.txt
    echo "INTERNAL_API_KEY=$(openssl rand -base64 32)" >> secrets.txt
    echo "Secrets saved to secrets.txt"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env.local with your configuration"
echo "2. Add your SSL certificates to the ssl/ directory"
echo "3. Update the domain in nginx.conf"
echo "4. Run: docker-compose up -d"
echo "5. Run: docker-compose exec app npx prisma migrate deploy"
echo "6. Create admin user using the API or database"
echo ""
echo "For SSL certificates, you can use Let's Encrypt:"
echo "certbot certonly --standalone -d your-domain.com"
echo "Then copy the files to ssl/fullchain.pem and ssl/privkey.pem"