import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import AdGuardClient from './adguard-client.js';
import GeoService from './geo-service.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 8080;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS) || 2000;
const MAX_CONCURRENT_ARCS = parseInt(process.env.MAX_CONCURRENT_ARCS) || 100;

// Initialize services
const adguardClient = new AdGuardClient(
  process.env.ADGUARD_URL || 'http://localhost:3000',
  process.env.ADGUARD_USERNAME || 'admin',
  process.env.ADGUARD_PASSWORD || ''
);

const geoService = new GeoService(
  process.env.SOURCE_LAT || '3.139',
  process.env.SOURCE_LNG || '101.6869'
);

// Express app setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://demotiles.maplibre.org", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https:"],
      workerSrc: ["'self'", "blob:"]
    }
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});

app.use(limiter);

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// WebSocket connection handling
const activeConnections = new Set();
let pollingInterval = null;
let statsInterval = null;
let processedLogIds = new Set();
const MAX_PROCESSED_IDS = 1000;

wss.on('connection', (ws) => {
  console.log('Client connected');
  activeConnections.add(ws);

  ws.on('close', () => {
    console.log('Client disconnected');
    activeConnections.delete(ws);

    // Stop polling if no clients
    if (activeConnections.size === 0) {
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
      if (statsInterval) {
        clearInterval(statsInterval);
        statsInterval = null;
      }
      console.log('Polling stopped - no active clients');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    activeConnections.delete(ws);
  });

  // Start polling if this is the first client
  if (activeConnections.size === 1 && !pollingInterval) {
    startPolling();
    startStatsPolling();
  }
});

/**
 * Start polling AdGuard Home for DNS logs
 */
async function startPolling() {
  console.log('Starting DNS log polling...');

  // Test connection first
  const connected = await adguardClient.testConnection();
  if (!connected) {
    console.error('Failed to connect to AdGuard Home API');
    broadcastError('Failed to connect to AdGuard Home');
    return;
  }

  console.log('Connected to AdGuard Home successfully');

  pollingInterval = setInterval(async () => {
    try {
      const logs = await adguardClient.getQueryLog(20);

      // Process each log entry
      for (const log of logs) {
        // Create unique ID for deduplication
        const logId = `${log.timestamp.getTime()}-${log.client}-${log.domain}`;

        if (processedLogIds.has(logId)) {
          continue;
        }

        processedLogIds.add(logId);

        // Manage set size
        if (processedLogIds.size > MAX_PROCESSED_IDS) {
          const firstId = processedLogIds.values().next().value;
          processedLogIds.delete(firstId);
        }

        // Process DNS entry
        await processDNSEntry(log);
      }
    } catch (error) {
      console.error('Error polling DNS logs:', error.message);
      broadcastError('Error fetching DNS logs');
    }
  }, POLL_INTERVAL);
}

/**
 * Start polling AdGuard Home for statistics
 */
async function startStatsPolling() {
  console.log('Starting stats polling...');

  // Send stats every 5 seconds
  statsInterval = setInterval(async () => {
    try {
      const stats = await adguardClient.getStats();
      
      // Broadcast stats to all clients
      broadcast({
        type: 'stats',
        timestamp: new Date().toISOString(),
        data: stats
      });
    } catch (error) {
      console.error('Error polling stats:', error.message);
    }
  }, 5000); // Poll every 5 seconds
}

/**
 * Process a DNS log entry and broadcast to clients
 * @param {Object} log - DNS log entry
 */
async function processDNSEntry(log) {
  const source = geoService.getSource();

  // Process each answer IP
  if (log.answer && log.answer.length > 0) {
    for (const ip of log.answer) {
      const destination = geoService.lookup(ip);

      if (destination) {
        const event = {
          type: 'dns_query',
          timestamp: log.timestamp.toISOString(),
          source: source,
          destination: destination,
          data: {
            domain: log.domain,
            queryType: log.type,
            ip: ip,
            clientIp: log.client,
            elapsed: log.elapsed,
            status: log.status,
            cached: log.cached,
            filtered: log.filtered,
            reason: log.reason
          }
        };

        broadcast(event);
      }
    }
  } else {
    // No answer IPs - still show the query
    const event = {
      type: 'dns_query',
      timestamp: log.timestamp.toISOString(),
      source: source,
      destination: null,
      data: {
        domain: log.domain,
        queryType: log.type,
        clientIp: log.client,
        elapsed: log.elapsed,
        status: log.status,
        cached: log.cached,
        filtered: log.filtered,
        reason: log.reason
      }
    };

    broadcast(event);
  }
}

/**
 * Broadcast message to all connected clients
 * @param {Object} message - Message to broadcast
 */
function broadcast(message) {
  const data = JSON.stringify(message);

  activeConnections.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });
}

/**
 * Broadcast error message
 * @param {string} error - Error message
 */
function broadcastError(error) {
  broadcast({
    type: 'error',
    message: error,
    timestamp: new Date().toISOString()
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');

  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`DNS Visualization Dashboard running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready for connections`);
});
