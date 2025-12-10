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

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration with validation
const config = {
  port: parseInt(process.env.PORT) || 8080,
  pollInterval: parseInt(process.env.POLL_INTERVAL_MS) || 2000,
  statsInterval: parseInt(process.env.STATS_INTERVAL_MS) || 5000,
  maxProcessedIds: parseInt(process.env.MAX_PROCESSED_IDS) || 1000,
  maxConcurrentArcs: parseInt(process.env.MAX_CONCURRENT_ARCS) || 50,
  sourceLat: parseFloat(process.env.SOURCE_LAT) || 3.139,
  sourceLng: parseFloat(process.env.SOURCE_LNG) || 101.6869,
  nodeEnv: process.env.NODE_ENV || 'development'
};

// Validate required environment variables
const requiredEnvVars = ['ADGUARD_URL', 'ADGUARD_USERNAME', 'ADGUARD_PASSWORD'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please create a .env file with the required variables.');
  process.exit(1);
}

// Initialize services
const adguardClient = new AdGuardClient(
  process.env.ADGUARD_URL,
  process.env.ADGUARD_USERNAME,
  process.env.ADGUARD_PASSWORD
);

const geoService = new GeoService(config.sourceLat, config.sourceLng);

// Express app setup
const app = express();
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://demotiles.maplibre.org"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// Rate limiting - More restrictive for production
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.nodeEnv === 'production' ? 100 : 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: activeConnections.size
  });
});

// WebSocket server
const wss = new WebSocketServer({ server });

// Connection management
const activeConnections = new Set();
let dnsPollingInterval = null;
let statsPollingInterval = null;

// Track processed DNS entries to prevent duplicates (with size limit)
const processedIds = new Set();
const MAX_PROCESSED_IDS = config.maxProcessedIds;

// Start/Stop polling based on active connections
function startPolling() {
  if (dnsPollingInterval || activeConnections.size === 0) return;

  console.log('▶️  Starting DNS polling...');

  // Poll DNS logs
  dnsPollingInterval = setInterval(async () => {
    try {
      await pollDNSLogs();
    } catch (error) {
      console.error('Error in DNS polling:', error.message);
      broadcast({ type: 'error', message: 'Failed to fetch DNS logs' });
    }
  }, config.pollInterval);

  // Poll stats
  statsPollingInterval = setInterval(async () => {
    try {
      await pollStats();
    } catch (error) {
      console.error('Error in stats polling:', error.message);
    }
  }, config.statsInterval);

  // Initial fetch
  pollDNSLogs().catch(err => console.error('Initial DNS poll failed:', err));
  pollStats().catch(err => console.error('Initial stats poll failed:', err));
}

function stopPolling() {
  if (activeConnections.size > 0) return;

  console.log('⏸️  Stopping DNS polling (no active connections)...');

  if (dnsPollingInterval) {
    clearInterval(dnsPollingInterval);
    dnsPollingInterval = null;
  }

  if (statsPollingInterval) {
    clearInterval(statsPollingInterval);
    statsPollingInterval = null;
  }
}

/**
 * Poll DNS logs from AdGuard Home
 */
async function pollDNSLogs() {
  const logs = await adguardClient.getQueryLog();

  for (const entry of logs) {
    // Create unique ID for deduplication
    const entryId = `${entry.timestamp.getTime()}-${entry.domain}-${entry.client}`;

    if (processedIds.has(entryId)) continue;

    // Add to processed set with size limit
    processedIds.add(entryId);
    if (processedIds.size > MAX_PROCESSED_IDS) {
      // Remove oldest entry (first item)
      const firstId = processedIds.values().next().value;
      processedIds.delete(firstId);
    }

    // Process entry if it has valid answer IPs
    if (entry.answer && entry.answer.length > 0) {
      await processDNSEntry(entry);
    }
  }
}

/**
 * Poll statistics from AdGuard Home
 */
async function pollStats() {
  const stats = await adguardClient.getStats();
  broadcast({
    type: 'stats',
    data: stats
  });
}

/**
 * Process a single DNS entry
 */
async function processDNSEntry(entry) {
  const source = geoService.getSource();

  // Process each IP address in the answer
  for (const ip of entry.answer) {
    const destination = geoService.lookup(ip);

    if (!destination) continue;

    // Broadcast to all clients
    broadcast({
      type: 'dns_query',
      timestamp: entry.timestamp.toISOString(),
      source,
      destination,
      data: {
        domain: entry.domain,
        ip,
        queryType: entry.type,
        elapsed: entry.elapsed,
        cached: entry.cached,
        filtered: entry.filtered,
        clientIp: entry.client,
        status: entry.status
      }
    });
  }
}

/**
 * Broadcast message to all connected clients
 */
function broadcast(message) {
  const data = JSON.stringify(message);
  
  activeConnections.forEach(ws => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(data);
      } catch (error) {
        console.error('Error broadcasting to client:', error.message);
      }
    }
  });
}

/**
 * WebSocket connection handler
 */
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`✅ Client connected from ${clientIp} (Total: ${activeConnections.size + 1})`);

  activeConnections.add(ws);
  startPolling();

  ws.on('close', () => {
    console.log(`❌ Client disconnected from ${clientIp} (Total: ${activeConnections.size - 1})`);
    activeConnections.delete(ws);
    stopPolling();
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error from ${clientIp}:`, error.message);
    activeConnections.delete(ws);
    stopPolling();
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to DNS Visualization Server',
    config: {
      pollInterval: config.pollInterval,
      maxConcurrentArcs: config.maxConcurrentArcs
    }
  }));
});

/**
 * Graceful shutdown handler
 */
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Closing gracefully...`);

  // Stop polling
  stopPolling();

  // Close all WebSocket connections
  activeConnections.forEach(ws => {
    ws.close(1000, 'Server shutting down');
  });

  // Close WebSocket server
  wss.close(() => {
    console.log('WebSocket server closed');
  });

  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
server.listen(config.port, () => {
  console.log(`\n🚀 DNS Visualization Dashboard`);
  console.log(`📡 Server running on http://localhost:${config.port}`);
  console.log(`🔄 Polling interval: ${config.pollInterval}ms`);
  console.log(`📊 Stats interval: ${config.statsInterval}ms`);
  console.log(`🌍 Source location: Kuala Lumpur (${config.sourceLat}, ${config.sourceLng})`);
  console.log(`🔒 Environment: ${config.nodeEnv}`);
  console.log(`\nWaiting for client connections...\n`);
});
