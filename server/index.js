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

const requiredEnvVars = ['ADGUARD_URL', 'ADGUARD_USERNAME', 'ADGUARD_PASSWORD'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please create a .env file with the required variables.');
  process.exit(1);
}

const adguardClient = new AdGuardClient(
  process.env.ADGUARD_URL,
  process.env.ADGUARD_USERNAME,
  process.env.ADGUARD_PASSWORD
);

const geoService = new GeoService(config.sourceLat, config.sourceLng, {
  apiUrl: process.env.GEOIP_API_URL,
  apiTimeout: parseInt(process.env.GEOIP_API_TIMEOUT),
  maxRetries: parseInt(process.env.GEOIP_MAX_RETRIES),
  retryDelay: parseInt(process.env.GEOIP_RETRY_DELAY),
  maxCacheSize: parseInt(process.env.GEOIP_MAX_CACHE_SIZE),
  maxRequestsPerMinute: parseInt(process.env.GEOIP_MAX_REQUESTS_PER_MINUTE),
  minRequestDelay: parseInt(process.env.GEOIP_MIN_REQUEST_DELAY)
});

const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      connectSrc: ["'self'", "ws:", "wss:", "https://unpkg.com", "https://demotiles.maplibre.org"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      workerSrc: ["'self'", "blob:"],
      childSrc: ["'self'", "blob:"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.nodeEnv === 'production' ? 100 : 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

app.use(express.static(path.join(__dirname, '../public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connections: activeConnections.size
  });
});

const wss = new WebSocketServer({ server });

const activeConnections = new Set();
let dnsPollingInterval = null;
let statsPollingInterval = null;

const processedIds = new Set();
const MAX_PROCESSED_IDS = config.maxProcessedIds;
let lastPollTime = Date.now();

function startPolling() {
  if (dnsPollingInterval || activeConnections.size === 0) return;

  console.log('▶️  Starting DNS polling...');

  dnsPollingInterval = setInterval(async () => {
    try {
      await pollDNSLogs();
    } catch (error) {
      console.error('Error in DNS polling:', error.message);
      broadcast({ type: 'error', message: 'Failed to fetch DNS logs' });
    }
  }, config.pollInterval);

  statsPollingInterval = setInterval(async () => {
    try {
      await pollStats();
    } catch (error) {
      console.error('Error in stats polling:', error.message);
    }
  }, config.statsInterval);

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

async function pollDNSLogs() {
  const logs = await adguardClient.getQueryLog();

  const currentPollTime = Date.now();
  const timeSinceLastPoll = currentPollTime - lastPollTime;

  const blockedCount = logs.filter(entry => entry.filtered).length;
  const totalCount = logs.length;

  const cutoffTime = new Date(lastPollTime - 2000);
  const newEntries = logs.filter(entry => entry.timestamp > cutoffTime);

  if (totalCount > 0) {
    console.log(`📊 Fetched ${totalCount} DNS entries (${blockedCount} blocked) - ${newEntries.length} new entries since last poll (${(timeSinceLastPoll / 1000).toFixed(1)}s ago)`);
  }

  lastPollTime = currentPollTime;
  let processedCount = 0;
  let skippedDuplicates = 0;

  for (const entry of newEntries) {
    const entryId = `${entry.timestamp.getTime()}-${entry.domain}-${entry.client}`;

    if (processedIds.has(entryId)) {
      skippedDuplicates++;
      continue;
    }

    processedIds.add(entryId);
    if (processedIds.size > MAX_PROCESSED_IDS) {
      const firstId = processedIds.values().next().value;
      processedIds.delete(firstId);
    }

    await processDNSEntry(entry);
    processedCount++;
  }

  if (processedCount > 0 || skippedDuplicates > 0) {
    console.log(`✅ Processed ${processedCount} new queries (skipped ${skippedDuplicates} duplicates)`);
  }
}

async function pollStats() {
  const stats = await adguardClient.getStats();
  broadcast({
    type: 'stats',
    data: stats
  });
}

async function processDNSEntry(entry) {
  const source = geoService.getSource();

  console.log(`\n🔍 Processing DNS Entry: ${entry.domain} (${entry.type}) - IP: ${entry.answer?.join(', ') || 'none'}`);

  if (!entry.answer || entry.answer.length === 0) {
    if (entry.cname && !entry.filtered) {
      console.log(`📋 Resolving CNAME: ${entry.domain} → ${entry.cname}`);
      try {
        const resolvedIps = await adguardClient.resolveCNAME(entry.cname);
        if (resolvedIps && resolvedIps.length > 0) {
          console.log(`✅ CNAME resolved: ${entry.cname} → ${resolvedIps.join(', ')}`);
          entry.answer = resolvedIps;
          entry.resolvedFromCname = true;
        } else {
          console.log(`⚠️  CNAME resolution failed for ${entry.cname}`);
        }
      } catch (error) {
        console.error(`❌ Error resolving CNAME ${entry.cname}:`, error.message);
      }
    }

    if (!entry.answer || entry.answer.length === 0) {
      const nonIpRecordTypes = ['HTTPS', 'SRV', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'DNSKEY', 'DS'];
      if (nonIpRecordTypes.includes(entry.type) && !entry.filtered) {
        console.log(`📋 ${entry.type} record for ${entry.domain} has no IPs, attempting A/AAAA resolution`);
        try {
          const resolvedIps = await adguardClient.resolveCNAME(entry.domain);
          if (resolvedIps && resolvedIps.length > 0) {
            console.log(`✅ ${entry.type} → A/AAAA resolved: ${entry.domain} → ${resolvedIps.join(', ')}`);
            entry.answer = resolvedIps;
            entry.resolvedFromNonIpRecord = true;
          } else {
            console.log(`⚠️  ${entry.type} resolution to A/AAAA failed for ${entry.domain}`);
          }
        } catch (error) {
          console.error(`❌ Error resolving ${entry.type} record ${entry.domain}:`, error.message);
        }
      }
    }

    if (!entry.answer || entry.answer.length === 0) {
      if (entry.filtered) {
        if (Math.random() < 0.1) {
          console.log(`🚫 Blocked by AdGuard: ${entry.domain} (reason: ${entry.reason})`);
        }

        broadcast({
          type: 'dns_query',
          timestamp: entry.timestamp.toISOString(),
          source,
          destination: null,
          data: {
            domain: entry.domain,
            ip: 'Blocked',
            queryType: entry.type,
            elapsed: entry.elapsed,
            upstream: entry.upstreamElapsed,
            cached: entry.cached,
            filtered: true,
            clientIp: entry.client,
            status: entry.status
          }
        });
      } else {
        if (Math.random() < 0.05) {
          const statusMsg = entry.status === 'NXDOMAIN' ? 'domain not found' : 'no IP addresses';
          console.log(`ℹ️  No geolocatable IPs: ${entry.domain} (${statusMsg}, reason: ${entry.reason})`);
        }

        broadcast({
          type: 'dns_query',
          timestamp: entry.timestamp.toISOString(),
          source,
          destination: null,
          data: {
            domain: entry.domain,
            ip: 'No Answer',
            queryType: entry.type,
            elapsed: entry.elapsed,
            upstream: entry.upstreamElapsed,
            cached: entry.cached,
            filtered: false,
            clientIp: entry.client,
            status: entry.status
          }
        });
      }
      return;
    }
  }

  for (const ip of entry.answer) {
    console.log(`  🌍 Looking up GeoIP for: ${ip}`);
    const destination = await geoService.lookup(ip);

    if (destination) {
      console.log(`  ✅ GeoIP found: ${destination.city}, ${destination.country} (${destination.lat}, ${destination.lng})`);
    } else {
      console.log(`  ❌ GeoIP lookup failed for: ${ip} (private IP or API failure)`);
    }

    let queryTypeLabel = entry.type;
    if (entry.resolvedFromCname && entry.cname) {
      queryTypeLabel = `CNAME→A/AAAA`;
    } else if (entry.resolvedFromNonIpRecord) {
      queryTypeLabel = `${entry.type}→A/AAAA`;
    }

    const message = {
      type: 'dns_query',
      timestamp: entry.timestamp.toISOString(),
      source,
      destination, // May be null if geo lookup failed or was skipped
      data: {
        domain: entry.domain,
        ip,
        queryType: queryTypeLabel,
        cname: entry.resolvedFromCname ? entry.cname : undefined,
        elapsed: entry.elapsed,
        upstream: entry.upstreamElapsed,
        cached: entry.cached,
        filtered: entry.filtered,
        clientIp: entry.client,
        status: entry.status
      }
    };

    console.log(`  📤 Broadcasting to clients: destination=${!!destination ? 'YES' : 'NO'}`);
    broadcast(message);
  }
}

function broadcast(message) {
  const data = JSON.stringify(message);

  activeConnections.forEach(ws => {
    if (ws.readyState === 1) {
      try {
        ws.send(data);
      } catch (error) {
        console.error('Error broadcasting to client:', error.message);
      }
    }
  });
}

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

  ws.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to DNS Visualization Server',
    config: {
      pollInterval: config.pollInterval,
      maxConcurrentArcs: config.maxConcurrentArcs
    }
  }));
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Closing gracefully...`);

  stopPolling();

  activeConnections.forEach(ws => {
    ws.close(1000, 'Server shutting down');
  });

  wss.close(() => {
    console.log('WebSocket server closed');
  });

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
server.listen(config.port, () => {
  console.log(`\n🚀 DNS Visualization Dashboard`);
  console.log(`📡 Server running on http://localhost:${config.port}`);
  console.log(`🔄 Polling interval: ${config.pollInterval}ms`);
  console.log(`📊 Stats interval: ${config.statsInterval}ms`);
  console.log(`🌍 Source location: Kuala Lumpur (${config.sourceLat}, ${config.sourceLng})`);
  console.log(`🔒 Environment: ${config.nodeEnv}`);
  console.log(`\nWaiting for client connections...\n`);
});
