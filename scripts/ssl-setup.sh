#!/bin/bash

# SSL Certificate Setup Script for Well Pump Server
# This script obtains Let's Encrypt SSL certificates using certbot

set -e

# Configuration
DOMAIN=""
EMAIL=""
SSL_DIR="./ssl"
# NGINX_CONTAINER="wellpump-nginx" # Removed - no longer using nginx
APP_CONTAINER="wellpump-app"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[SSL-SETUP]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[SSL-SETUP]${NC} $1"
}

error() {
    echo -e "${RED}[SSL-SETUP]${NC} $1"
    exit 1
}

usage() {
    echo "Usage: $0 -d DOMAIN -e EMAIL [OPTIONS]"
    echo ""
    echo "Required:"
    echo "  -d DOMAIN    Domain name for the certificate"
    echo "  -e EMAIL     Email address for Let's Encrypt registration"
    echo ""
    echo "Options:"
    echo "  -s           Staging mode (use Let's Encrypt staging server)"
    echo "  -h           Show this help message"
    echo ""
    echo "Example:"
    echo "  $0 -d myserver.com -e admin@myserver.com"
    exit 1
}

check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if docker is installed
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed or not in PATH"
    fi
    
    # Check if docker-compose is installed
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose is not installed or not in PATH"
    fi
    
    # Check if we're in the right directory
    if [[ ! -f "docker-compose.yml" ]]; then
        error "docker-compose.yml not found. Please run this script from the project root directory."
    fi
    
    log "Prerequisites check passed"
}

create_ssl_directory() {
    log "Creating SSL directory..."
    mkdir -p "$SSL_DIR"
    
    # Set proper permissions
    chmod 755 "$SSL_DIR"
    
    log "SSL directory created at $SSL_DIR"
}

stop_app() {
    log "Stopping app container for certificate generation..."
    docker-compose stop app || warn "App container was not running"
}

start_app() {
    log "Starting app container..."
    docker-compose up -d app
}

obtain_certificate() {
    local staging_flag=""
    if [[ "$STAGING" == "true" ]]; then
        staging_flag="--staging"
        warn "Using Let's Encrypt staging server (test certificates)"
    fi
    
    log "Obtaining SSL certificate for domain: $DOMAIN"
    
    # Use certbot with standalone mode since we stopped nginx
    docker run --rm \
        -v "$(pwd)/$SSL_DIR:/etc/letsencrypt" \
        -v "$(pwd)/$SSL_DIR:/var/lib/letsencrypt" \
        -p 80:80 \
        certbot/certbot certonly \
        --standalone \
        --email "$EMAIL" \
        --agree-tos \
        --no-eff-email \
        $staging_flag \
        -d "$DOMAIN"
    
    if [[ $? -eq 0 ]]; then
        log "Certificate obtained successfully"
    else
        error "Failed to obtain certificate"
    fi
}

setup_certificate_links() {
    log "Setting up certificate symlinks..."
    
    local cert_dir="$SSL_DIR/live/$DOMAIN"
    
    if [[ ! -d "$cert_dir" ]]; then
        error "Certificate directory not found: $cert_dir"
    fi
    
    # Create symlinks for app SSL usage
    ln -sf "../live/$DOMAIN/fullchain.pem" "$SSL_DIR/fullchain.pem"
    ln -sf "../live/$DOMAIN/privkey.pem" "$SSL_DIR/privkey.pem"
    
    log "Certificate symlinks created"
}

verify_certificates() {
    log "Verifying certificates..."
    
    if [[ -f "$SSL_DIR/fullchain.pem" && -f "$SSL_DIR/privkey.pem" ]]; then
        log "Certificate files are present"
        
        # Check certificate expiration
        local expiry=$(openssl x509 -enddate -noout -in "$SSL_DIR/fullchain.pem" | cut -d= -f2)
        log "Certificate expires: $expiry"
        
        return 0
    else
        error "Certificate files not found"
    fi
}

restart_services() {
    log "Restarting services..."
    
    # Restart app to load new certificates
    start_app
    
    # Wait a bit for app to start
    sleep 5
    
    # Verify app is running
    if docker-compose ps app | grep -q "Up"; then
        log "Services restarted successfully"
    else
        error "Failed to restart app"
    fi
}

main() {
    local STAGING="false"
    
    # Parse command line arguments
    while getopts "d:e:sh" opt; do
        case $opt in
            d) DOMAIN="$OPTARG" ;;
            e) EMAIL="$OPTARG" ;;
            s) STAGING="true" ;;
            h) usage ;;
            *) usage ;;
        esac
    done
    
    # Check required arguments
    if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
        error "Domain and email are required"
    fi
    
    log "Starting SSL certificate setup for $DOMAIN"
    
    check_prerequisites
    create_ssl_directory
    stop_app
    obtain_certificate
    setup_certificate_links
    verify_certificates
    restart_services
    
    log "SSL certificate setup completed successfully!"
    log "Your certificate is ready. You can now configure your app to use SSL directly."
    
    if [[ "$STAGING" == "true" ]]; then
        warn "Remember: You used staging certificates. Run without -s flag for production certificates."
    fi
}

# Run main function
main "$@"