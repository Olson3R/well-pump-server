#!/bin/bash

# SSL Certificate Renewal Script for Well Pump Server
# This script renews Let's Encrypt SSL certificates and restarts services

set -e

# Configuration
SSL_DIR="./ssl"
NGINX_CONTAINER="wellpump-nginx"
APP_CONTAINER="wellpump-app"
LOG_FILE="/var/log/ssl-renewal.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] [SSL-RENEW] $1"
    echo -e "${GREEN}${message}${NC}"
    echo "$message" >> "$LOG_FILE" 2>/dev/null || true
}

warn() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] [SSL-RENEW] WARNING: $1"
    echo -e "${YELLOW}${message}${NC}"
    echo "$message" >> "$LOG_FILE" 2>/dev/null || true
}

error() {
    local message="[$(date '+%Y-%m-%d %H:%M:%S')] [SSL-RENEW] ERROR: $1"
    echo -e "${RED}${message}${NC}"
    echo "$message" >> "$LOG_FILE" 2>/dev/null || true
    exit 1
}

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -f           Force renewal even if certificate is not due for renewal"
    echo "  -d           Dry run mode (check renewal without actually renewing)"
    echo "  -q           Quiet mode (suppress output except errors)"
    echo "  -h           Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0           # Normal renewal check"
    echo "  $0 -f        # Force renewal"
    echo "  $0 -d        # Dry run to check if renewal is needed"
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
    
    # Check if SSL directory exists
    if [[ ! -d "$SSL_DIR" ]]; then
        error "SSL directory not found: $SSL_DIR"
    fi
    
    log "Prerequisites check passed"
}

check_certificate_expiry() {
    log "Checking certificate expiry..."
    
    if [[ ! -f "$SSL_DIR/fullchain.pem" ]]; then
        warn "Certificate file not found, renewal may be needed"
        return 1
    fi
    
    # Check days until expiry
    local expiry_date=$(openssl x509 -enddate -noout -in "$SSL_DIR/fullchain.pem" | cut -d= -f2)
    local expiry_epoch=$(date -d "$expiry_date" +%s)
    local current_epoch=$(date +%s)
    local days_until_expiry=$(( (expiry_epoch - current_epoch) / 86400 ))
    
    log "Certificate expires in $days_until_expiry days ($expiry_date)"
    
    # Renew if less than 30 days remaining
    if [[ $days_until_expiry -lt 30 ]]; then
        log "Certificate needs renewal (less than 30 days remaining)"
        return 1
    else
        log "Certificate is still valid (more than 30 days remaining)"
        return 0
    fi
}

backup_certificates() {
    log "Backing up current certificates..."
    
    local backup_dir="$SSL_DIR/backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup_dir"
    
    if [[ -f "$SSL_DIR/fullchain.pem" ]]; then
        cp "$SSL_DIR/fullchain.pem" "$backup_dir/"
    fi
    
    if [[ -f "$SSL_DIR/privkey.pem" ]]; then
        cp "$SSL_DIR/privkey.pem" "$backup_dir/"
    fi
    
    # Keep only last 5 backups
    ls -dt "$SSL_DIR"/backup-* | tail -n +6 | xargs rm -rf 2>/dev/null || true
    
    log "Certificates backed up to $backup_dir"
}

stop_nginx() {
    log "Stopping nginx container for certificate renewal..."
    docker-compose stop nginx || warn "Nginx container was not running"
}

start_nginx() {
    log "Starting nginx container..."
    docker-compose up -d nginx
}

renew_certificates() {
    local force_flag=""
    local dry_run_flag=""
    
    if [[ "$FORCE_RENEWAL" == "true" ]]; then
        force_flag="--force-renewal"
        log "Force renewal requested"
    fi
    
    if [[ "$DRY_RUN" == "true" ]]; then
        dry_run_flag="--dry-run"
        log "Dry run mode - no actual renewal will occur"
    fi
    
    log "Attempting certificate renewal..."
    
    # Run certbot renew
    docker run --rm \
        -v "$(pwd)/$SSL_DIR:/etc/letsencrypt" \
        -v "$(pwd)/$SSL_DIR:/var/lib/letsencrypt" \
        -p 80:80 \
        certbot/certbot renew \
        $force_flag \
        $dry_run_flag \
        --standalone \
        --no-random-sleep-on-renew
    
    local exit_code=$?
    
    if [[ $exit_code -eq 0 ]]; then
        if [[ "$DRY_RUN" == "true" ]]; then
            log "Dry run completed successfully"
        else
            log "Certificate renewal completed successfully"
        fi
        return 0
    elif [[ $exit_code -eq 1 ]]; then
        warn "No certificates were renewed (they may not be due for renewal yet)"
        return 1
    else
        error "Certificate renewal failed with exit code $exit_code"
    fi
}

verify_renewed_certificates() {
    log "Verifying renewed certificates..."
    
    if [[ "$DRY_RUN" == "true" ]]; then
        log "Skipping certificate verification in dry run mode"
        return 0
    fi
    
    if [[ -f "$SSL_DIR/fullchain.pem" && -f "$SSL_DIR/privkey.pem" ]]; then
        # Check certificate validity
        if openssl x509 -checkend 86400 -noout -in "$SSL_DIR/fullchain.pem" >/dev/null 2>&1; then
            local expiry=$(openssl x509 -enddate -noout -in "$SSL_DIR/fullchain.pem" | cut -d= -f2)
            log "Certificates are valid and expire: $expiry"
            return 0
        else
            error "Certificate verification failed"
        fi
    else
        error "Certificate files not found after renewal"
    fi
}

restart_services() {
    if [[ "$DRY_RUN" == "true" ]]; then
        log "Skipping service restart in dry run mode"
        return 0
    fi
    
    log "Restarting services to load new certificates..."
    
    # Restart nginx
    start_nginx
    
    # Wait for nginx to start
    sleep 5
    
    # Verify services are running
    if docker-compose ps nginx | grep -q "Up"; then
        log "Services restarted successfully"
        
        # Test HTTPS connection
        local domain=$(docker-compose exec -T nginx grep "server_name" /etc/nginx/nginx.conf | grep -v "_" | head -1 | awk '{print $2}' | tr -d ';' || echo "localhost")
        if [[ "$domain" != "localhost" ]]; then
            log "Testing HTTPS connection to $domain..."
            if curl -s -f -k "https://$domain/health" >/dev/null 2>&1; then
                log "HTTPS connection test successful"
            else
                warn "HTTPS connection test failed - check nginx configuration"
            fi
        fi
    else
        error "Failed to restart services"
    fi
}

send_notification() {
    local status="$1"
    local message="$2"
    
    # Log the result
    if [[ "$status" == "success" ]]; then
        log "$message"
    else
        error "$message"
    fi
    
    # You can extend this to send email notifications, Slack messages, etc.
    # Example: echo "$message" | mail -s "SSL Certificate Renewal $status" admin@example.com
}

main() {
    local FORCE_RENEWAL="false"
    local DRY_RUN="false"
    local QUIET="false"
    
    # Parse command line arguments
    while getopts "fdqh" opt; do
        case $opt in
            f) FORCE_RENEWAL="true" ;;
            d) DRY_RUN="true" ;;
            q) QUIET="true" ;;
            h) usage ;;
            *) usage ;;
        esac
    done
    
    # Redirect output if quiet mode
    if [[ "$QUIET" == "true" ]]; then
        exec 1>/dev/null
    fi
    
    log "Starting SSL certificate renewal process..."
    
    check_prerequisites
    
    # Check if renewal is needed (unless forced or dry run)
    if [[ "$FORCE_RENEWAL" != "true" && "$DRY_RUN" != "true" ]]; then
        if check_certificate_expiry; then
            log "Certificate renewal not needed at this time"
            exit 0
        fi
    fi
    
    # Backup current certificates
    if [[ "$DRY_RUN" != "true" ]]; then
        backup_certificates
    fi
    
    # Stop nginx for standalone renewal
    stop_nginx
    
    # Attempt renewal
    if renew_certificates; then
        if [[ "$DRY_RUN" != "true" ]]; then
            verify_renewed_certificates
            restart_services
            send_notification "success" "SSL certificate renewal completed successfully"
        else
            start_nginx
            send_notification "success" "Dry run completed - certificates can be renewed"
        fi
    else
        start_nginx
        if [[ "$DRY_RUN" != "true" ]]; then
            send_notification "info" "SSL certificate renewal skipped - not due for renewal"
        else
            send_notification "info" "Dry run completed - no renewal needed"
        fi
    fi
    
    log "SSL certificate renewal process completed"
}

# Run main function
main "$@"