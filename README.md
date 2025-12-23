# DNS Visualization Dashboard

Real-time DNS query visualization on a world map. Connects to AdGuard Home and displays DNS traffic as animated arcs.

## Requirements

- **Node.js** 18 or higher
- **AdGuard Home** installed and running
- **Modern browser** with WebGL support

## Quick Start

```bash
# Clone and install
git clone https://github.com/neur0tic/dns-visualizer.git
cd dns-visualizer
npm install

# Configure
cp .env.example .env
nano .env  # Edit with your settings

# Run
npm start
```

Access at `http://localhost:8080`

## Configuration

Edit `.env` file:

```env
# AdGuard Home Configuration
ADGUARD_URL=http://localhost:3000
ADGUARD_USERNAME=admin
ADGUARD_PASSWORD=your_password_here

# Server Configuration
PORT=8080
NODE_ENV=production

# Optional HTTPS Configuration (leave commented to run HTTP only)
# HTTPS_PORT=8443
# SSL_KEY_PATH=/path/to/privkey.pem
# SSL_CERT_PATH=/path/to/fullchain.pem

# Source Location (Kuala Lumpur)
SOURCE_LAT=3.139
SOURCE_LNG=101.6869

# GeoIP API Configuration (Optional)
# GEOIP_API_URL=http://ip-api.com/json
# GEOIP_API_TIMEOUT=5000
# GEOIP_MAX_RETRIES=2
# GEOIP_RETRY_DELAY=1000
# GEOIP_MAX_CACHE_SIZE=1000
# GEOIP_MAX_REQUESTS_PER_MINUTE=15
# GEOIP_MIN_REQUEST_DELAY=4000

# Performance Settings
MAX_CONCURRENT_ARCS=100
LOG_RETENTION_COUNT=10
POLL_INTERVAL_MS=3000
STATS_INTERVAL_MS=5000
```

### Key Settings

**PORT** - Server port (default: 8080). Change if port is in use.

**SOURCE_LAT/SOURCE_LNG** - Your location coordinates. Find yours at [latlong.net](https://www.latlong.net/)

**POLL_INTERVAL_MS** - How often to check for new DNS queries (milliseconds)
- Lower = more real-time, higher CPU usage
- Higher = less CPU, slight delay

**MAX_CONCURRENT_ARCS** - Maximum arcs shown on map simultaneously
- Lower = better performance on slow hardware
- Higher = more queries visible at once

## Optional HTTPS Setup

The app runs on HTTP by default. To enable HTTPS, provide SSL certificates in `.env`:

```env
# Uncomment and configure these lines in .env
HTTPS_PORT=8443
SSL_KEY_PATH=/etc/letsencrypt/live/yourdomain.com/privkey.pem
SSL_CERT_PATH=/etc/letsencrypt/live/yourdomain.com/fullchain.pem
```

**Generate self-signed certificate (for testing):**
```bash
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes
```

Then in `.env`:
```env
HTTPS_PORT=8443
SSL_KEY_PATH=./key.pem
SSL_CERT_PATH=./cert.pem
```

**With HTTPS enabled:**
- HTTP: `http://localhost:8080` (still works)
- HTTPS: `https://localhost:8443` (also works)
- Both servers run simultaneously
- WebSocket works on both protocols

**Without HTTPS configured:**
- Only HTTP runs on port 8080
- No SSL errors

## Reverse Proxy Setup

For production deployment with HTTPS and additional security.

### Nginx

```nginx
server {
    listen 80;
    server_name dns-viz.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dns-viz.example.com;

    # SSL Configuration
    ssl_certificate /etc/letsencrypt/live/dns-viz.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns-viz.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Proxy to Node.js app
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Rate limiting (optional)
    limit_req_zone $binary_remote_addr zone=dns_viz:10m rate=10r/s;
    limit_req zone=dns_viz burst=20 nodelay;
}
```

### Apache

Enable required modules first:
```bash
sudo a2enmod proxy proxy_http proxy_wstunnel headers ssl rewrite
sudo systemctl restart apache2
```

Configuration:
```apache
<VirtualHost *:80>
    ServerName dns-viz.example.com
    Redirect permanent / https://dns-viz.example.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName dns-viz.example.com

    # SSL Configuration
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/dns-viz.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/dns-viz.example.com/privkey.pem
    SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1
    SSLCipherSuite HIGH:!aNULL:!MD5

    # Security Headers
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set X-Content-Type-Options "nosniff"
    Header always set X-XSS-Protection "1; mode=block"

    # Proxy Configuration
    ProxyPreserveHost On
    ProxyRequests Off

    # WebSocket support
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule /(.*)           ws://localhost:8080/$1 [P,L]
    RewriteCond %{HTTP:Upgrade} !=websocket [NC]
    RewriteRule /(.*)           http://localhost:8080/$1 [P,L]

    # Proxy pass
    ProxyPass / http://localhost:8080/
    ProxyPassReverse / http://localhost:8080/

    # Logging
    ErrorLog ${APACHE_LOG_DIR}/dns-viz-error.log
    CustomLog ${APACHE_LOG_DIR}/dns-viz-access.log combined
</VirtualHost>
```

## Features

- Real-time DNS query visualization with animated arcs
- Interactive world map (dark/light themes)
- Live statistics (response times, blocked queries, cache hits)
- WebSocket streaming for instant updates
- Smart label placement with collision detection
- Configurable source location
- Filter local traffic (.local domains)

## Troubleshooting

**Can't connect to AdGuard:**
- Verify AdGuard Home is running: `curl http://localhost:3000`
- Check `ADGUARD_URL` in `.env` matches your AdGuard address
- Ensure credentials are correct

**No arcs appearing:**
- Check AdGuard query logging is enabled (Settings → DNS Settings)
- Verify you're on Node.js 18+: `node -v`
- Browse websites to generate DNS queries
- Check browser console (F12) for errors

**WebSocket disconnected:**
- Refresh the page
- Check server is running
- If using reverse proxy, verify WebSocket support is enabled

**High CPU usage:**
- Increase `POLL_INTERVAL_MS` to 5000
- Decrease `MAX_CONCURRENT_ARCS` to 50
- Close other browser tabs

## License

MIT

## Credits

Built with MapLibre GL, AdGuard Home, and ip-api.com.
