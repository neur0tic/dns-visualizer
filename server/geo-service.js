import geoip from 'geoip-lite';

/**
 * Geolocation Service with LRU caching
 * Converts IP addresses to geographic coordinates
 */
class GeoService {
  constructor(sourceLat, sourceLng, options = {}) {
    this.source = {
      lat: parseFloat(sourceLat),
      lng: parseFloat(sourceLng),
      city: 'Kuala Lumpur',
      country: 'MY'
    };

    // Validate source coordinates
    if (isNaN(this.source.lat) || isNaN(this.source.lng)) {
      throw new Error('Invalid source coordinates');
    }

    // LRU Cache implementation
    this.cache = new Map();
    this.maxCacheSize = options.maxCacheSize || 1000;
  }

  /**
   * Get coordinates for an IP address
   * @param {string} ip - IP address
   * @returns {Object|null} Coordinates object {lat, lng, city, country}
   */
  lookup(ip) {
    if (!ip || typeof ip !== 'string') return null;

    // Check cache first (LRU: move to end)
    if (this.cache.has(ip)) {
      const value = this.cache.get(ip);
      this.cache.delete(ip);
      this.cache.set(ip, value);
      return value;
    }

    // Filter out private/local IPs
    if (this.isPrivateIP(ip)) {
      return null;
    }

    // Perform lookup
    const geo = geoip.lookup(ip);

    if (!geo || !geo.ll || geo.ll.length !== 2) {
      this.addToCache(ip, null);
      return null;
    }

    const result = {
      lat: geo.ll[0],
      lng: geo.ll[1],
      city: geo.city || 'Unknown',
      country: geo.country || 'Unknown'
    };

    // Validate coordinates
    if (isNaN(result.lat) || isNaN(result.lng)) {
      this.addToCache(ip, null);
      return null;
    }

    // Add to cache
    this.addToCache(ip, result);

    return result;
  }

  /**
   * Check if IP is private/local
   * @param {string} ip - IP address
   * @returns {boolean}
   */
  isPrivateIP(ip) {
    if (!ip || typeof ip !== 'string') return true;

    // IPv4 private ranges
    if (ip.includes('.')) {
      const parts = ip.split('.');
      
      if (parts.length !== 4) return true;
      
      const octets = parts.map(p => parseInt(p, 10));
      
      // Validate all octets are numbers 0-255
      if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return true;

      const [first, second, third] = octets;

      return (
        first === 10 ||                                    // 10.0.0.0/8
        first === 127 ||                                   // 127.0.0.0/8 (loopback)
        (first === 172 && second >= 16 && second <= 31) || // 172.16.0.0/12
        (first === 192 && second === 168) ||               // 192.168.0.0/16
        first === 0 ||                                     // 0.0.0.0/8
        (first === 169 && second === 254) ||               // 169.254.0.0/16 (link-local)
        first === 255 ||                                   // 255.0.0.0/8 (broadcast)
        (first === 100 && second >= 64 && second <= 127) || // 100.64.0.0/10 (shared)
        (first === 192 && second === 0 && (third === 0 || third === 2)) || // 192.0.0.0/24, 192.0.2.0/24
        (first === 198 && second === 18) ||                // 198.18.0.0/15 (benchmarking)
        (first === 198 && second === 51 && third === 100) || // 198.51.100.0/24 (documentation)
        (first === 203 && second === 0 && third === 113) || // 203.0.113.0/24 (documentation)
        first >= 224                                       // 224.0.0.0/4 (multicast & reserved)
      );
    }

    // IPv6 private ranges
    if (ip.includes(':')) {
      const lower = ip.toLowerCase();
      
      return (
        lower.startsWith('fe80:') ||    // Link-local
        lower.startsWith('fe80::') ||
        lower.startsWith('fec0:') ||    // Site-local (deprecated)
        lower.startsWith('fc00:') ||    // Unique local address (ULA)
        lower.startsWith('fd00:') ||    // ULA
        lower === '::1' ||              // Loopback
        lower === '::' ||               // Unspecified
        lower.startsWith('ff00:') ||    // Multicast
        lower.startsWith('2001:db8:') || // Documentation
        lower.startsWith('2001:10:') || // Deprecated ORCHID
        lower.startsWith('2002:')       // 6to4 (often problematic)
      );
    }

    return true; // Unknown format, treat as private
  }

  /**
   * Add entry to cache with LRU eviction
   * @param {string} ip - IP address
   * @param {Object|null} data - Geolocation data
   */
  addToCache(ip, data) {
    // Remove oldest entry if cache is full (LRU: first item is oldest)
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(ip, data);
  }

  /**
   * Get source location (Kuala Lumpur)
   * @returns {Object} Source coordinates
   */
  getSource() {
    return { ...this.source }; // Return copy to prevent mutation
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxCacheSize,
      hitRate: this._calculateHitRate()
    };
  }

  /**
   * Calculate cache hit rate (if tracking is enabled)
   * @private
   */
  _calculateHitRate() {
    // This would require tracking hits/misses
    // For now, return null or implement if needed
    return null;
  }
}

export default GeoService;
