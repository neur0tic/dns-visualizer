class GeoService {
  constructor(sourceLat, sourceLng, options = {}) {
    this.source = {
      lat: parseFloat(sourceLat),
      lng: parseFloat(sourceLng),
      city: 'Kuala Lumpur',
      country: 'MY'
    };

    if (!this.isValidCoordinate(this.source.lat, this.source.lng)) {
      throw new Error('Invalid source coordinates');
    }

    this.cache = new Map();
    this.pendingRequests = new Map();
    this.maxCacheSize = this.validatePositiveInteger(options.maxCacheSize, 10000);
    this.cacheHits = 0;
    this.cacheMisses = 0;

    this.apiUrl = this.sanitizeUrl(options.apiUrl || process.env.GEOIP_API_URL || 'http://ip-api.com/json');
    this.apiTimeout = this.validatePositiveInteger(options.apiTimeout, 5000);
    this.maxRetries = this.validatePositiveInteger(options.maxRetries, 2);
    this.retryDelay = this.validatePositiveInteger(options.retryDelay, 1000);

    this.requestQueue = [];
    this.maxRequestsPerMinute = this.validatePositiveInteger(options.maxRequestsPerMinute, 15);
    this.requestWindow = 60000;
    this.minRequestDelay = this.validatePositiveInteger(options.minRequestDelay, 4000);
    this.lastRequestTime = 0;

    this.circuitBreaker = {
      failures: 0,
      maxFailures: 5,
      resetTimeout: 30000,
      state: 'CLOSED',
      lastFailureTime: null
    };

    this.stats = {
      totalLookups: 0,
      apiCalls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      apiFailures: 0,
      rateLimitHits: 0,
      circuitBreakerTrips: 0
    };
  }

  async lookup(ip) {
    this.stats.totalLookups++;

    if (!this.isValidInput(ip)) {
      return null;
    }

    const sanitizedIp = this.sanitizeIp(ip);
    if (!sanitizedIp) {
      return null;
    }

    if (this.cache.has(sanitizedIp)) {
      this.stats.cacheHits++;
      const value = this.cache.get(sanitizedIp);

      this.cache.delete(sanitizedIp);
      this.cache.set(sanitizedIp, value);

      console.log(`💾 Cache HIT for ${sanitizedIp} (${this.stats.cacheHits} hits, ${this.stats.cacheMisses} misses)`);

      return value;
    }

    this.stats.cacheMisses++;

    if (this.pendingRequests.has(sanitizedIp)) {
      console.log(`⏳ Joining existing pending request for ${sanitizedIp}`);
      return this.pendingRequests.get(sanitizedIp);
    }

    console.log(`🔍 Cache MISS for ${sanitizedIp} - will call API (${this.stats.cacheHits} hits, ${this.stats.cacheMisses} misses)`);

    if (this.isPrivateIP(sanitizedIp)) {
      console.log(`🏠 Private IP detected: ${sanitizedIp} - skipping API call`);
      return null;
    }

    if (this.circuitBreaker.state === 'OPEN') {
      const now = Date.now();
      if (now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.resetTimeout) {
        console.log('🔄 Circuit breaker: Transitioning to HALF_OPEN');
        this.circuitBreaker.state = 'HALF_OPEN';
      } else {
        console.warn(`⚠️  Circuit breaker OPEN, skipping API call for ${sanitizedIp}`);
        this.addToCache(sanitizedIp, null);
        return null;
      }
    }

    const lookupPromise = (async () => {
      try {
        const result = await this.apiLookupWithRetry(sanitizedIp);

        if (result) {
          this.circuitBreaker.failures = 0;
          if (this.circuitBreaker.state === 'HALF_OPEN') {
            console.log('✅ Circuit breaker: Transitioning to CLOSED');
            this.circuitBreaker.state = 'CLOSED';
          }
        }

        this.addToCache(sanitizedIp, result);
        return result;

      } catch (error) {
        console.error(`❌ GeoIP lookup failed for ${sanitizedIp}:`, error.message);

        this.handleApiFailure(error);

        this.addToCache(sanitizedIp, null);
        return null;
      } finally {
        this.pendingRequests.delete(sanitizedIp);
      }
    })();

    this.pendingRequests.set(sanitizedIp, lookupPromise);
    return lookupPromise;
  }

  async apiLookupWithRetry(ip, attempt = 1) {
    try {
      return await this.apiLookup(ip);
    } catch (error) {
      // Don't retry if it's a rate limit error or the circuit breaker is opening
      if (error.message.includes('Rate limit') || this.circuitBreaker.state === 'OPEN') {
        return null;
      }

      if (attempt < this.maxRetries) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
        console.log(`🔄 Retrying API call for ${ip} (attempt ${attempt + 1}/${this.maxRetries}) in ${delay}ms`);

        await this.sleep(delay);
        return await this.apiLookupWithRetry(ip, attempt + 1);
      }

      throw error;
    }
  }

  async apiLookup(ip) {
    await this.checkRateLimit();

    this.stats.apiCalls++;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.apiTimeout);

    try {
      const fields = 'status,message,lat,lon,city,country';
      const url = `${this.apiUrl}/${encodeURIComponent(ip)}?fields=${fields}`;

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'DNS-Visualization-Dashboard/2.0',
          'Accept': 'application/json'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.status === 'fail') {
        console.warn(`⚠️  GeoIP API failed for ${ip}: ${data.message}`);
        return null;
      }

      if (!this.isValidCoordinate(data.lat, data.lon)) {
        console.warn(`⚠️  Invalid coordinates from API for ${ip}`);
        return null;
      }

      const result = {
        lat: parseFloat(data.lat),
        lng: parseFloat(data.lon),
        city: this.sanitizeString(data.city) || 'Unknown',
        country: this.sanitizeString(data.country) || 'Unknown'
      };

      console.log(`✅ GeoIP API success for ${ip}: ${result.city}, ${result.country} (${result.lat}, ${result.lng})`);

      return result;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`API request timeout after ${this.apiTimeout}ms`);
      }

      throw error;
    }
  }

  async checkRateLimit() {
    const now = Date.now();

    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestDelay) {
      const waitTime = this.minRequestDelay - timeSinceLastRequest;
      if (waitTime > 2000) {
        throw new Error('Rate limit: minimum delay exceeded');
      }
      console.log(`⏸️  Enforcing minimum ${this.minRequestDelay}ms delay, waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    const windowStart = now - this.requestWindow;

    this.requestQueue = this.requestQueue.filter(time => time > windowStart);

    if (this.requestQueue.length >= this.maxRequestsPerMinute) {
      this.stats.rateLimitHits++;

      const oldestRequest = this.requestQueue[0];
      const waitTime = this.requestWindow - (now - oldestRequest);

      if (waitTime > 0) {
        console.warn(`⏳ Rate limit reached, skip pending IP lookup to avoid blocking (wait time: ${waitTime}ms)`);
        throw new Error('Rate limit: requests per minute exceeded');
      }
    }

    this.lastRequestTime = Date.now();
    this.requestQueue.push(this.lastRequestTime);
  }

  handleApiFailure(error) {
    this.stats.apiFailures++;
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failures >= this.circuitBreaker.maxFailures) {
      if (this.circuitBreaker.state !== 'OPEN') {
        console.error(`🔴 Circuit breaker OPEN after ${this.circuitBreaker.failures} failures`);
        this.stats.circuitBreakerTrips++;
      }
      this.circuitBreaker.state = 'OPEN';
    }
  }

  isValidInput(ip) {
    return ip && typeof ip === 'string' && ip.length > 0 && ip.length <= 45; // Max IPv6 length
  }

  sanitizeIp(ip) {
    const cleaned = ip.trim().replace(/[^\w.:\[\]]/g, '');

    if (cleaned.length === 0 || cleaned.length > 45) {
      return null;
    }

    return cleaned;
  }

  sanitizeString(str) {
    if (typeof str !== 'string') return '';

    return str
      .trim()
      .replace(/[<>\"\'&]/g, '')
      .substring(0, 100);
  }

  sanitizeUrl(url) {
    if (!url || typeof url !== 'string') {
      return 'http://ip-api.com/json';
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'http://ip-api.com/json';
    }

    return url;
  }

  isValidCoordinate(lat, lng) {
    return (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      !isNaN(lat) &&
      !isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    );
  }

  validatePositiveInteger(value, defaultValue) {
    const parsed = parseInt(value, 10);
    return (parsed > 0) ? parsed : defaultValue;
  }

  isPrivateIP(ip) {
    if (!ip || typeof ip !== 'string') return true;

    if (ip.includes('.')) {
      const parts = ip.split('.');

      if (parts.length !== 4) return true;

      const octets = parts.map(p => parseInt(p, 10));

      if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return true;

      const [first, second, third] = octets;

      return (
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        first === 0 ||
        (first === 169 && second === 254) ||
        first === 255 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 192 && second === 0 && (third === 0 || third === 2)) ||
        (first === 198 && second === 18) ||
        (first === 198 && second === 51 && third === 100) ||
        (first === 203 && second === 0 && third === 113) ||
        first >= 224
      );
    }

    if (ip.includes(':')) {
      const lower = ip.toLowerCase();

      return (
        lower.startsWith('fe80:') ||
        lower.startsWith('fe80::') ||
        lower.startsWith('fec0:') ||
        lower.startsWith('fc00:') ||
        lower.startsWith('fd00:') ||
        lower === '::1' ||
        lower === '::' ||
        lower.startsWith('ff00:') ||
        lower.startsWith('2001:db8:') ||
        lower.startsWith('2001:10:') ||
        lower.startsWith('2002:')
      );
    }

    return true;
  }

  addToCache(ip, data) {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(ip, data);
  }

  getSource() {
    return { ...this.source };
  }

  clearCache() {
    this.cache.clear();
    this.requestQueue = [];
    this.stats.cacheHits = 0;
    this.stats.cacheMisses = 0;
  }

  getStats() {
    const cacheHitRate = this.stats.totalLookups > 0
      ? ((this.stats.cacheHits / this.stats.totalLookups) * 100).toFixed(2)
      : '0.00';

    return {
      ...this.stats,
      cacheSize: this.cache.size,
      maxCacheSize: this.maxCacheSize,
      cacheHitRate: `${cacheHitRate}%`,
      requestsInWindow: this.requestQueue.length,
      maxRequestsPerMinute: this.maxRequestsPerMinute,
      circuitBreakerState: this.circuitBreaker.state,
      circuitBreakerFailures: this.circuitBreaker.failures
    };
  }

  resetCircuitBreaker() {
    this.circuitBreaker.failures = 0;
    this.circuitBreaker.state = 'CLOSED';
    this.circuitBreaker.lastFailureTime = null;
    console.log('🔄 Circuit breaker manually reset');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default GeoService;
