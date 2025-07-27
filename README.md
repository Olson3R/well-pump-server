# Well Pump Monitor

A comprehensive Next.js application for monitoring well pump sensors with real-time alerts and data visualization.

## Features

- 📊 **Real-time Dashboard** - Live sensor readings and system status
- 📈 **Data Visualization** - Interactive charts and tabular data views
- 🔔 **Alert System** - Push notifications and Pushover integration
- 📱 **PWA Support** - Installable on mobile devices (iOS optimized)
- 👥 **Role-based Access** - Admin and Viewer user roles
- 📤 **Data Export** - CSV and JSON export functionality
- 🗄️ **Data Retention** - Configurable automatic cleanup
- 🐳 **Docker Ready** - Production deployment with Docker Compose

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Docker & Docker Compose (for production)

### Development Setup

1. **Clone and Install**
   ```bash
   git clone <repository>
   cd well-pump-monitor
   npm install
   ```

2. **Database Setup**
   ```bash
   # Start PostgreSQL
   # Update DATABASE_URL in .env.local
   npx prisma migrate dev
   npx prisma generate
   ```

3. **Environment Configuration**
   ```bash
   cp .env.production .env.local
   # Edit .env.local with your settings
   ```

4. **Start Development Server**
   ```bash
   npm run dev
   ```

### Production Deployment (Docker)

1. **Run Setup Script**
   ```bash
   ./scripts/setup.sh
   ```

2. **Configure Environment**
   ```bash
   # Edit .env.local with production values
   # Add SSL certificates to ssl/ directory
   ```

3. **Deploy**
   ```bash
   docker-compose up -d
   docker-compose exec app npx prisma migrate deploy
   ```

## ESP32 Integration

Update your ESP32 code to send data to the new API endpoints:

**Sensor Data** (`POST /api/sensors`):
```json
{
  "device": "well-pump-monitor",
  "location": "Pump House", 
  "timestamp": "1640995200000",
  "startTime": "1640995140000",
  "endTime": "1640995200000",
  "sampleCount": 60,
  "tempMin": 18.5, "tempMax": 19.2, "tempAvg": 18.8,
  "humMin": 65.0, "humMax": 68.5, "humAvg": 66.7,
  "pressMin": 38.2, "pressMax": 42.1, "pressAvg": 40.3,
  "current1Min": 0.1, "current1Max": 7.8, "current1Avg": 2.3, "current1RMS": 2.8, "dutyCycle1": 0.35,
  "current2Min": 0.0, "current2Max": 0.2, "current2Avg": 0.1, "current2RMS": 0.1, "dutyCycle2": 0.0
}
```

**Events** (`POST /api/events`):
```json
{
  "device": "well-pump-monitor",
  "location": "Pump House",
  "timestamp": "1640995200000",
  "type": 1,
  "value": 8.5,
  "threshold": 7.2, 
  "startTime": "1640995180000",
  "duration": 20000,
  "active": true,
  "description": "High current detected on pump 1"
}
```

## Configuration

### Key Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `NEXTAUTH_SECRET` - NextAuth.js secret key  
- `DATA_RETENTION_YEARS` - Data retention period (default: 3)
- `VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY` - Push notification keys
- `PUSHOVER_TOKEN` - Pushover API token (optional)

## Deployment

Ready for production deployment on Vultr with Docker Compose, Nginx reverse proxy, and automatic SSL.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit pull request

## License

MIT License