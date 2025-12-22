const CONFIG = {
  MAX_CONCURRENT_ARCS: 100,
  MAX_LOG_ENTRIES: 15,
  MAX_CONCURRENT_LABELS: 12,
  MAX_LABEL_QUEUE_SIZE: 50,
  ARC_ANIMATION_DURATION: 1500,
  LABEL_LIFETIME: 5000,
  LABEL_LIFETIME_MIN: 3000,
  LABEL_PADDING: 15,
  LABEL_SEARCH_RADIUS: 200,
  LABEL_ANGLE_STEPS: 16,
  LABEL_QUEUE_ENABLED: true,
  LABEL_PRIORITY_BLOCKED: true,
  ARC_TRAIL_COUNT: 3,
  ARC_TRAIL_LIFETIME: 2000,
  RECONNECT_BASE_DELAY: 1000,
  RECONNECT_MAX_DELAY: 30000,
  RECONNECT_MAX_ATTEMPTS: 10,
  SOURCE_PULSE_THROTTLE: 100,
  DESTINATION_GLOW_DURATION: 1500
};

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

const state = {
  map: null,
  ws: null,
  isDarkMode: true,
  isSidebarRight: false,
  navigationControl: null,
  activeArcs: [],
  activeLabelBounds: [],
  activeLabels: 0,
  labelQueue: [],
  totalQueries: 0,
  blockedQueries: 0,
  responseTimes: [],
  upstreamTimes: [],
  logEntries: [],
  sourcePulseActive: false,
  reconnectAttempts: 0,
  reconnectTimeoutId: null,
  statsUpdateIntervalId: null,
  filterLocal: false,
  sourceLocation: { lat: 3.139, lng: 101.6869, city: 'Kuala Lumpur' },
  sourceMarker: null
};

document.addEventListener('DOMContentLoaded', () => {
  try {
    initApp();
  } catch (error) {
    console.error('Failed to initialize application:', error);
    showError('Application initialization failed. Please refresh the page.');
  }
});

function initApp() {
  loadPreferences();
  initMap();
  connectWebSocket();
  setupEventListeners();
  state.statsUpdateIntervalId = setInterval(updateStats, 1000);
}

function setupEventListeners() {
  const themeToggle = document.getElementById('theme-toggle');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarHideToggle = document.getElementById('sidebar-hide-toggle');
  const sourceLocationToggle = document.getElementById('source-location-toggle');
  const layoutToggle = document.getElementById('layout-toggle');

  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
  if (sidebarToggle) sidebarToggle.addEventListener('click', toggleSidebarPosition);
  if (sidebarHideToggle) sidebarHideToggle.addEventListener('click', toggleSidebarVisibility);
  if (sourceLocationToggle) sourceLocationToggle.addEventListener('click', openSourceLocationModal);
  if (layoutToggle) layoutToggle.addEventListener('click', openLayoutModal);

  const filterLocalToggle = document.getElementById('filter-local-toggle');
  if (filterLocalToggle) {
    filterLocalToggle.addEventListener('change', (e) => {
      state.filterLocal = e.target.checked;
      savePreference('filterLocal', state.filterLocal);
    });
  }

  setupModalEventListeners();

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

    const savedFilterLocal = localStorage.getItem('filterLocal');
    if (savedFilterLocal === 'true') {
      state.filterLocal = true;
      const toggle = document.getElementById('filter-local-toggle');
      if (toggle) toggle.checked = true;
    }

    const savedLayout = localStorage.getItem('dashboardLayout');
    if (savedLayout) {
      applyLayout(savedLayout);
    }

    const savedSourceLocation = localStorage.getItem('sourceLocation');
    if (savedSourceLocation) {
      try {
        state.sourceLocation = JSON.parse(savedSourceLocation);
      } catch (e) {
        console.warn('Failed to parse saved source location:', e);
      }
    }
  } catch (error) {
    console.warn('Failed to load preferences from localStorage:', error);
  }
}

function initMap() {
  state.map = new maplibregl.Map({
    container: 'map',
    style: 'https://demotiles.maplibre.org/style.json',
    center: [0, 20],
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
          coordinates: [state.sourceLocation.lng, state.sourceLocation.lat]
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
    try {
      if (!state.map || !state.map.getLayer('pulse-layer')) return;

      pulsePhase += 0.02;
      const scale = 1 + Math.sin(pulsePhase) * 0.5;
      const opacity = 0.8 - Math.abs(Math.sin(pulsePhase)) * 0.6;

      state.map.setPaintProperty('pulse-layer', 'circle-radius', 20 * scale);
      state.map.setPaintProperty('pulse-layer', 'circle-opacity', opacity);

      requestAnimationFrame(animate);
    } catch (error) {
      console.error('Pulse animation error:', error);
      // Animation stops on error - prevents infinite error loops
    }
  }

  animate();
}

function addSourceMarker() {
  if (state.sourceMarker) {
    state.sourceMarker.remove();
  }

  state.sourceMarker = new maplibregl.Marker({ color: '#f6ad55' })
    .setLngLat([state.sourceLocation.lng, state.sourceLocation.lat])
    .setPopup(new maplibregl.Popup().setText(`DNS Source: ${state.sourceLocation.city}`))
    .addTo(state.map);
}

function addNavigationControls() {
  state.navigationControl = new maplibregl.NavigationControl();
  const position = state.isSidebarRight ? 'bottom-left' : 'bottom-right';
  state.map.addControl(state.navigationControl, position);
}

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

  if (event.code !== 1000) {
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
      addLogEntry({ domain: 'System Error', details: data.message, isError: true });
      break;
    default:
      console.warn('Unknown message type:', data.type);
  }
}

function handleStats(event) {
  const statAdguardAvg = document.getElementById('stat-adguard-avg');

  if (statAdguardAvg && typeof event.data?.avgProcessingTime === 'number') {
    const avgTime = event.data.avgProcessingTime.toFixed(2);
    animateStat(statAdguardAvg, `${avgTime}ms`);
  }
}

function handleDNSQuery(event) {
  if (!event.data || !event.source) {
    console.warn('Invalid DNS query event:', event);
    return;
  }

  if (state.filterLocal && event.data.domain && event.data.domain.toLowerCase().endsWith('.local')) {
    return;
  }

  state.totalQueries++;
  if (event.data.filtered) state.blockedQueries++;
  updateStats();

  addLogEntry({
    domain: sanitizeString(event.data.domain),
    ip: sanitizeString(event.data.ip) || 'No answer',
    clientIp: sanitizeString(event.data.clientIp),
    type: sanitizeString(event.data.queryType),
    elapsed: parseFloat(event.data.elapsed) || 0,
    cached: event.data.cached || false,
    filtered: event.data.filtered || false,
    timestamp: new Date(event.timestamp)
  });

  if (event.destination && state.activeArcs.length < CONFIG.MAX_CONCURRENT_ARCS) {
    createArc(event.source, event.destination, event.data);
  }

  const elapsed = parseFloat(event.data.elapsed);
  if (!isNaN(elapsed) && elapsed > 0) {
    state.responseTimes.push(elapsed);
    if (state.responseTimes.length > 100) state.responseTimes.shift();
  }

  const upstreamElapsed = parseFloat(event.data.upstream);
  if (!isNaN(upstreamElapsed) && upstreamElapsed > 0) {
    state.upstreamTimes.push(upstreamElapsed);
    if (state.upstreamTimes.length > 100) state.upstreamTimes.shift();
  }
}

function createArc(_source, destination, data) {
  const arcId = `arc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  state.activeArcs.push(arcId);

  const arcColor = getColorForDNSType(data.queryType || data.type);

  triggerSourcePulse();

  // Use the custom source location from state instead of the server-provided source
  const lineString = createArcGeometry(
    [state.sourceLocation.lng, state.sourceLocation.lat],
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
        'line-width': state.isDarkMode ? 2 : 3,
        'line-opacity': state.isDarkMode ? 0.8 : 0.9,
        'line-blur': state.isDarkMode ? 0 : 0.5
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

  // Calculate distance for arc height
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Subtle arc height - just a gentle curve
  const arcHeight = distance * 0.15;

  // Generate path with subtle curve
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Linear interpolation for base position
    const lng = start[0] + (end[0] - start[0]) * t;
    const lat = start[1] + (end[1] - start[1]) * t;

    // Add subtle parabolic arc height (peaks at midpoint)
    const height = Math.sin(t * Math.PI) * arcHeight;

    coordinates.push([lng, lat + height]);
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
    try {
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
      console.error('Arc animation error:', error);
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
            'line-width': state.isDarkMode ? 1.5 : 2.5,
            'line-opacity': state.isDarkMode ? opacity : opacity * 1.2,
            'line-blur': state.isDarkMode ? 0 : 0.5
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
    try {
      currentFade++;
      const opacity = initialOpacity * (1 - currentFade / fadeSteps);

      if (state.map.getLayer(trailId)) {
        state.map.setPaintProperty(trailId, 'line-opacity', opacity);
      } else {
        clearInterval(fade);
      }

      if (currentFade >= fadeSteps) {
        clearInterval(fade);
      }
    } catch (error) {
      console.error('Trail fade animation error:', error);
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
    try {
      currentStep++;
      const progress = currentStep / steps;
      const scale = 1 + (progress * 2);
      const opacity1 = 0.6 * (1 - progress);
      const opacity2 = 0.8 * (1 - progress);

      if (state.map.getLayer(layer1)) {
        state.map.setPaintProperty(layer1, 'circle-radius', 30 * scale);
        state.map.setPaintProperty(layer1, 'circle-opacity', opacity1);
      }

      if (state.map.getLayer(layer2)) {
        state.map.setPaintProperty(layer2, 'circle-radius', 15 * scale);
        state.map.setPaintProperty(layer2, 'circle-opacity', opacity2);
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
    } catch (error) {
      console.error('Glow animation error:', error);
      clearInterval(glowInterval);
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

function addArcLabel(destination, data) {
  if (CONFIG.LABEL_QUEUE_ENABLED && state.activeLabels >= CONFIG.MAX_CONCURRENT_LABELS) {
    queueLabel(destination, data);
    return;
  }

  try {
    const point = state.map.project([destination.lng, destination.lat]);

    const label = document.createElement('div');
    label.className = 'arc-label';
    label.style.opacity = '0';

    if (data.filtered) label.classList.add('arc-label-priority');

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

    const rect = label.getBoundingClientRect();
    const labelWidth = rect.width;
    const labelHeight = rect.height;

    const position = findNonOverlappingPosition(point.x, point.y, labelWidth, labelHeight);

    if (!position && CONFIG.LABEL_QUEUE_ENABLED) {
      label.remove();
      queueLabel(destination, data);
      return;
    }

    label.style.left = `${position.x}px`;
    label.style.top = `${position.y}px`;
    label.style.opacity = '1';

    state.activeLabels++;

    const distance = Math.sqrt(
      Math.pow(position.x - point.x, 2) +
      Math.pow(position.y - point.y, 2)
    );

    let connector = null;
    if (distance > 50) {
      connector = createLabelConnector(
        point.x,
        point.y,
        position.x + labelWidth / 2,
        position.y + labelHeight / 2
      );
    }

    const bounds = {
      left: position.x,
      top: position.y,
      right: position.x + labelWidth,
      bottom: position.y + labelHeight,
      timestamp: Date.now()
    };
    state.activeLabelBounds.push(bounds);

    const lifetime = calculateAdaptiveLifetime();

    setTimeout(() => {
      if (label.parentNode) label.remove();
      if (connector && connector.parentNode) connector.remove();

      const index = state.activeLabelBounds.indexOf(bounds);
      if (index > -1) state.activeLabelBounds.splice(index, 1);

      state.activeLabels--;

      if (CONFIG.LABEL_QUEUE_ENABLED) processLabelQueue();
    }, lifetime);

    cleanupExpiredLabelBounds();
  } catch (error) {
    console.error('Error adding label:', error);
  }
}

function findNonOverlappingPosition(x, y, width, height) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const padding = CONFIG.LABEL_PADDING;

  const priorityOffsets = [
    { dx: 0, dy: -30 },
    { dx: 0, dy: 30 },
    { dx: -25, dy: -25 },
    { dx: 25, dy: -25 },
    { dx: -30, dy: 0 },
    { dx: 30, dy: 0 },
  ];

  for (const offset of priorityOffsets) {
    const testX = x + offset.dx;
    const testY = y + offset.dy;

    const testBounds = {
      left: testX,
      top: testY,
      right: testX + width,
      bottom: testY + height
    };

    if (isValidPosition(testBounds, viewportWidth, viewportHeight) && !hasCollision(testBounds)) {
      return { x: testX, y: testY };
    }
  }

  const angleSteps = CONFIG.LABEL_ANGLE_STEPS;
  const maxRadius = CONFIG.LABEL_SEARCH_RADIUS;
  const radiusSteps = 6;

  for (let r = 1; r <= radiusSteps; r++) {
    const radius = (maxRadius / radiusSteps) * r;

    for (let a = 0; a < angleSteps; a++) {
      const angle = (Math.PI * 2 * a) / angleSteps;
      const testX = x + Math.cos(angle) * radius;
      const testY = y + Math.sin(angle) * radius;

      const testBounds = {
        left: testX,
        top: testY,
        right: testX + width,
        bottom: testY + height
      };

      if (isValidPosition(testBounds, viewportWidth, viewportHeight) && !hasCollision(testBounds)) {
        return { x: testX, y: testY };
      }
    }
  }

  const gridStep = 40;
  const gridRange = 3;

  for (let gx = -gridRange; gx <= gridRange; gx++) {
    for (let gy = -gridRange; gy <= gridRange; gy++) {
      if (gx === 0 && gy === 0) continue;

      const testX = x + gx * gridStep;
      const testY = y + gy * gridStep;

      const testBounds = {
        left: testX,
        top: testY,
        right: testX + width,
        bottom: testY + height
      };

      if (isValidPosition(testBounds, viewportWidth, viewportHeight) && !hasCollision(testBounds)) {
        return { x: testX, y: testY };
      }
    }
  }

  if (!CONFIG.LABEL_QUEUE_ENABLED) {
    return { x: x, y: y - 30 }; // Simplified fallback
  }

  return null;
}

function isValidPosition(bounds, viewportWidth, viewportHeight) {
  const margin = 10;
  return (
    bounds.left >= margin &&
    bounds.right <= viewportWidth - margin &&
    bounds.top >= margin &&
    bounds.bottom <= viewportHeight - margin
  );
}

function hasCollision(bounds) {
  const padding = CONFIG.LABEL_PADDING;

  for (const existingBounds of state.activeLabelBounds) {
    if (
      bounds.left - padding < existingBounds.right + padding &&
      bounds.right + padding > existingBounds.left - padding &&
      bounds.top - padding < existingBounds.bottom + padding &&
      bounds.bottom + padding > existingBounds.top - padding
    ) {
      return true;
    }
  }

  return false;
}

function createLabelConnector(x1, y1, x2, y2) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.pointerEvents = 'none';
  svg.style.zIndex = '4';
  svg.classList.add('label-connector');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
  line.setAttribute('stroke', state.isDarkMode ? 'rgba(246, 173, 85, 0.3)' : 'rgba(99, 102, 241, 0.3)');
  line.setAttribute('stroke-width', '1');
  line.setAttribute('stroke-dasharray', '3,3');

  svg.appendChild(line);
  document.body.appendChild(svg);

  return svg;
}

function cleanupExpiredLabelBounds() {
  const now = Date.now();
  const maxAge = CONFIG.LABEL_LIFETIME + 1000;

  state.activeLabelBounds = state.activeLabelBounds.filter(
    bounds => now - bounds.timestamp < maxAge
  );
}

function addLogEntry(entry) {
  try {
    const container = document.getElementById('log-container');
    if (!container) return;

    const logDiv = document.createElement('div');
    const isBlocked = entry.filtered === true;
    const isNoAnswer = entry.ip === 'No Answer';

    if (isBlocked) {
      logDiv.className = 'log-entry blocked';
    } else if (isNoAnswer) {
      logDiv.className = 'log-entry no-answer';
    } else {
      logDiv.className = 'log-entry';
    }

    const time = entry.timestamp ? entry.timestamp.toLocaleTimeString() : new Date().toLocaleTimeString();
    const domain = sanitizeHTML(entry.domain || 'Unknown');
    const ip = entry.ip ? sanitizeHTML(entry.ip) : '';
    const clientIp = entry.clientIp ? sanitizeHTML(entry.clientIp) : '';
    const type = sanitizeHTML(entry.type || 'A');
    const elapsed = entry.elapsed ? `${entry.elapsed}ms` : '';
    const cached = entry.cached ? ' • Cached' : '';
    const blocked = isBlocked ? ' • <span class="log-blocked">BLOCKED</span>' : '';
    const noAnswer = isNoAnswer ? ' • <span class="log-no-answer">NO ANSWER</span>' : '';
    const cnameInfo = entry.cname ? ` • <span class="log-cname" title="Resolved from CNAME: ${sanitizeHTML(entry.cname)}">CNAME</span>` : '';
    const details = entry.details ? sanitizeHTML(entry.details) : '';

    logDiv.innerHTML = `
      <div class="log-time">${time}${clientIp ? ` • <span class="log-client">${clientIp}</span>` : ''}</div>
      <div class="log-domain">${domain}${cnameInfo}</div>
      <div class="log-details">
        ${ip ? `<span class="log-ip">${ip}</span> • ` : ''}
        ${type}${elapsed ? ` • ${elapsed}` : ''}${cached}${blocked}${noAnswer}
        ${details ? ` • ${details}` : ''}
      </div>
    `;

    container.insertBefore(logDiv, container.firstChild);
    state.logEntries.push(logDiv);

    setTimeout(() => {
      if (logDiv.parentNode) logDiv.remove();
    }, 5000);

    while (state.logEntries.length > CONFIG.MAX_LOG_ENTRIES) {
      const oldEntry = state.logEntries.shift();
      if (oldEntry && oldEntry.parentNode) oldEntry.remove();
    }
  } catch (error) {
    console.error('Error adding log entry:', error);
  }
}

function updateStatus(status, text) {
  try {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    const indicatorTop = document.getElementById('status-indicator-top');
    const statusTextTop = document.getElementById('status-text-top');

    if (indicator) {
      indicator.className = `status-indicator ${status === 'disconnected' ? 'disconnected' : ''}`;
    }

    if (indicatorTop) {
      indicatorTop.className = `status-indicator ${status === 'disconnected' ? 'disconnected' : ''}`;
    }

    if (statusText) {
      statusText.textContent = sanitizeString(text);
    }

    if (statusTextTop) {
      statusTextTop.textContent = sanitizeString(text);
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
    const statUpstreamAvg = document.getElementById('stat-upstream-avg');

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

    if (state.upstreamTimes.length > 0) {
      const sum = state.upstreamTimes.reduce((a, b) => a + b, 0);
      const avg = sum / state.upstreamTimes.length;

      if (!isNaN(avg) && isFinite(avg)) {
        animateStat(statUpstreamAvg, `${avg.toFixed(1)}ms`);
      } else {
        animateStat(statUpstreamAvg, '0ms');
      }
    } else {
      animateStat(statUpstreamAvg, '0ms');
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

  savePreference('theme', state.isDarkMode ? 'dark' : 'light');
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
      } catch (error) { }
    });
  } catch (error) {
    console.error('Error applying dark mode:', error);
  }
}

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
  addLogEntry({
    domain: 'Application Error',
    details: message,
    isError: true
  });
}

function cleanup() {
  if (state.ws) {
    state.ws.close(1000, 'Page unload');
  }

  if (state.reconnectTimeoutId) {
    clearTimeout(state.reconnectTimeoutId);
  }

  if (state.statsUpdateIntervalId) {
    clearInterval(state.statsUpdateIntervalId);
  }

  if (state.chartAnimationFrameId) {
    cancelAnimationFrame(state.chartAnimationFrameId);
  }
}

window.addEventListener('error', (event) => {
  console.error('Global error:', event.error);
  showError('An unexpected error occurred.');
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  showError('An unexpected error occurred.');
});

function queueLabel(destination, data) {
  // Prevent queue from growing unbounded
  if (state.labelQueue.length >= CONFIG.MAX_LABEL_QUEUE_SIZE) {
    // Try to remove low-priority items first, otherwise remove oldest
    const lowPriorityIndex = state.labelQueue.findIndex(item => item.priority === 0);
    if (lowPriorityIndex !== -1) {
      state.labelQueue.splice(lowPriorityIndex, 1);
    } else {
      state.labelQueue.shift();
    }
  }

  const priority = (CONFIG.LABEL_PRIORITY_BLOCKED && data.filtered) ? 1 : 0;

  state.labelQueue.push({
    destination,
    data,
    priority,
    timestamp: Date.now()
  });
}

function processLabelQueue() {
  if (state.labelQueue.length === 0) return;
  if (state.activeLabels >= CONFIG.MAX_CONCURRENT_LABELS) return;

  state.labelQueue.sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return a.timestamp - b.timestamp;
  });

  const nextLabel = state.labelQueue.shift();
  if (nextLabel) {
    addArcLabel(nextLabel.destination, nextLabel.data);
  }
}

function calculateAdaptiveLifetime() {
  const congestionRatio = state.activeLabels / CONFIG.MAX_CONCURRENT_LABELS;

  if (congestionRatio > 0.8) {
    return CONFIG.LABEL_LIFETIME_MIN;
  } else if (congestionRatio > 0.5) {
    const range = CONFIG.LABEL_LIFETIME - CONFIG.LABEL_LIFETIME_MIN;
    return CONFIG.LABEL_LIFETIME_MIN + (range * (1 - congestionRatio) * 2);
  } else {
    return CONFIG.LABEL_LIFETIME;
  }
}

// Modal Functions
function setupModalEventListeners() {
  const sourceLocationModal = document.getElementById('source-location-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalBackdrop = sourceLocationModal?.querySelector('.modal-backdrop');
  const saveSourceBtn = document.getElementById('save-source-btn');
  const resetSourceBtn = document.getElementById('reset-source-btn');

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeSourceLocationModal);
  }

  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeSourceLocationModal);
  }

  if (saveSourceBtn) {
    saveSourceBtn.addEventListener('click', saveSourceLocation);
  }

  if (resetSourceBtn) {
    resetSourceBtn.addEventListener('click', resetSourceLocation);
  }


  // Populate city presets
  populateCityPresets();

  // Handle city preset selection
  const cityPreset = document.getElementById('city-preset');
  if (cityPreset) {
    cityPreset.addEventListener('change', handleCityPresetChange);
  }

  // Handle coordinate input validation
  const sourceLat = document.getElementById('source-lat');
  const sourceLng = document.getElementById('source-lng');
  if (sourceLat) sourceLat.addEventListener('input', validateCoordinates);
  if (sourceLng) sourceLng.addEventListener('input', validateCoordinates);
}

function openSourceLocationModal() {
  const modal = document.getElementById('source-location-modal');
  if (modal) {
    modal.classList.add('active');
    // Load current values
    loadCurrentSourceLocation();
  }
}

function closeSourceLocationModal() {
  const modal = document.getElementById('source-location-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function openLayoutModal() {
  cycleLayout();
}

function populateCityPresets() {
  const cityPreset = document.getElementById('city-preset');
  if (!cityPreset) return;

  const cities = [
    { name: 'Kuala Lumpur, Malaysia', lat: 3.139, lng: 101.6869 },
    { name: 'New York, USA', lat: 40.7128, lng: -74.0060 },
    { name: 'London, UK', lat: 51.5074, lng: -0.1278 },
    { name: 'Tokyo, Japan', lat: 35.6762, lng: 139.6503 },
    { name: 'Singapore', lat: 1.3521, lng: 103.8198 },
    { name: 'Sydney, Australia', lat: -33.8688, lng: 151.2093 },
    { name: 'Paris, France', lat: 48.8566, lng: 2.3522 },
    { name: 'Berlin, Germany', lat: 52.5200, lng: 13.4050 },
    { name: 'Dubai, UAE', lat: 25.2048, lng: 55.2708 },
    { name: 'Hong Kong', lat: 22.3193, lng: 114.1694 },
    { name: 'San Francisco, USA', lat: 37.7749, lng: -122.4194 },
    { name: 'Toronto, Canada', lat: 43.6532, lng: -79.3832 }
  ];

  cities.forEach(city => {
    const option = document.createElement('option');
    option.value = JSON.stringify({ lat: city.lat, lng: city.lng, name: city.name });
    option.textContent = city.name;
    cityPreset.appendChild(option);
  });
}

function handleCityPresetChange(e) {
  if (!e.target.value) return;

  try {
    const city = JSON.parse(e.target.value);
    const sourceLat = document.getElementById('source-lat');
    const sourceLng = document.getElementById('source-lng');
    const sourceCity = document.getElementById('source-city');

    if (sourceLat) sourceLat.value = city.lat;
    if (sourceLng) sourceLng.value = city.lng;
    if (sourceCity) sourceCity.value = city.name;

    validateCoordinates();
  } catch (error) {
    console.error('Error parsing city preset:', error);
  }
}

function validateCoordinates() {
  const sourceLat = document.getElementById('source-lat');
  const sourceLng = document.getElementById('source-lng');
  const validationMessage = document.getElementById('validation-message');

  if (!sourceLat || !sourceLng || !validationMessage) return;

  const lat = parseFloat(sourceLat.value);
  const lng = parseFloat(sourceLng.value);

  if (isNaN(lat) || isNaN(lng)) {
    validationMessage.textContent = '';
    validationMessage.style.color = '';
    return;
  }

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    validationMessage.textContent = '⚠️ Invalid coordinates. Lat: -90 to 90, Lng: -180 to 180';
    validationMessage.style.color = '#f87171';
  } else {
    validationMessage.textContent = '✓ Valid coordinates';
    validationMessage.style.color = '#34d399';
  }
}

function loadCurrentSourceLocation() {
  const sourceLat = document.getElementById('source-lat');
  const sourceLng = document.getElementById('source-lng');
  const sourceCity = document.getElementById('source-city');

  if (sourceLat) sourceLat.value = state.sourceLocation.lat;
  if (sourceLng) sourceLng.value = state.sourceLocation.lng;
  if (sourceCity) sourceCity.value = state.sourceLocation.city;
}

function saveSourceLocation() {
  const sourceLat = document.getElementById('source-lat');
  const sourceLng = document.getElementById('source-lng');
  const sourceCity = document.getElementById('source-city');

  if (!sourceLat || !sourceLng) return;

  const lat = parseFloat(sourceLat.value);
  const lng = parseFloat(sourceLng.value);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    alert('Please enter valid coordinates');
    return;
  }

  // Update state
  state.sourceLocation = {
    lat,
    lng,
    city: sourceCity?.value || 'Custom Location'
  };

  // Save to localStorage
  localStorage.setItem('sourceLocation', JSON.stringify(state.sourceLocation));

  // Update the map immediately
  updateSourceLocationOnMap();

  closeSourceLocationModal();
}

function resetSourceLocation() {
  state.sourceLocation = { lat: 3.139, lng: 101.6869, city: 'Kuala Lumpur' };
  localStorage.removeItem('sourceLocation');
  loadCurrentSourceLocation();
  updateSourceLocationOnMap();
}

function updateSourceLocationOnMap() {
  if (!state.map) return;

  // Update pulse source
  const pulseSource = state.map.getSource('pulse-source');
  if (pulseSource) {
    pulseSource.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [state.sourceLocation.lng, state.sourceLocation.lat]
        }
      }]
    });
  }

  // Update marker
  if (state.sourceMarker) {
    state.sourceMarker.setLngLat([state.sourceLocation.lng, state.sourceLocation.lat]);
    state.sourceMarker.setPopup(new maplibregl.Popup().setText(`DNS Source: ${state.sourceLocation.city}`));
  }

  // Optionally pan to the new location
  state.map.flyTo({
    center: [state.sourceLocation.lng, state.sourceLocation.lat],
    zoom: Math.max(state.map.getZoom(), 4),
    duration: 2000
  });
}

function cycleLayout() {
  const layouts = ['full', 'minimal', 'compact'];
  const currentLayout = localStorage.getItem('dashboardLayout') || 'full';
  const currentIndex = layouts.indexOf(currentLayout);
  const nextIndex = (currentIndex + 1) % layouts.length;
  const nextLayout = layouts[nextIndex];

  localStorage.setItem('dashboardLayout', nextLayout);
  applyLayout(nextLayout);

  // Show a brief notification
  showLayoutNotification(nextLayout);
}

function showLayoutNotification(layout) {
  const layoutNames = {
    full: 'Full Layout',
    minimal: 'Minimal Layout',
    compact: 'Compact Layout'
  };

  // Create notification element if it doesn't exist
  let notification = document.getElementById('layout-notification');
  if (!notification) {
    notification = document.createElement('div');
    notification.id = 'layout-notification';
    notification.className = 'layout-notification';
    document.body.appendChild(notification);
  }

  notification.textContent = layoutNames[layout];
  notification.classList.add('show');

  // Remove after 2 seconds
  setTimeout(() => {
    notification.classList.remove('show');
  }, 2000);
}

function applyLayout(layout) {
  const sidebar = document.querySelector('.sidebar');

  if (!sidebar) return;

  // Remove all layout classes
  sidebar.classList.remove('layout-full', 'layout-minimal', 'layout-compact');

  // Add the selected layout class
  if (layout !== 'full') {
    sidebar.classList.add(`layout-${layout}`);
  }
}
