#!/bin/bash

# Installation script for SSL renewal automation
# This script sets up systemd timers or cron jobs for automatic SSL renewal

set -e

# Configuration
PROJECT_ROOT="/opt/well-pump-server"
SCRIPTS_DIR="$PROJECT_ROOT/scripts"
SYSTEMD_DIR="/etc/systemd/system"
CRON_FILE="/etc/cron.d/ssl-renewal"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[INSTALL]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[INSTALL]${NC} $1"
}

error() {
    echo -e "${RED}[INSTALL]${NC} $1"
    exit 1
}

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -s           Use systemd timer (default if systemd is available)"
    echo "  -c           Use cron job"
    echo "  -u           Uninstall existing renewal automation"
    echo "  -h           Show this help message"
    echo ""
    echo "This script must be run as root or with sudo."
    exit 1
}

check_root() {
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root or with sudo"
    fi
}

check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check if project directory exists
    if [[ ! -d "$PROJECT_ROOT" ]]; then
        error "Project directory not found: $PROJECT_ROOT"
    fi
    
    # Check if renewal script exists
    if [[ ! -f "$SCRIPTS_DIR/ssl-renew.sh" ]]; then
        error "SSL renewal script not found: $SCRIPTS_DIR/ssl-renew.sh"
    fi
    
    # Make sure renewal script is executable
    chmod +x "$SCRIPTS_DIR/ssl-renew.sh"
    
    log "Prerequisites check passed"
}

detect_init_system() {
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet systemd-timedate 2>/dev/null; then
        echo "systemd"
    elif command -v crontab >/dev/null 2>&1; then
        echo "cron"
    else
        echo "unknown"
    fi
}

install_systemd_timer() {
    log "Installing systemd timer for SSL renewal..."
    
    # Copy service and timer files
    cp "$SCRIPTS_DIR/ssl-renewal.service" "$SYSTEMD_DIR/"
    cp "$SCRIPTS_DIR/ssl-renewal.timer" "$SYSTEMD_DIR/"
    
    # Update service file with correct paths
    sed -i "s|/opt/well-pump-server|$PROJECT_ROOT|g" "$SYSTEMD_DIR/ssl-renewal.service"
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable and start the timer
    systemctl enable ssl-renewal.timer
    systemctl start ssl-renewal.timer
    
    # Show timer status
    systemctl status ssl-renewal.timer --no-pager -l
    
    log "Systemd timer installed and started successfully"
    log "Check timer status with: systemctl status ssl-renewal.timer"
    log "View logs with: journalctl -u ssl-renewal.service"
}

install_cron_job() {
    log "Installing cron job for SSL renewal..."
    
    # Create cron job file
    cat > "$CRON_FILE" << EOF
# SSL Certificate Renewal for Well Pump Server
# Runs twice daily at 02:15 and 14:15 with some randomization
15 2,14 * * * root /bin/bash -c 'sleep $((RANDOM \% 3600)); cd $PROJECT_ROOT && $SCRIPTS_DIR/ssl-renew.sh -q'

# Weekly dry run check on Sundays at 01:00
0 1 * * 0 root cd $PROJECT_ROOT && $SCRIPTS_DIR/ssl-renew.sh -d -q
EOF
    
    # Set proper permissions
    chmod 644 "$CRON_FILE"
    
    # Restart cron service if it's running
    if systemctl is-active --quiet cron 2>/dev/null; then
        systemctl restart cron
    elif systemctl is-active --quiet crond 2>/dev/null; then
        systemctl restart crond
    fi
    
    log "Cron job installed successfully"
    log "Cron job file: $CRON_FILE"
    log "View cron logs with: grep ssl-renewal /var/log/syslog"
}

uninstall_automation() {
    log "Uninstalling SSL renewal automation..."
    
    # Remove systemd timer and service
    if [[ -f "$SYSTEMD_DIR/ssl-renewal.timer" ]]; then
        systemctl stop ssl-renewal.timer 2>/dev/null || true
        systemctl disable ssl-renewal.timer 2>/dev/null || true
        rm -f "$SYSTEMD_DIR/ssl-renewal.timer"
        log "Removed systemd timer"
    fi
    
    if [[ -f "$SYSTEMD_DIR/ssl-renewal.service" ]]; then
        rm -f "$SYSTEMD_DIR/ssl-renewal.service"
        log "Removed systemd service"
    fi
    
    # Reload systemd if files were removed
    if systemctl --version >/dev/null 2>&1; then
        systemctl daemon-reload
    fi
    
    # Remove cron job
    if [[ -f "$CRON_FILE" ]]; then
        rm -f "$CRON_FILE"
        
        # Restart cron service if it's running
        if systemctl is-active --quiet cron 2>/dev/null; then
            systemctl restart cron
        elif systemctl is-active --quiet crond 2>/dev/null; then
            systemctl restart crond
        fi
        
        log "Removed cron job"
    fi
    
    log "SSL renewal automation uninstalled"
}

create_log_rotation() {
    log "Setting up log rotation for SSL renewal logs..."
    
    cat > /etc/logrotate.d/ssl-renewal << EOF
/var/log/ssl-renewal.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 644 root root
}
EOF
    
    log "Log rotation configured"
}

test_renewal_script() {
    log "Testing SSL renewal script..."
    
    cd "$PROJECT_ROOT"
    if "$SCRIPTS_DIR/ssl-renew.sh" -d; then
        log "SSL renewal script test passed"
    else
        warn "SSL renewal script test failed - check the script configuration"
    fi
}

main() {
    local USE_SYSTEMD=""
    local USE_CRON=""
    local UNINSTALL=""
    
    # Parse command line arguments
    while getopts "scuh" opt; do
        case $opt in
            s) USE_SYSTEMD="true" ;;
            c) USE_CRON="true" ;;
            u) UNINSTALL="true" ;;
            h) usage ;;
            *) usage ;;
        esac
    done
    
    check_root
    
    if [[ "$UNINSTALL" == "true" ]]; then
        uninstall_automation
        exit 0
    fi
    
    check_prerequisites
    
    # Determine which method to use
    if [[ "$USE_SYSTEMD" == "true" && "$USE_CRON" == "true" ]]; then
        error "Cannot use both systemd and cron. Choose one."
    fi
    
    local init_system=$(detect_init_system)
    
    if [[ -z "$USE_SYSTEMD" && -z "$USE_CRON" ]]; then
        # Auto-detect
        if [[ "$init_system" == "systemd" ]]; then
            USE_SYSTEMD="true"
        elif [[ "$init_system" == "cron" ]]; then
            USE_CRON="true"
        else
            error "Neither systemd nor cron is available"
        fi
    fi
    
    # Install the chosen method
    if [[ "$USE_SYSTEMD" == "true" ]]; then
        if [[ "$init_system" != "systemd" ]]; then
            error "Systemd is not available on this system"
        fi
        install_systemd_timer
    elif [[ "$USE_CRON" == "true" ]]; then
        install_cron_job
    fi
    
    create_log_rotation
    test_renewal_script
    
    log "SSL renewal automation installed successfully!"
    log ""
    log "The system will now automatically:"
    log "- Check for certificate renewal twice daily"
    log "- Renew certificates when they have less than 30 days remaining"
    log "- Restart services after successful renewal"
    log "- Log all activities for monitoring"
    log ""
    log "Manual commands:"
    log "- Force renewal: $SCRIPTS_DIR/ssl-renew.sh -f"
    log "- Dry run check: $SCRIPTS_DIR/ssl-renew.sh -d"
    log "- View logs: journalctl -u ssl-renewal.service (systemd) or grep ssl-renewal /var/log/syslog (cron)"
}

# Run main function
main "$@"