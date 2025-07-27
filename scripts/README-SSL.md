# SSL Certificate Management

This directory contains scripts for managing Let's Encrypt SSL certificates for the Well Pump Server.

## Scripts Overview

### 1. ssl-setup.sh
Initial SSL certificate setup script using Let's Encrypt/certbot.

**Usage:**
```bash
./scripts/ssl-setup.sh -d yourdomain.com -e your@email.com
```

**Options:**
- `-d DOMAIN`: Domain name for the certificate (required)
- `-e EMAIL`: Email address for Let's Encrypt registration (required)
- `-s`: Use staging server for testing (optional)
- `-h`: Show help

**Example:**
```bash
# Production certificate
./scripts/ssl-setup.sh -d myserver.com -e admin@myserver.com

# Test certificate (staging)
./scripts/ssl-setup.sh -d myserver.com -e admin@myserver.com -s
```

### 2. ssl-renew.sh
Automatic SSL certificate renewal script.

**Usage:**
```bash
./scripts/ssl-renew.sh [OPTIONS]
```

**Options:**
- `-f`: Force renewal even if not due
- `-d`: Dry run (check without renewing)
- `-q`: Quiet mode
- `-h`: Show help

**Examples:**
```bash
# Check and renew if needed
./scripts/ssl-renew.sh

# Force renewal
./scripts/ssl-renew.sh -f

# Dry run check
./scripts/ssl-renew.sh -d
```

### 3. install-renewal.sh
Sets up automatic renewal using systemd timers or cron jobs.

**Usage (requires root/sudo):**
```bash
sudo ./scripts/install-renewal.sh [OPTIONS]
```

**Options:**
- `-s`: Use systemd timer (default if available)
- `-c`: Use cron job
- `-u`: Uninstall automation
- `-h`: Show help

## Quick Start

1. **Initial Setup:**
   ```bash
   # Set up SSL certificate for your domain
   ./scripts/ssl-setup.sh -d yourdomain.com -e your@email.com
   ```

2. **Install Automatic Renewal:**
   ```bash
   # Install automatic renewal (requires sudo)
   sudo ./scripts/install-renewal.sh
   ```

3. **Test the Setup:**
   ```bash
   # Test renewal process (dry run)
   ./scripts/ssl-renew.sh -d
   ```

## How It Works

### Certificate Acquisition
- Uses Docker to run certbot in standalone mode
- Temporarily stops nginx during certificate generation
- Creates certificates in `./ssl/` directory
- Sets up symlinks for nginx to use

### Automatic Renewal
- Checks certificate expiry twice daily
- Renews certificates with less than 30 days remaining
- Automatically restarts nginx after successful renewal
- Logs all activities for monitoring

### Security Features
- Backup of existing certificates before renewal
- Verification of new certificates before service restart
- Proper file permissions and ownership
- Rate limiting protection through Let's Encrypt

## Directory Structure

After setup, your SSL directory will look like:
```
ssl/
├── live/
│   └── yourdomain.com/
│       ├── fullchain.pem
│       └── privkey.pem
├── archive/
├── renewal/
├── fullchain.pem -> live/yourdomain.com/fullchain.pem
├── privkey.pem -> live/yourdomain.com/privkey.pem
└── backup-YYYYMMDD-HHMMSS/
```

## Monitoring

### Systemd (if using systemd timer)
```bash
# Check timer status
systemctl status ssl-renewal.timer

# View renewal logs
journalctl -u ssl-renewal.service

# List next scheduled runs
systemctl list-timers ssl-renewal.timer
```

### Cron (if using cron job)
```bash
# View cron job
cat /etc/cron.d/ssl-renewal

# Check logs
grep ssl-renewal /var/log/syslog
```

### Manual Monitoring
```bash
# Check certificate expiry
openssl x509 -enddate -noout -in ./ssl/fullchain.pem

# View renewal log
tail -f /var/log/ssl-renewal.log
```

## Troubleshooting

### Common Issues

1. **Certificate generation fails:**
   - Ensure domain points to your server
   - Check if port 80 is accessible from internet
   - Verify nginx is stopped during certificate generation

2. **Renewal fails:**
   - Check logs: `journalctl -u ssl-renewal.service`
   - Ensure Docker and docker-compose are available
   - Verify SSL directory permissions

3. **Services don't restart:**
   - Check docker-compose status
   - Verify nginx configuration
   - Check certificate file permissions

### Manual Certificate Renewal
```bash
# Force certificate renewal
./scripts/ssl-renew.sh -f

# Check what would be renewed
./scripts/ssl-renew.sh -d
```

### Reset SSL Setup
```bash
# Remove automation
sudo ./scripts/install-renewal.sh -u

# Remove certificates (careful!)
rm -rf ./ssl/

# Start fresh
./scripts/ssl-setup.sh -d yourdomain.com -e your@email.com
```

## Important Notes

- **Domain Requirements**: Your domain must point to the server where you're running this
- **Port 80 Access**: The server must be accessible on port 80 from the internet
- **Let's Encrypt Limits**: Be aware of Let's Encrypt rate limits (5 certificates per domain per week)
- **Testing**: Always test with staging certificates first (`-s` flag)
- **Backup**: Certificates are automatically backed up before renewal

## Security Considerations

- Certificates are stored in `./ssl/` directory with appropriate permissions
- Private keys are never logged or transmitted
- Automatic renewal reduces risk of expired certificates
- Rate limiting prevents abuse

For additional help or issues, check the logs and ensure all prerequisites are met.