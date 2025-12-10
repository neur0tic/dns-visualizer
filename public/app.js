/**
 * DNS Visualization Dashboard - Client Application
 * Production-ready version with error handling, performance optimizations, and security
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const CONFIG = {
  MAX_CONCURRENT_ARCS: 100,
  MAX_LOG_ENTRIES: 15,
  ARC_ANIMATION_DURATION: 200,
  LABEL_LIFETIME: 5000,
  ARC_TRAIL_COUNT: 3,
  ARC_TRAIL_LIFETIME: 2000,
  CHART_DATA_POINTS: 50,
  CHART_UPDATE_DEBOUNCE: 16, // ~60fps
  RECONNECT_BASE_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  RECONNECT_MAX_ATTEMPTS: 10,
  SOURCE_PULSE_THROTTLE: 100,
  DESTINATION_GLOW_DURATION: 1500
};

// DNS Query Type Colors
const DNS_TYPE_COLORS = Object.freeze({
  'A': '#f6ad55',
  'AAAA': '#4299e1',
  'CNAME': '#48bb78',
  'MX': '#9f7aea',
  'TXT': '#ed8936',
  'NS': '#38b2ac',
  'SOA': '#fc8181',
  'PTR': '#f687b3',
  'SRV': '#ecc94b',
  'CAA': '#667eea'
});

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  map: null,
  ws: null,
  isDarkMode: true,
  isSidebarRight: false,
  navigationControl: null,
  activeArcs: [],
  totalQueries: 0,
  blockedQueries: 0,
  responseTimes: [],
  logEntries: [],
  responseChart: null,
  chartData: [],
  sourcePulseActive: false,
  reconnectAttempts: 0,
  reconnectTimeoutId: null,
  chartUpdateTimeoutId: null,
  statsUpdateIntervalId: null
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  try {
    initApp();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    showError('Application initialization failed. Please refresh the page.');
  }
});

function initApp() {
  // Load saved preferences
  loadPreferences();
  
  // Initialize components
  initMap();
  connectWebSocket();
  initResponseChart();
  setupEventListeners();
  
  // Start periodic stats update
  state.statsUpdateIntervalId = setInterval(updateStats, 1000);
}

function setupEventListeners() {
  const themeToggle = document.getElementById('theme-toggle');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarHideToggle = document.getElementById('sidebar-hide-toggle');
  
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebarPosition);
  if (sidebarHideToggle) sidebarHideToggle.addEventListener('click', toggleSidebarVisibility);
  
  // Handle page visibility changes
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Handle window unload
  window.addEventListener('beforeunload', cleanup);
}

function loadPreferences() {
  try {
    const savedPosition = localStorage.getItem('sidebarPosition');
    if (savedPosition === 'right') {
      state.isSidebarRight = true;
      document.body.classList.add('sidebar-right');
    }
    
    const savedSidebarHidden = localStorage.getItem('sidebarHidden');
    if (savedSidebarHidden === 'true') {
      document.body.classList.add('sidebar-hidden');
    }
  } catch (error) {
    console.warn('Failed to load preferences from localStorage:', error);
  }
}

// ============================================================================
// MAP INITIALIZATION
// ============================================================================

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [101.6869, 3.139],
    zoom: 2,
    pitch: 0,
    bearing: 0
  });

  state.map.on('load', onMapLoad);
  state.map.on('error', (e) => {
    console.error('Map error:', e);
    showError('Map failed to load properly.');
  });
}

function onMapLoad() {
  try {
    applyDarkMode();
    hideLoading();
    addPulseSource();
    addSourceMarker();
    addNavigationControls();
  } catch (error) {
    console.error('Map initialization error:', error);
    showError('Map initialization failed.');
  }
}

function addPulseSource() {
  state.map.addSource('pulse-source', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [101.6869, 3.139]
        }
      }]
    }
  });

  state.map.addLayer({
    id: 'pulse-layer',
    type: 'circle',
    source: 'pulse-source',
    paint: {
      'circle-radius': 20,
      'circle-color': '#f6ad55',
      'circle-opacity': 0.8,
      'circle-blur': 0.5
    }
  });

  animatePulse();
}

function animatePulse() {
  let pulsePhase = 0;
  
  function animate() {
    if (!state.map || !state.map.getLayer('pulse-layer')) return;
    
    pulsePhase += 0.02;
    const scale = 1 + Math.sin(pulsePhase) * 0.5;
    const opacity = 0.8 - Math.abs(Math.sin(pulsePhase)) * 0.6;
    
    state.map.setPaintProperty('pulse-layer', 'circle-radius', 20 * scale);
    state.map.setPaintProperty('pulse-layer', 'circle-opacity', opacity);
    
    requestAnimationFrame(animate);
  }
  
  animate();
}

function addSourceMarker() {
  new maplibregl.Marker({ color: '#f6ad55' })
    .setLngLat([101.6869, 3.139])
    .setPopup(new maplibregl.Popup().setText('DNS Source: Kuala Lumpur'))
    .addTo(state.map);
}

function addNavigationControls() {
  state.navigationControl = new maplibregl.NavigationControl();
  const position = state.isSidebarRight ? 'bottom-left' : 'bottom-right';
  state.map.addControl(state.navigationControl, position);
}

// ============================================================================
// WEBSOCKET CONNECTION
// ============================================================================

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    state.ws = new WebSocket(wsUrl);
    
    state.ws.onopen = onWebSocketOpen;
    state.ws.onmessage = onWebSocketMessage;
    state.ws.onerror = onWebSocketError;
    state.ws.onclose = onWebSocketClose;
  } catch (error) {
    console.error('WebSocket connection error:', error);
    scheduleReconnect();
  }
}

function onWebSocketOpen() {
  console.log('WebSocket connected');
  updateStatus('connected', 'Live');
  state.reconnectAttempts = 0;
}

function onWebSocketMessage(event) {
  try {
    const data = JSON.parse(event.data);
    
    // Validate message structure
    if (!data || typeof data !== 'object' || !data.type) {
      console.warn('Invalid message format:', data);
      return;
    }
    
    handleMessage(data);
  } catch (error) {
    console.error('Error parsing WebSocket message:', error);
  }
}

function onWebSocketError(error) {
  console.error('WebSocket error:', error);
  updateStatus('disconnected', 'Error');
}

function onWebSocketClose(event) {
  console.log('WebSocket disconnected:', event.code, event.reason);
  updateStatus('disconnected', 'Disconnected');
  
  if (event.code !== 1000) { // Not a normal closure
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.reconnectTimeoutId) return;
  
  if (state.reconnectAttempts >= CONFIG.RECONNECT_MAX_ATTEMPTS) {
    console.error('Max reconnection attempts reached');
    showError('Connection lost. Please refresh the page.');
    return;
  }
  
  state.reconnectAttempts++;
  
  // Exponential backoff
  const delay = Math.min(
    CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts - 1),
    CONFIG.RECONNECT_MAX_DELAY
  );
  
  console.log(`Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${CONFIG.RECONNECT_MAX_ATTEMPTS})`);
  
  state.reconnectTimeoutId = setTimeout(() => {
    state.reconnectTimeoutId = null;
    connectWebSocket();
  }, delay);
}

function handleMessage(data) {
  switch (data.type) {
    case 'dns_query':
      handleDNSQuery(data);
      break;
    case 'stats':
      handleStats(data);
      break;
    case 'connected':
      console.log('Server welcome:', data.message);
      break;
    case 'error':
      console.error('Server error:', data.message);
      addLogEntry({
        domain: 'System Error',
        details: data.message,
        isError: true
      });
      break;
    default:
      console.warn('Unknown message type:', data.type);
  }
}

// ============================================================================
// MESSAGE HANDLERS
// ============================================================================

function handleStats(event) {
  const statAdguardAvg = document.getElementById('stat-adguard-avg');
  
  if (statAdguardAvg && typeof event.data?.avgProcessingTime === 'number') {
    const avgTime = event.data.avgProcessingTime.toFixed(2);
    animateStat(statAdguardAvg, `${avgTime}ms`);
  }
}

function handleDNSQuery(event) {
  // Validate event data
  if (!event.data || !event.source || !event.destination) {
    console.warn('Invalid DNS query event:', event);
    return;
  }
  
  state.totalQueries++;

  if (event.data.filtered) {
    state.blockedQueries++;
  }

  updateStats();

  // Add to log
  addLogEntry({
    domain: sanitizeString(event.data.domain),
    ip: sanitizeString(event.data.ip) || 'No answer',
    clientIp: sanitizeString(event.data.clientIp),
    type: sanitizeString(event.data.queryType),
    elapsed: parseFloat(event.data.elapsed) || 0,
    cached: Boolean(event.data.cached),
    filtered: Boolean(event.data.filtered),
    timestamp: new Date(event.timestamp)
  });

  // Create arc if we have space
  if (event.destination && state.activeArcs.length < CONFIG.MAX_CONCURRENT_ARCS) {
    createArc(event.source, event.destination, event.data);
  }

  // Track response times
  const elapsed = parseFloat(event.data.elapsed);
  if (!isNaN(elapsed) && elapsed > 0) {
    state.responseTimes.push(elapsed);
    
    // Keep array bounded
    if (state.responseTimes.length > 100) {
      state.responseTimes.shift();
    }
    
    updateResponseChartDebounced(elapsed);
  }
}

// ============================================================================
// ARC VISUALIZATION
// ============================================================================

function createArc(source, destination, data) {
  const arcId = `arc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  state.activeArcs.push(arcId);
  
  const arcColor = getColorForDNSType(data.queryType || data.type);
  
  triggerSourcePulse();
  
  const lineString = createArcGeometry(
    [source.lng, source.lat],
    [destination.lng, destination.lat]
  );

  try {
    state.map.addSource(arcId, {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: lineString
      }
    });

    state.map.addLayer({
      id: arcId,
      type: 'line',
      source: arcId,
      paint: {
        'line-color': arcColor,
        'line-width': 2,
        'line-opacity': 0.8
      }
    });

    animateArc(arcId, lineString, destination, data, arcColor);
  } catch (error) {
    console.error('Error creating arc:', error);
    removeArc(arcId);
  }
}

function createArcGeometry(start, end) {
  const steps = 50;
  const coordinates = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lng = start[0] + (end[0] - start[0]) * t;
    const lat = start[1] + (end[1] - start[1]) * t;
    const arcHeight = Math.sin(t * Math.PI) * 0.3;

    coordinates.push([lng, lat + arcHeight]);
  }

  return {
    type: 'LineString',
    coordinates
  };
}

function animateArc(arcId, lineString, destination, data, arcColor) {
  const steps = lineString.coordinates.length;
  let currentStep = 0;
  let trailCreated = false;

  const interval = setInterval(() => {
    currentStep++;

    if (currentStep >= steps) {
      clearInterval(interval);

      addArcLabel(destination, data);
      createDestinationGlow(destination, arcColor);

      if (!trailCreated) {
        createArcTrail(lineString, arcColor);
        trailCreated = true;
      }

      setTimeout(() => removeArc(arcId), 3000);
      return;
    }

    try {
      const currentCoordinates = lineString.coordinates.slice(0, currentStep);
      
      if (state.map.getSource(arcId)) {
        state.map.getSource(arcId).setData({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: currentCoordinates
          }
        });
      }
    } catch (error) {
      console.error('Error animating arc:', error);
      clearInterval(interval);
      removeArc(arcId);
    }
  }, CONFIG.ARC_ANIMATION_DURATION / steps);
}

function createArcTrail(lineString, arcColor) {
  for (let i = 0; i < CONFIG.ARC_TRAIL_COUNT; i++) {
    setTimeout(() => {
      const trailId = `trail-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const opacity = 0.6 - (i * 0.2);
      
      try {
        state.map.addSource(trailId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: lineString
          }
        });

        state.map.addLayer({
          id: trailId,
          type: 'line',
          source: trailId,
          paint: {
            'line-color': arcColor,
            'line-width': 1.5,
            'line-opacity': opacity
          }
        });

        animateTrailFade(trailId, opacity);
        setTimeout(() => removeArc(trailId), CONFIG.ARC_TRAIL_LIFETIME);
      } catch (error) {
        console.error('Error creating trail:', error);
      }
    }, i * 150);
  }
}

function animateTrailFade(trailId, initialOpacity) {
  const fadeSteps = 20;
  const fadeInterval = CONFIG.ARC_TRAIL_LIFETIME / fadeSteps;
  let currentFade = 0;

  const fade = setInterval(() => {
    currentFade++;
    const opacity = initialOpacity * (1 - currentFade / fadeSteps);

    try {
      if (state.map.getLayer(trailId)) {
        state.map.setPaintProperty(trailId, 'line-opacity', opacity);
      } else {
        clearInterval(fade);
      }
    } catch (error) {
      clearInterval(fade);
    }

    if (currentFade >= fadeSteps) {
      clearInterval(fade);
    }
  }, fadeInterval);
}

function removeArc(arcId) {
  try {
    if (state.map.getLayer(arcId)) {
      state.map.removeLayer(arcId);
    }
    if (state.map.getSource(arcId)) {
      state.map.removeSource(arcId);
    }
  } catch (error) {
    console.warn('Error removing arc:', error);
  }

  state.activeArcs = state.activeArcs.filter(id => id !== arcId);
}

// ============================================================================
// VISUAL EFFECTS
// ============================================================================

function createDestinationGlow(destination, color) {
  const glowId = `glow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    state.map.addSource(glowId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [destination.lng, destination.lat]
          }
        }]
      }
    });

    const glowLayer1 = `${glowId}-1`;
    const glowLayer2 = `${glowId}-2`;

    state.map.addLayer({
      id: glowLayer1,
      type: 'circle',
      source: glowId,
      paint: {
        'circle-radius': 30,
        'circle-color': color,
        'circle-opacity': 0.6,
        'circle-blur': 1
      }
    });

    state.map.addLayer({
      id: glowLayer2,
      type: 'circle',
      source: glowId,
      paint: {
        'circle-radius': 15,
        'circle-color': color,
        'circle-opacity': 0.8,
        'circle-blur': 0.5
      }
    });

    animateGlow(glowId, glowLayer1, glowLayer2);
  } catch (error) {
    console.error('Error creating glow:', error);
  }
}

function animateGlow(glowId, layer1, layer2) {
  const steps = 30;
  const stepDuration = CONFIG.DESTINATION_GLOW_DURATION / steps;
  let currentStep = 0;

  const glowInterval = setInterval(() => {
    currentStep++;
    const progress = currentStep / steps;
    const scale = 1 + (progress * 2);
    const opacity1 = 0.6 * (1 - progress);
    const opacity2 = 0.8 * (1 - progress);

    try {
      if (state.map.getLayer(layer1)) {
        state.map.setPaintProperty(layer1, 'circle-radius', 30 * scale);
        state.map.setPaintProperty(layer1, 'circle-opacity', opacity1);
      }

      if (state.map.getLayer(layer2)) {
        state.map.setPaintProperty(layer2, 'circle-radius', 15 * scale);
        state.map.setPaintProperty(layer2, 'circle-opacity', opacity2);
      }
    } catch (error) {
      clearInterval(glowInterval);
    }

    if (currentStep >= steps) {
      clearInterval(glowInterval);
      setTimeout(() => {
        try {
          if (state.map.getLayer(layer1)) state.map.removeLayer(layer1);
          if (state.map.getLayer(layer2)) state.map.removeLayer(layer2);
          if (state.map.getSource(glowId)) state.map.removeSource(glowId);
        } catch (error) {
          console.warn('Error cleaning up glow:', error);
        }
      }, 100);
    }
  }, stepDuration);
}

function triggerSourcePulse() {
  if (state.sourcePulseActive) return;
  
  state.sourcePulseActive = true;
  
  try {
    if (state.map.getLayer('pulse-layer')) {
      const originalRadius = state.map.getPaintProperty('pulse-layer', 'circle-radius');
      const originalOpacity = state.map.getPaintProperty('pulse-layer', 'circle-opacity');
      
      state.map.setPaintProperty('pulse-layer', 'circle-radius', 35);
      state.map.setPaintProperty('pulse-layer', 'circle-opacity', 1);
      
      setTimeout(() => {
        try {
          if (state.map.getLayer('pulse-layer')) {
            state.map.setPaintProperty('pulse-layer', 'circle-radius', originalRadius);
            state.map.setPaintProperty('pulse-layer', 'circle-opacity', originalOpacity);
          }
        } catch (error) {
          console.warn('Error resetting pulse:', error);
        }
      }, CONFIG.SOURCE_PULSE_THROTTLE);
    }
  } catch (error) {
    console.warn('Error triggering pulse:', error);
  }
  
  setTimeout(() => {
    state.sourcePulseActive = false;
  }, CONFIG.SOURCE_PULSE_THROTTLE);
}

// Continued in next message due to length...
// Continued from part 1...

// ============================================================================
// UI UPDATES
// ============================================================================

function addArcLabel(destination, data) {
  try {
    const point = state.map.project([destination.lng, destination.lat]);

    const label = document.createElement('div');
    label.className = 'arc-label';
    label.style.left = `${point.x}px`;
    label.style.top = `${point.y - 20}px`;

    const domain = sanitizeHTML(data.domain || 'Unknown');
    const ip = data.ip ? sanitizeHTML(data.ip) : '';
    const queryType = sanitizeHTML(data.queryType || data.type || 'A');
    const elapsed = parseFloat(data.elapsed) || 0;
    const cached = data.cached ? ' • Cached' : '';
    const city = sanitizeHTML(destination.city || 'Unknown');
    const country = sanitizeHTML(destination.country || 'Unknown');

    label.innerHTML = `
      <div class="label-domain">${domain}</div>
      <div class="label-detail">
        ${ip ? `<span class="label-ip">${ip}</span> • ` : ''}
        ${queryType} • ${elapsed}ms${cached}
      </div>
      <div class="label-detail">${city}, ${country}</div>
    `;

    document.body.appendChild(label);

    setTimeout(() => {
      if (label.parentNode) {
        label.remove();
      }
    }, CONFIG.LABEL_LIFETIME);
  } catch (error) {
    console.error('Error adding label:', error);
  }
}

function addLogEntry(entry) {
  try {
    const container = document.getElementById('log-container');
    if (!container) return;

    const logDiv = document.createElement('div');
    logDiv.className = entry.filtered ? 'log-entry blocked' : 'log-entry';

    const time = entry.timestamp ? entry.timestamp.toLocaleTimeString() : new Date().toLocaleTimeString();
    const domain = sanitizeHTML(entry.domain || 'Unknown');
    const ip = entry.ip ? sanitizeHTML(entry.ip) : '';
    const clientIp = entry.clientIp ? sanitizeHTML(entry.clientIp) : '';
    const type = sanitizeHTML(entry.type || 'A');
    const elapsed = entry.elapsed ? `${entry.elapsed}ms` : '';
    const cached = entry.cached ? ' • Cached' : '';
    const blocked = entry.filtered ? ' • <span class="log-blocked">BLOCKED</span>' : '';
    const details = entry.details ? sanitizeHTML(entry.details) : '';

    logDiv.innerHTML = `
      <div class="log-time">${time}${clientIp ? ` • <span class="log-client">${clientIp}</span>` : ''}</div>
      <div class="log-domain">${domain}</div>
      <div class="log-details">
        ${ip ? `<span class="log-ip">${ip}</span> • ` : ''}
        ${type}${elapsed ? ` • ${elapsed}` : ''}${cached}${blocked}
        ${details ? ` • ${details}` : ''}
      </div>
    `;

    container.insertBefore(logDiv, container.firstChild);
    state.logEntries.push(logDiv);

    setTimeout(() => {
      if (logDiv.parentNode) {
        logDiv.remove();
      }
    }, 5000);

    // Keep bounded
    while (state.logEntries.length > CONFIG.MAX_LOG_ENTRIES) {
      const oldEntry = state.logEntries.shift();
      if (oldEntry && oldEntry.parentNode) {
        oldEntry.remove();
      }
    }
  } catch (error) {
    console.error('Error adding log entry:', error);
  }
}

function updateStatus(status, text) {
  try {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    if (indicator) {
      indicator.className = `status-indicator ${status === 'disconnected' ? 'disconnected' : ''}`;
    }
    
    if (statusText) {
      statusText.textContent = sanitizeString(text);
    }
  } catch (error) {
    console.error('Error updating status:', error);
  }
}

function updateStats() {
  try {
    const statActive = document.getElementById('stat-active');
    const statTotal = document.getElementById('stat-total');
    const statBlocked = document.getElementById('stat-blocked');
    const statAvg = document.getElementById('stat-avg');

    animateStat(statActive, state.activeArcs.length.toString());
    animateStat(statTotal, state.totalQueries.toString());
    animateStat(statBlocked, state.blockedQueries.toString());

    if (state.responseTimes.length > 0) {
      const sum = state.responseTimes.reduce((a, b) => a + b, 0);
      const avg = sum / state.responseTimes.length;
      
      if (!isNaN(avg) && isFinite(avg)) {
        animateStat(statAvg, `${avg.toFixed(1)}ms`);
      } else {
        animateStat(statAvg, '0ms');
      }
    } else {
      animateStat(statAvg, '0ms');
    }
  } catch (error) {
    console.error('Error updating stats:', error);
  }
}

function animateStat(element, newValue) {
  if (!element) return;
  
  try {
    if (element.textContent !== newValue) {
      element.textContent = newValue;
      element.classList.add('updated');
      setTimeout(() => element.classList.remove('updated'), 600);
    }
  } catch (error) {
    console.error('Error animating stat:', error);
  }
}

// ============================================================================
// CHART RENDERING
// ============================================================================

function initResponseChart() {
  const canvas = document.getElementById('response-chart');
  if (!canvas) return;

  state.responseChart = canvas.getContext('2d');
  state.responseChart.imageSmoothingEnabled = true;
  state.responseChart.imageSmoothingQuality = 'high';

  // Initialize with empty data
  state.chartData = new Array(CONFIG.CHART_DATA_POINTS).fill(0);

  drawResponseChart();
}

function updateResponseChartDebounced(responseTime) {
  state.chartData.push(responseTime);
  
  // Keep bounded
  while (state.chartData.length > CONFIG.CHART_DATA_POINTS) {
    state.chartData.shift();
  }
  
  // Debounce chart updates for performance
  if (state.chartUpdateTimeoutId) return;
  
  state.chartUpdateTimeoutId = setTimeout(() => {
    state.chartUpdateTimeoutId = null;
    requestAnimationFrame(drawResponseChart);
  }, CONFIG.CHART_UPDATE_DEBOUNCE);
}

function drawResponseChart() {
  if (!state.responseChart) return;

  try {
    const canvas = state.responseChart.canvas;
    const width = canvas.width;
    const height = canvas.height;

    state.responseChart.clearRect(0, 0, width, height);

    const lineColor = state.isDarkMode ? '#f6ad55' : '#4264fb';
    const gridColor = state.isDarkMode ? 'rgba(246, 173, 85, 0.1)' : 'rgba(0, 0, 0, 0.05)';
    const textColor = state.isDarkMode ? '#cbd5e0' : '#666';

    // Draw grid
    state.responseChart.strokeStyle = gridColor;
    state.responseChart.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
      const y = (height / 4) * i;
      state.responseChart.beginPath();
      state.responseChart.moveTo(0, y);
      state.responseChart.lineTo(width, y);
      state.responseChart.stroke();
    }

    const maxValue = Math.max(...state.chartData, 50);

    if (state.chartData.length > 0) {
      state.responseChart.strokeStyle = lineColor;
      state.responseChart.lineWidth = 2.5;
      state.responseChart.lineCap = 'round';
      state.responseChart.lineJoin = 'round';

      const gradient = state.responseChart.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, state.isDarkMode ? 'rgba(246, 173, 85, 0.2)' : 'rgba(66, 100, 251, 0.2)');
      gradient.addColorStop(1, state.isDarkMode ? 'rgba(246, 173, 85, 0)' : 'rgba(66, 100, 251, 0)');

      const points = state.chartData.map((value, index) => ({
        x: (width / (state.chartData.length - 1)) * index,
        y: height - (value / maxValue) * height
      }));

      // Draw filled area
      state.responseChart.beginPath();
      
      if (points.length > 0) {
        state.responseChart.moveTo(points[0].x, points[0].y);

        for (let i = 0; i < points.length - 1; i++) {
          const xMid = (points[i].x + points[i + 1].x) / 2;
          const yMid = (points[i].y + points[i + 1].y) / 2;
          state.responseChart.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
        }

        if (points.length > 1) {
          const lastPoint = points[points.length - 1];
          const secondLastPoint = points[points.length - 2];
          state.responseChart.quadraticCurveTo(secondLastPoint.x, secondLastPoint.y, lastPoint.x, lastPoint.y);
        }
      }

      state.responseChart.lineTo(width, height);
      state.responseChart.lineTo(0, height);
      state.responseChart.closePath();
      state.responseChart.fillStyle = gradient;
      state.responseChart.fill();

      // Draw line
      state.responseChart.beginPath();
      
      if (points.length > 0) {
        state.responseChart.moveTo(points[0].x, points[0].y);

        for (let i = 0; i < points.length - 1; i++) {
          const xMid = (points[i].x + points[i + 1].x) / 2;
          const yMid = (points[i].y + points[i + 1].y) / 2;
          state.responseChart.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
        }

        if (points.length > 1) {
          const lastPoint = points[points.length - 1];
          const secondLastPoint = points[points.length - 2];
          state.responseChart.quadraticCurveTo(secondLastPoint.x, secondLastPoint.y, lastPoint.x, lastPoint.y);
        }
      }
      
      state.responseChart.stroke();
    }

    // Draw labels
    state.responseChart.fillStyle = textColor;
    state.responseChart.font = '10px Inter, sans-serif';
    state.responseChart.fillText(`${maxValue.toFixed(0)}ms`, 4, 10);
    state.responseChart.fillText('0ms', 4, height - 2);
  } catch (error) {
    console.error('Error drawing chart:', error);
  }
}

// ============================================================================
// THEME & SIDEBAR CONTROLS
// ============================================================================

function toggleTheme() {
  state.isDarkMode = !state.isDarkMode;
  const themeIcon = document.getElementById('theme-icon');

  if (state.isDarkMode) {
    if (themeIcon) themeIcon.textContent = '☀️';
    document.body.classList.remove('light-mode');

    if (state.map && state.map.isStyleLoaded()) {
      applyDarkMode();
    } else if (state.map) {
      state.map.once('load', applyDarkMode);
    }
  } else {
    if (themeIcon) themeIcon.textContent = '🌙';
    document.body.classList.add('light-mode');

    if (state.map) {
      const currentCenter = state.map.getCenter();
      const currentZoom = state.map.getZoom();

      state.map.setStyle('https://demotiles.maplibre.org/style.json');

      state.map.once('styledata', () => {
        state.map.setCenter(currentCenter);
        state.map.setZoom(currentZoom);
      });
    }
  }

  drawResponseChart();
}

function toggleSidebarPosition() {
  state.isSidebarRight = !state.isSidebarRight;
  
  if (state.isSidebarRight) {
    document.body.classList.add('sidebar-right');
  } else {
    document.body.classList.remove('sidebar-right');
  }
  
  if (state.navigationControl && state.map) {
    state.map.removeControl(state.navigationControl);
    const newPosition = state.isSidebarRight ? 'bottom-left' : 'bottom-right';
    state.map.addControl(state.navigationControl, newPosition);
  }
  
  savePreference('sidebarPosition', state.isSidebarRight ? 'right' : 'left');
}

function toggleSidebarVisibility() {
  const isHidden = document.body.classList.toggle('sidebar-hidden');
  savePreference('sidebarHidden', isHidden ? 'true' : 'false');
}

function applyDarkMode() {
  if (!state.map || !state.map.isStyleLoaded()) {
    if (state.map) {
      state.map.once('styledata', applyDarkMode);
    }
    return;
  }

  try {
    const layers = state.map.getStyle().layers;

    layers.forEach(layer => {
      try {
        if (layer.type === 'background') {
          state.map.setPaintProperty(layer.id, 'background-color', '#0a0e27');
        } else if (layer.type === 'fill') {
          if (layer.id.includes('water') || layer['source-layer'] === 'water') {
            state.map.setPaintProperty(layer.id, 'fill-color', '#0F1824');
            state.map.setPaintProperty(layer.id, 'fill-opacity', 0.8);
          } else {
            state.map.setPaintProperty(layer.id, 'fill-color', '#1A2333');
            state.map.setPaintProperty(layer.id, 'fill-outline-color', '#2D3748');
            state.map.setPaintProperty(layer.id, 'fill-opacity', 0.7);
          }
        } else if (layer.type === 'line') {
          if (layer.id.includes('boundary') || layer.id.includes('admin')) {
            state.map.setPaintProperty(layer.id, 'line-color', '#374151');
            state.map.setPaintProperty(layer.id, 'line-blur', 1.5);
            state.map.setPaintProperty(layer.id, 'line-opacity', 0.3);
            state.map.setPaintProperty(layer.id, 'line-width', 0.8);
          } else {
            state.map.setPaintProperty(layer.id, 'line-color', '#1F2937');
            state.map.setPaintProperty(layer.id, 'line-opacity', 0.1);
          }
        } else if (layer.type === 'symbol' && layer.layout?.['text-field']) {
          state.map.setPaintProperty(layer.id, 'text-color', '#546E7A');
          state.map.setPaintProperty(layer.id, 'text-halo-color', '#0a0e27');
          state.map.setPaintProperty(layer.id, 'text-halo-width', 2);
          state.map.setPaintProperty(layer.id, 'text-halo-blur', 1);
          state.map.setPaintProperty(layer.id, 'text-opacity', 0.4);
        }
      } catch (error) {
        // Skip layers that don't support certain properties
      }
    });
  } catch (error) {
    console.error('Error applying dark mode:', error);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getColorForDNSType(type) {
  return DNS_TYPE_COLORS[type] || DNS_TYPE_COLORS.A;
}

function sanitizeString(str) {
  if (typeof str !== 'string') return '';
  return str.trim();
}

function sanitizeHTML(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.warn('Failed to save preference:', error);
  }
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'none';
  }
}

function showError(message) {
  console.error('Application error:', message);
  
  // Show error in UI
  addLogEntry({
    domain: 'Application Error',
    details: message,
    isError: true
  });
}

function handleVisibilityChange() {
  if (document.hidden) {
    // Page is hidden, could reduce update frequency
    console.log('Page hidden');
  } else {
    // Page is visible, resume normal operation
    console.log('Page visible');
  }
}

function cleanup() {
  // Clean up resources before page unload
  if (state.ws) {
    state.ws.close(1000, 'Page unload');
  }
  
  if (state.reconnectTimeoutId) {
    clearTimeout(state.reconnectTimeoutId);
  }
  
  if (state.chartUpdateTimeoutId) {
    clearTimeout(state.chartUpdateTimeoutId);
  }
  
  if (state.statsUpdateIntervalId) {
    clearInterval(state.statsUpdateIntervalId);
  }
}

// ============================================================================
// ERROR BOUNDARY
// ============================================================================

window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  showError('An unexpected error occurred.');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  showError('An unexpected error occurred.');
});
