import fetch from 'node-fetch';
import dns from 'dns/promises';

/**
 * AdGuard Home API Client
 * Handles authentication and fetching DNS query logs with proper error handling
 */
class AdGuardClient {
  constructor(url, username, password, options = {}) {
    this.baseUrl = url.replace(/\/$/, ''); // Remove trailing slash
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.timeout = options.timeout || 10000; // 10 second default timeout
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
  }

  /**
   * Fetch DNS query logs from AdGuard Home
   * @param {number} limit - Number of logs to fetch (not used by AdGuard API)
   * @returns {Promise<Array>} Array of DNS query log entries
   */
  async getQueryLog(limit = 50) {
    const url = `${this.baseUrl}/control/querylog`;
    
    try {
      const data = await this._fetchWithRetry(url);
      return this.parseQueryLogs(data.data || []);
    } catch (error) {
      console.error('Error fetching AdGuard query log:', error.message);
      throw error;
    }
  }

  /**
   * Fetch statistics from AdGuard Home
   * @returns {Promise<Object>} Statistics object
   */
  async getStats() {
    const url = `${this.baseUrl}/control/stats`;
    
    try {
      const data = await this._fetchWithRetry(url);
      return {
        numDnsQueries: data.num_dns_queries || 0,
        numBlockedFiltering: data.num_blocked_filtering || 0,
        avgProcessingTime: data.avg_processing_time || 0,
        topQueriedDomains: data.top_queried_domains || [],
        topBlockedDomains: data.top_blocked_domains || [],
        topClients: data.top_clients || []
      };
    } catch (error) {
      console.error('Error fetching AdGuard stats:', error.message);
      throw error;
    }
  }

  /**
   * Test connection to AdGuard Home
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    const url = `${this.baseUrl}/control/status`;
    
    try {
      const response = await this._fetch(url);
      return response.ok;
    } catch (error) {
      console.error('AdGuard connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Parse and sanitize DNS query logs
   * @param {Array} logs - Raw log entries from AdGuard
   * @returns {Array} Parsed and sanitized log entries
   */
  parseQueryLogs(logs) {
    if (!Array.isArray(logs)) {
      console.warn('Expected array of logs, received:', typeof logs);
      return [];
    }

    return logs.map(log => {
      // Check if query was filtered/blocked - improved detection
      // AdGuard marks blocked queries with reasons starting with "Filtered"
      const filtered = Boolean(
        (log.reason && log.reason.startsWith('Filtered')) ||
        (log.rules && log.rules.length > 0) ||
        (log.rule && log.rule.length > 0)
      );

      // Calculate upstream elapsed time
      // AdGuard doesn't provide separate upstream time, so we estimate:
      // - For cached queries: upstream time is 0 (served from cache)
      // - For non-cached queries: upstream is ~85% of total (AdGuard processing is ~15%)
      let upstreamElapsed = null;
      const totalElapsed = log.elapsedMs ? parseFloat(log.elapsedMs) : 0;
      
      if (log.cached) {
        upstreamElapsed = 0; // Cached responses don't hit upstream
      } else if (totalElapsed > 0 && log.upstream) {
        // Query went to upstream DNS server - estimate upstream time
        upstreamElapsed = (totalElapsed * 0.85).toFixed(2);
      } else if (totalElapsed > 0) {
        // No upstream server listed but query processed (possibly local response)
        upstreamElapsed = (totalElapsed * 0.5).toFixed(2);
      }

      const parsedAnswer = this.parseAnswer(log.answer);

      return {
        timestamp: new Date(log.time),
        client: this.sanitizeIP(log.client),
        domain: this.sanitizeDomain(log.question?.name || 'unknown'),
        type: log.question?.type || 'A',
        status: log.status || 'NOERROR',
        elapsed: totalElapsed.toFixed(2),
        answer: parsedAnswer.ips, // Extract IPs array
        cname: parsedAnswer.cname, // Store CNAME for later resolution
        upstream: log.upstream || '',
        upstreamElapsed,
        cached: log.cached || false,
        filtered,
        reason: log.reason || ''
      };
    });
  }

  /**
   * Parse DNS answer to extract IP addresses
   * Follows CNAME chains when possible
   * @param {Array} answer - DNS answer array
   * @returns {Object} Object with IPs array and optional CNAME to resolve
   */
  parseAnswer(answer) {
    if (!answer || !Array.isArray(answer)) return { ips: [], cname: null };

    const ips = [];
    let cnameTarget = null;

    // First pass: collect all A/AAAA records directly
    for (const record of answer) {
      if ((record.type === 'A' || record.type === 'AAAA') && record.value) {
        if (this.isValidIP(record.value)) {
          ips.push(record.value);
        }
      } else if (record.type === 'CNAME' && record.value && !cnameTarget) {
        // Store the first CNAME target for potential resolution
        cnameTarget = record.value;
      }
    }

    // If we found IPs, return them (most common case)
    if (ips.length > 0) {
      return { ips: ips.slice(0, 3), cname: null };
    }

    // Second pass: if no IPs found, check if there are CNAMEs with nested answers
    const allRecords = answer.flatMap(a => {
      // Check if this is a CNAME with nested answer
      if (a.type === 'CNAME' && Array.isArray(a.answer)) {
        return a.answer;
      }
      return [a];
    });

    // Try again with flattened records
    for (const record of allRecords) {
      if ((record.type === 'A' || record.type === 'AAAA') && record.value) {
        if (this.isValidIP(record.value)) {
          ips.push(record.value);
        }
      }
    }

    if (ips.length > 0) {
      return { ips: ips.slice(0, 3), cname: null };
    }

    // No IPs found, return CNAME for potential resolution
    return { ips: [], cname: cnameTarget };
  }

  /**
   * Resolve CNAME to IP addresses using system DNS
   * @param {string} hostname - Hostname to resolve
   * @returns {Promise<Array>} Array of IP addresses
   */
  async resolveCNAME(hostname) {
    if (!hostname || typeof hostname !== 'string') return [];

    try {
      // Try IPv4 first
      const addresses = await dns.resolve4(hostname);
      return addresses.slice(0, 3); // Limit to 3 IPs
    } catch (err) {
      // If IPv4 fails, try IPv6
      try {
        const addresses = await dns.resolve6(hostname);
        return addresses.slice(0, 3);
      } catch (err2) {
        // Both failed
        console.log(`📋 CNAME resolution failed for ${hostname}: ${err.code || err.message}`);
        return [];
      }
    }
  }

  /**
   * Validate IP address format
   * @param {string} ip - IP address to validate
   * @returns {boolean}
   */
  isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;
    
    // Exclude special addresses
    if (ip === '::' || ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::1') {
      return false;
    }

    // IPv4 validation
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(ip)) {
      const parts = ip.split('.').map(Number);
      return parts.every(part => part >= 0 && part <= 255);
    }

    // IPv6 validation (simplified)
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    return ipv6Regex.test(ip);
  }

  /**
   * Sanitize IP address (remove port, validate format)
   * @param {string} ip - IP address
   * @returns {string} Sanitized IP
   */
  sanitizeIP(ip) {
    if (!ip || typeof ip !== 'string') return 'unknown';
    
    // Remove port if present (handle both IPv4:port and [IPv6]:port)
    const match = ip.match(/^\[?([^\]]+)\]?(?::\d+)?$/);
    return match ? match[1] : ip;
  }

  /**
   * Sanitize domain name
   * @param {string} domain - Domain name
   * @returns {string} Sanitized domain
   */
  sanitizeDomain(domain) {
    if (!domain || typeof domain !== 'string') return 'unknown';
    
    // Remove trailing dot, convert to lowercase, and trim
    return domain.replace(/\.$/, '').toLowerCase().trim();
  }

  /**
   * Fetch with timeout and abort controller
   * @private
   */
  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': this.authHeader,
          ...options.headers
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`AdGuard API error: ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      
      throw error;
    }
  }

  /**
   * Fetch with retry logic
   * @private
   */
  async _fetchWithRetry(url, options = {}, retryCount = 0) {
    try {
      const response = await this._fetch(url, options);
      return await response.json();
    } catch (error) {
      if (retryCount < this.maxRetries) {
        console.warn(`Retry ${retryCount + 1}/${this.maxRetries} for ${url}: ${error.message}`);
        await this._delay(this.retryDelay * (retryCount + 1)); // Exponential backoff
        return this._fetchWithRetry(url, options, retryCount + 1);
      }
      
      throw error;
    }
  }

  /**
   * Delay helper for retries
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default AdGuardClient;
