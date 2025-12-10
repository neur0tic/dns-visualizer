/**
 * DNS Visualization Dashboard - Client Application
 */

// Configuration
const MAX_CONCURRENT_ARCS = 100;
const MAX_LOG_ENTRIES = 15;
const ARC_ANIMATION_DURATION = 200; // ms
const LABEL_LIFETIME = 5000; // ms
const ARC_TRAIL_COUNT = 3; // Number of trail copies per arc
const ARC_TRAIL_LIFETIME = 2000; // ms - how long trails persist

// DNS Query Type Colors
const DNS_TYPE_COLORS = {
    'A': '#f6ad55',      // Orange - IPv4
    'AAAA': '#4299e1',   // Blue - IPv6
    'CNAME': '#48bb78',  // Green - Canonical name
    'MX': '#9f7aea',     // Purple - Mail exchange
    'TXT': '#ed8936',    // Dark orange - Text records
    'NS': '#38b2ac',     // Teal - Name server
    'SOA': '#fc8181',    // Red - Start of authority
    'PTR': '#f687b3',    // Pink - Pointer
    'SRV': '#ecc94b',    // Yellow - Service
    'CAA': '#667eea'     // Indigo - Certificate authority
};

// State
let map;
let ws;
let isDarkMode = true;
let isSidebarRight = false;
let navigationControl = null;
let activeArcs = [];
let totalQueries = 0;
let blockedQueries = 0;
let responseTimes = [];
let logEntries = [];
let responseChart = null;
let chartData = [];
let sourcePulseActive = false;

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    connectWebSocket();
    initResponseChart();

    // Load saved sidebar position
    const savedPosition = localStorage.getItem('sidebarPosition');
    if (savedPosition === 'right') {
        isSidebarRight = true;
        document.body.classList.add('sidebar-right');
    }

    // Add theme toggle event listener
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', toggleTheme);
    }

    // Add sidebar position toggle event listener
    const sidebarToggle = document.getElementById('sidebar-toggle');
    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', toggleSidebarPosition);
    }

    // Add sidebar hide toggle event listener
    const sidebarHideToggle = document.getElementById('sidebar-hide-toggle');
    if (sidebarHideToggle) {
        sidebarHideToggle.addEventListener('click', toggleSidebarVisibility);
    }

    // Load saved sidebar visibility state
    const savedSidebarHidden = localStorage.getItem('sidebarHidden');
    if (savedSidebarHidden === 'true') {
        document.body.classList.add('sidebar-hidden');
    }
});

/**
 * Initialize MapLibre map
 */
function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://demotiles.maplibre.org/style.json',
        center: [101.6869, 3.139], // Kuala Lumpur
        zoom: 2,
        pitch: 0,
        bearing: 0
    });

    map.on('load', () => {
        applyDarkMode();
        document.getElementById('loading').style.display = 'none';

        // Add pulsing circle source data for Kuala Lumpur
        map.addSource('pulse-source', {
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

        // Add pulsing circle layer
        map.addLayer({
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

        // Animate the pulse
        let pulsePhase = 0;
        function animatePulse() {
            pulsePhase += 0.02;
            const scale = 1 + Math.sin(pulsePhase) * 0.5;
            const opacity = 0.8 - Math.abs(Math.sin(pulsePhase)) * 0.6;
            
            map.setPaintProperty('pulse-layer', 'circle-radius', 20 * scale);
            map.setPaintProperty('pulse-layer', 'circle-opacity', opacity);
            
            requestAnimationFrame(animatePulse);
        }
        animatePulse();

        // Add source marker for Kuala Lumpur
        new maplibregl.Marker({ color: '#f6ad55' })
            .setLngLat([101.6869, 3.139])
            .setPopup(new maplibregl.Popup().setText('DNS Source: Kuala Lumpur'))
            .addTo(map);
    });

    // Add navigation controls at bottom-right (or bottom-left if sidebar is on right)
    navigationControl = new maplibregl.NavigationControl();
    const controlPosition = isSidebarRight ? 'bottom-left' : 'bottom-right';
    map.addControl(navigationControl, controlPosition);
}

/**
 * Connect to WebSocket server
 */
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
        updateStatus('connected', 'Live');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('disconnected', 'Error');
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        updateStatus('disconnected', 'Disconnected');

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
            console.log('Attempting to reconnect...');
            connectWebSocket();
        }, 5000);
    };
}

/**
 * Handle incoming WebSocket message
 */
function handleMessage(data) {
    if (data.type === 'dns_query') {
        handleDNSQuery(data);
    } else if (data.type === 'stats') {
        handleStats(data);
    } else if (data.type === 'error') {
        console.error('Server error:', data.message);
        addLogEntry({
            domain: 'System Error',
            details: data.message,
            isError: true
        });
    }
}

/**
 * Handle AdGuard stats update
 */
function handleStats(event) {
    const statAdguardAvg = document.getElementById('stat-adguard-avg');
    if (statAdguardAvg && event.data.avgProcessingTime !== undefined) {
        const avgTime = event.data.avgProcessingTime.toFixed(2);
        if (statAdguardAvg.textContent !== `${avgTime}ms`) {
            statAdguardAvg.textContent = `${avgTime}ms`;
            statAdguardAvg.classList.add('updated');
            setTimeout(() => statAdguardAvg.classList.remove('updated'), 600);
        }
    }
}

/**
 * Handle DNS query event
 */
function handleDNSQuery(event) {
    totalQueries++;

    // Track blocked queries
    if (event.data.filtered) {
        blockedQueries++;
    }

    updateStats();

    // Add to log stream
    addLogEntry({
        domain: event.data.domain,
        ip: event.data.ip || 'No answer',
        clientIp: event.data.clientIp,
        type: event.data.queryType,
        elapsed: event.data.elapsed,
        cached: event.data.cached,
        filtered: event.data.filtered,
        timestamp: new Date(event.timestamp)
    });

    // Only create arc if we have a destination
    if (event.destination && activeArcs.length < MAX_CONCURRENT_ARCS) {
        createArc(event.source, event.destination, event.data);
    }

    // Track response times
    if (event.data.elapsed) {
        const elapsed = parseFloat(event.data.elapsed);
        if (!isNaN(elapsed) && elapsed > 0) {
            responseTimes.push(elapsed);
            if (responseTimes.length > 100) {
                responseTimes.shift();
            }
            // Update chart with new response time
            updateResponseChart(elapsed);
        }
    }
}

/**
 * Get color for DNS query type
 */
function getColorForDNSType(type) {
    return DNS_TYPE_COLORS[type] || '#f6ad55'; // Default to orange
}

/**
 * Create animated arc between source and destination
 */
function createArc(source, destination, data) {
    const arcId = `arc-${Date.now()}-${Math.random()}`;

    // Add arc to active list
    activeArcs.push(arcId);

    // Get color based on DNS query type
    const arcColor = getColorForDNSType(data.queryType || data.type);

    // Trigger source pulse when traffic originates
    triggerSourcePulse();

    // Create line geometry
    const lineString = createArcGeometry(
        [source.lng, source.lat],
        [destination.lng, destination.lat]
    );

    // Add source
    map.addSource(arcId, {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: lineString
        }
    });

    // Add layer
    map.addLayer({
        id: arcId,
        type: 'line',
        source: arcId,
        paint: {
            'line-color': arcColor,
            'line-width': 2,
            'line-opacity': 0.8
        }
    });

    // Animate the arc
    animateArc(arcId, lineString, destination, data, arcColor);
}

/**
 * Create arc geometry between two points
 */
function createArcGeometry(start, end) {
    const steps = 50;
    const coordinates = [];

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;

        // Linear interpolation
        const lng = start[0] + (end[0] - start[0]) * t;
        const lat = start[1] + (end[1] - start[1]) * t;

        // Add arc height
        const arcHeight = Math.sin(t * Math.PI) * 0.3;

        coordinates.push([lng, lat + arcHeight]);
    }

    return {
        type: 'LineString',
        coordinates: coordinates
    };
}

/**
 * Animate arc drawing and add label
 */
function animateArc(arcId, lineString, destination, data, arcColor) {
    const steps = lineString.coordinates.length;
    let currentStep = 0;
    let trailCreated = false;

    const interval = setInterval(() => {
        currentStep++;

        if (currentStep >= steps) {
            clearInterval(interval);

            // Add label at destination
            addArcLabel(destination, data);

            // Create glow effect at destination
            createDestinationGlow(destination, arcColor);

            // Create trail when arc completes
            if (!trailCreated) {
                createArcTrail(lineString, arcColor);
                trailCreated = true;
            }

            // Remove arc after animation
            setTimeout(() => {
                removeArc(arcId);
            }, 3000);

            return;
        }

        // Update line to show progressive drawing
        const currentCoordinates = lineString.coordinates.slice(0, currentStep);

        map.getSource(arcId).setData({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: currentCoordinates
            }
        });
    }, ARC_ANIMATION_DURATION / steps);
}

/**
 * Create fading trail copies of the arc
 */
function createArcTrail(lineString, arcColor) {
    for (let i = 0; i < ARC_TRAIL_COUNT; i++) {
        setTimeout(() => {
            const trailId = `trail-${Date.now()}-${Math.random()}`;
            const opacity = 0.6 - (i * 0.2); // Decreasing opacity for each trail
            
            // Add trail source
            map.addSource(trailId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: lineString
                }
            });

            // Add trail layer with reduced opacity
            map.addLayer({
                id: trailId,
                type: 'line',
                source: trailId,
                paint: {
                    'line-color': arcColor,
                    'line-width': 1.5,
                    'line-opacity': opacity
                }
            });

            // Animate trail fade out
            animateTrailFade(trailId, opacity);

            // Remove trail after lifetime
            setTimeout(() => {
                removeArc(trailId);
            }, ARC_TRAIL_LIFETIME);
        }, i * 150); // Stagger trail creation
    }
}

/**
 * Animate trail fading out
 */
function animateTrailFade(trailId, initialOpacity) {
    const fadeSteps = 20;
    const fadeInterval = ARC_TRAIL_LIFETIME / fadeSteps;
    let currentFade = 0;

    const fade = setInterval(() => {
        currentFade++;
        const opacity = initialOpacity * (1 - currentFade / fadeSteps);

        if (map.getLayer(trailId)) {
            map.setPaintProperty(trailId, 'line-opacity', opacity);
        }

        if (currentFade >= fadeSteps) {
            clearInterval(fade);
        }
    }, fadeInterval);
}

/**
 * Add label at arc destination
 */
function addArcLabel(destination, data) {
    const point = map.project([destination.lng, destination.lat]);

    const label = document.createElement('div');
    label.className = 'arc-label';
    label.style.left = `${point.x}px`;
    label.style.top = `${point.y - 20}px`;

    label.innerHTML = `
        <div class="label-domain">${data.domain || 'Unknown'}</div>
        <div class="label-detail">
            ${data.ip ? `<span class="label-ip">${data.ip}</span> • ` : ''}
            ${data.queryType || data.type || 'A'} • ${data.elapsed || 0}ms
            ${data.cached ? ' • Cached' : ''}
        </div>
        <div class="label-detail">${destination.city || 'Unknown'}, ${destination.country || 'Unknown'}</div>
    `;

    document.body.appendChild(label);

    // Remove label after timeout
    setTimeout(() => {
        label.remove();
    }, LABEL_LIFETIME);
}

/**
 * Remove arc from map
 */
function removeArc(arcId) {
    if (map.getLayer(arcId)) {
        map.removeLayer(arcId);
    }
    if (map.getSource(arcId)) {
        map.removeSource(arcId);
    }

    activeArcs = activeArcs.filter(id => id !== arcId);
}

/**
 * Add entry to log stream
 */
function addLogEntry(entry) {
    const container = document.getElementById('log-container');

    const logDiv = document.createElement('div');
    logDiv.className = entry.filtered ? 'log-entry blocked' : 'log-entry';

    const time = entry.timestamp ? entry.timestamp.toLocaleTimeString() : new Date().toLocaleTimeString();

    logDiv.innerHTML = `
        <div class="log-time">${time}${entry.clientIp ? ` • <span class="log-client">${entry.clientIp}</span>` : ''}</div>
        <div class="log-domain">${entry.domain || 'Unknown'}</div>
        <div class="log-details">
            ${entry.ip ? `<span class="log-ip">${entry.ip}</span> • ` : ''}
            ${entry.type || 'A'}${entry.elapsed ? ` • ${entry.elapsed}ms` : ''}
            ${entry.cached ? ' • Cached' : ''}
            ${entry.filtered ? ' • <span class="log-blocked">BLOCKED</span>' : ''}
            ${entry.details ? ` • ${entry.details}` : ''}
        </div>
    `;

    // Add to beginning of container
    container.insertBefore(logDiv, container.firstChild);

    logEntries.push(logDiv);

    // Auto-remove entry after animation completes (5 seconds total: 4.2s delay + 0.8s animation)
    setTimeout(() => {
        if (logDiv.parentNode) {
            logDiv.remove();
        }
    }, 5000);

    // Keep only MAX_LOG_ENTRIES in array
    if (logEntries.length > MAX_LOG_ENTRIES) {
        const oldEntry = logEntries.shift();
        if (oldEntry.parentNode) {
            oldEntry.remove();
        }
    }
}

/**
 * Update connection status
 */
function updateStatus(status, text) {
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    indicator.className = `status-indicator ${status === 'disconnected' ? 'disconnected' : ''}`;
    statusText.textContent = text;
}

/**
 * Initialize response time chart
 */
function initResponseChart() {
    const canvas = document.getElementById('response-chart');
    if (!canvas) return;

    responseChart = canvas.getContext('2d');
    
    // Enable anti-aliasing for smoother lines
    responseChart.imageSmoothingEnabled = true;
    responseChart.imageSmoothingQuality = 'high';

    // Initialize with empty data points
    for (let i = 0; i < 50; i++) {
        chartData.push(0);
    }

    drawResponseChart();
}

/**
 * Draw response time chart with smooth bezier curves
 */
function drawResponseChart() {
    if (!responseChart) return;

    const canvas = responseChart.canvas;
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    responseChart.clearRect(0, 0, width, height);

    // Get theme colors
    const lineColor = isDarkMode ? '#f6ad55' : '#4264fb';
    const gridColor = isDarkMode ? 'rgba(246, 173, 85, 0.1)' : 'rgba(0, 0, 0, 0.05)';
    const textColor = isDarkMode ? '#cbd5e0' : '#666';

    // Draw grid lines
    responseChart.strokeStyle = gridColor;
    responseChart.lineWidth = 1;

    for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        responseChart.beginPath();
        responseChart.moveTo(0, y);
        responseChart.lineTo(width, y);
        responseChart.stroke();
    }

    // Find max value for scaling
    const maxValue = Math.max(...chartData, 50); // Minimum scale of 50ms

    // Draw line chart with smooth curves
    if (chartData.length > 0) {
        responseChart.strokeStyle = lineColor;
        responseChart.lineWidth = 2.5;
        responseChart.lineCap = 'round';
        responseChart.lineJoin = 'round';

        // Draw gradient fill
        const gradient = responseChart.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, isDarkMode ? 'rgba(246, 173, 85, 0.2)' : 'rgba(66, 100, 251, 0.2)');
        gradient.addColorStop(1, isDarkMode ? 'rgba(246, 173, 85, 0)' : 'rgba(66, 100, 251, 0)');

        // Create smooth curve using quadratic bezier
        const points = chartData.map((value, index) => ({
            x: (width / (chartData.length - 1)) * index,
            y: height - (value / maxValue) * height
        }));

        responseChart.beginPath();
        
        if (points.length > 0) {
            responseChart.moveTo(points[0].x, points[0].y);

            // Use quadratic curves for smoothing
            for (let i = 0; i < points.length - 1; i++) {
                const xMid = (points[i].x + points[i + 1].x) / 2;
                const yMid = (points[i].y + points[i + 1].y) / 2;
                responseChart.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
            }

            // Draw last segment
            if (points.length > 1) {
                const lastPoint = points[points.length - 1];
                const secondLastPoint = points[points.length - 2];
                responseChart.quadraticCurveTo(secondLastPoint.x, secondLastPoint.y, lastPoint.x, lastPoint.y);
            }
        }

        // Fill area under line
        responseChart.lineTo(width, height);
        responseChart.lineTo(0, height);
        responseChart.closePath();
        responseChart.fillStyle = gradient;
        responseChart.fill();

        // Draw smooth line
        responseChart.beginPath();
        
        if (points.length > 0) {
            responseChart.moveTo(points[0].x, points[0].y);

            for (let i = 0; i < points.length - 1; i++) {
                const xMid = (points[i].x + points[i + 1].x) / 2;
                const yMid = (points[i].y + points[i + 1].y) / 2;
                responseChart.quadraticCurveTo(points[i].x, points[i].y, xMid, yMid);
            }

            if (points.length > 1) {
                const lastPoint = points[points.length - 1];
                const secondLastPoint = points[points.length - 2];
                responseChart.quadraticCurveTo(secondLastPoint.x, secondLastPoint.y, lastPoint.x, lastPoint.y);
            }
        }
        
        responseChart.stroke();
    }

    // Draw max value label
    responseChart.fillStyle = textColor;
    responseChart.font = '10px Inter, sans-serif';
    responseChart.fillText(`${maxValue.toFixed(0)}ms`, 4, 10);
    responseChart.fillText('0ms', 4, height - 2);
}

/**
 * Update chart with new response time (smooth animation)
 */
function updateResponseChart(responseTime) {
    chartData.push(responseTime);
    if (chartData.length > 50) {
        chartData.shift();
    }
    
    // Use requestAnimationFrame for smooth 60fps rendering
    requestAnimationFrame(() => {
        drawResponseChart();
    });
}

/**
 * Update statistics with smooth animations
 */
function updateStats() {
    const statActive = document.getElementById('stat-active');
    const statTotal = document.getElementById('stat-total');
    const statBlocked = document.getElementById('stat-blocked');
    const statAvg = document.getElementById('stat-avg');

    // Helper function to animate stat change
    const animateStat = (element, newValue) => {
        if (element.textContent !== newValue) {
            element.textContent = newValue;
            element.classList.add('updated');
            setTimeout(() => element.classList.remove('updated'), 600);
        }
    };

    animateStat(statActive, activeArcs.length.toString());
    animateStat(statTotal, totalQueries.toString());
    animateStat(statBlocked, blockedQueries.toString());

    if (responseTimes.length > 0) {
        const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
        if (!isNaN(avg)) {
            animateStat(statAvg, `${avg.toFixed(1)}ms`);
        } else {
            animateStat(statAvg, '0ms');
        }
    } else {
        animateStat(statAvg, '0ms');
    }
}

/**
 * Toggle dark/light mode
 */
function toggleTheme() {
    console.log('Toggle theme clicked, current isDarkMode:', isDarkMode);
    isDarkMode = !isDarkMode;
    const themeIcon = document.getElementById('theme-icon');

    if (isDarkMode) {
        console.log('Switching to dark mode');
        themeIcon.textContent = '☀️';
        document.body.classList.remove('light-mode');

        // Wait for map to be ready
        if (map && map.isStyleLoaded()) {
            applyDarkMode();
        } else {
            map.once('load', applyDarkMode);
        }
    } else {
        console.log('Switching to light mode');
        themeIcon.textContent = '🌙';
        document.body.classList.add('light-mode');

        // Reload light style
        const currentCenter = map.getCenter();
        const currentZoom = map.getZoom();

        map.setStyle('https://demotiles.maplibre.org/style.json');

        // Restore view after style loads
        map.once('styledata', () => {
            map.setCenter(currentCenter);
            map.setZoom(currentZoom);
        });
    }

    // Redraw chart with new theme colors
    drawResponseChart();
}

/**
 * Toggle sidebar position (left/right)
 */
function toggleSidebarPosition() {
    isSidebarRight = !isSidebarRight;
    
    if (isSidebarRight) {
        document.body.classList.add('sidebar-right');
    } else {
        document.body.classList.remove('sidebar-right');
    }
    
    // Move navigation controls to opposite corner
    if (navigationControl && map) {
        map.removeControl(navigationControl);
        const newPosition = isSidebarRight ? 'bottom-left' : 'bottom-right';
        map.addControl(navigationControl, newPosition);
    }
    
    // Store preference in localStorage
    localStorage.setItem('sidebarPosition', isSidebarRight ? 'right' : 'left');
}

/**
 * Toggle sidebar visibility (show/hide)
 */
function toggleSidebarVisibility() {
    const isHidden = document.body.classList.toggle('sidebar-hidden');
    
    // Store preference in localStorage
    localStorage.setItem('sidebarHidden', isHidden ? 'true' : 'false');
}

/**
 * Apply dark mode styling to map
 */
function applyDarkMode() {
    if (!map.isStyleLoaded()) {
        map.once('styledata', applyDarkMode);
        return;
    }

    const layers = map.getStyle().layers;

    layers.forEach(layer => {
        if (layer.type === 'background') {
            map.setPaintProperty(layer.id, 'background-color', '#0a0e27');
        } else if (layer.type === 'fill' && (layer.id.includes('water') || layer['source-layer'] === 'water')) {
            // Darker blue for water with better contrast
            map.setPaintProperty(layer.id, 'fill-color', '#0F1824');
            map.setPaintProperty(layer.id, 'fill-opacity', 0.8);
        } else if (layer.type === 'fill' && !layer.id.includes('water')) {
            // Lighter land mass for better visibility
            map.setPaintProperty(layer.id, 'fill-color', '#1A2333');
            map.setPaintProperty(layer.id, 'fill-outline-color', '#2D3748');
            map.setPaintProperty(layer.id, 'fill-opacity', 0.7);
        } else if (layer.type === 'line') {
            if (layer.id.includes('boundary') || layer.id.includes('admin')) {
                // More visible borders
                map.setPaintProperty(layer.id, 'line-color', '#374151');
                map.setPaintProperty(layer.id, 'line-blur', 1.5);
                map.setPaintProperty(layer.id, 'line-opacity', 0.3);
                map.setPaintProperty(layer.id, 'line-width', 0.8);
            } else {
                // Slightly more visible lines
                map.setPaintProperty(layer.id, 'line-color', '#1F2937');
                map.setPaintProperty(layer.id, 'line-opacity', 0.1);
            }
        } else if (layer.type === 'symbol') {
            if (layer.layout && layer.layout['text-field']) {
                // Slightly brighter and more visible labels
                map.setPaintProperty(layer.id, 'text-color', '#546E7A');
                map.setPaintProperty(layer.id, 'text-halo-color', '#0a0e27');
                map.setPaintProperty(layer.id, 'text-halo-width', 2);
                map.setPaintProperty(layer.id, 'text-halo-blur', 1);
                map.setPaintProperty(layer.id, 'text-opacity', 0.4);
            }
        }
    });
}

/**
 * Create a glowing pulse effect at destination location
 */
function createDestinationGlow(destination, color) {
    const glowId = `glow-${Date.now()}-${Math.random()}`;
    
    // Add glow source at destination point
    map.addSource(glowId, {
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

    // Add two circle layers for glow effect
    const glowLayer1 = `${glowId}-1`;
    const glowLayer2 = `${glowId}-2`;

    // Outer glow circle
    map.addLayer({
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

    // Inner glow circle
    map.addLayer({
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

    // Animate the glow with expanding and fading effect
    const duration = 1500; // 1.5 seconds
    const steps = 30;
    const stepDuration = duration / steps;
    let currentStep = 0;

    const glowInterval = setInterval(() => {
        currentStep++;
        const progress = currentStep / steps;
        
        // Expand and fade out
        const scale = 1 + (progress * 2); // Expands to 3x size
        const opacity1 = 0.6 * (1 - progress);
        const opacity2 = 0.8 * (1 - progress);

        if (map.getLayer(glowLayer1)) {
            map.setPaintProperty(glowLayer1, 'circle-radius', 30 * scale);
            map.setPaintProperty(glowLayer1, 'circle-opacity', opacity1);
        }

        if (map.getLayer(glowLayer2)) {
            map.setPaintProperty(glowLayer2, 'circle-radius', 15 * scale);
            map.setPaintProperty(glowLayer2, 'circle-opacity', opacity2);
        }

        if (currentStep >= steps) {
            clearInterval(glowInterval);
            // Clean up
            setTimeout(() => {
                if (map.getLayer(glowLayer1)) map.removeLayer(glowLayer1);
                if (map.getLayer(glowLayer2)) map.removeLayer(glowLayer2);
                if (map.getSource(glowId)) map.removeSource(glowId);
            }, 100);
        }
    }, stepDuration);
}

/**
 * Trigger a brief pulse on the source marker
 */
function triggerSourcePulse() {
    // Prevent overlapping pulses - throttle to once every 100ms
    if (sourcePulseActive) return;
    
    sourcePulseActive = true;
    
    // Create temporary enhanced pulse
    if (map.getLayer('pulse-layer')) {
        const originalRadius = map.getPaintProperty('pulse-layer', 'circle-radius');
        const originalOpacity = map.getPaintProperty('pulse-layer', 'circle-opacity');
        
        // Quick burst animation
        map.setPaintProperty('pulse-layer', 'circle-radius', 35);
        map.setPaintProperty('pulse-layer', 'circle-opacity', 1);
        
        // Fade back to normal
        setTimeout(() => {
            if (map.getLayer('pulse-layer')) {
                map.setPaintProperty('pulse-layer', 'circle-radius', originalRadius);
                map.setPaintProperty('pulse-layer', 'circle-opacity', originalOpacity);
            }
        }, 100);
    }
    
    // Reset throttle
    setTimeout(() => {
        sourcePulseActive = false;
    }, 100);
}

// Update stats periodically
setInterval(updateStats, 1000);
