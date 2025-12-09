import fetch from 'node-fetch';

/**
 * AdGuard Home API Client
 * Handles authentication and fetching DNS query logs
 */
class AdGuardClient {
  constructor(url, username, password) {
    this.baseUrl = url;
    this.username = username;
    this.password = password;
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.lastTimestamp = null;
  }

  /**
   * Fetch DNS query logs from AdGuard Home
   * @param {number} limit - Number of logs to fetch
   * @returns {Promise<Array>} Array of DNS query log entries
   */
  async getQueryLog(limit = 50) {
    try {
      const url = `${this.baseUrl}/control/querylog`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader
        }
      });

      if (!response.ok) {
        throw new Error(`AdGuard API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Update last timestamp for pagination
      if (data.data && data.data.length > 0) {
        this.lastTimestamp = data.oldest;
      }

      return this.parseQueryLogs(data.data || []);
    } catch (error) {
      console.error('Error fetching AdGuard query log:', error.message);
      throw error;
    }
  }

  /**
   * Parse and sanitize DNS query logs
   * @param {Array} logs - Raw log entries from AdGuard
   * @returns {Array} Parsed and sanitized log entries
   */
  parseQueryLogs(logs) {
    return logs.map((log, index) => {
      // Debug: Log first entry to see structure
      if (index === 0) {
        console.log('Sample log entry:', JSON.stringify(log, null, 2));
      }

      // Check if query was filtered/blocked - AdGuard uses multiple fields
      // Only consider queries with "Filtered" prefix in reason as blocked
      const filtered = (log.reason && log.reason.startsWith('Filtered')) ||
                       (log.rules && log.rules.length > 0) ||
                       (log.rule && log.rule.length > 0);

      // Debug: Log all queries with their reason to understand the data
      if (index < 5) { // Log first 5 entries to see patterns
        console.log(`Query: ${log.question?.name} - Reason: ${log.reason || 'None'} - Filtered: ${filtered}`);
      }

      return {
        timestamp: new Date(log.time),
        client: this.sanitizeIP(log.client),
        domain: this.sanitizeDomain(log.question?.name || 'unknown'),
        type: log.question?.type || 'A',
        status: log.status || 'NOERROR',
        elapsed: log.elapsedMs ? parseFloat(log.elapsedMs).toFixed(2) : 0,
        answer: this.parseAnswer(log.answer),
        upstream: log.upstream || '',
        cached: log.cached || false,
        filtered: filtered,
        reason: log.reason || ''
      };
    });
  }

  /**
   * Parse DNS answer to extract IP addresses
   * @param {Array} answer - DNS answer array
   * @returns {Array} Array of IP addresses
   */
  parseAnswer(answer) {
    if (!answer || !Array.isArray(answer)) return [];

    return answer
      .filter(a => a.type === 'A' || a.type === 'AAAA')
      .map(a => a.value)
      .filter(ip => this.isValidIP(ip))
      .slice(0, 3); // Limit to first 3 IPs for performance
  }

  /**
   * Validate IP address format
   * @param {string} ip - IP address to validate
   * @returns {boolean}
   */
  isValidIP(ip) {
    if (!ip || ip === '::' || ip === '0.0.0.0') return false;

    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

    // Check format
    if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) return false;

    // Exclude localhost
    if (ip === '127.0.0.1' || ip === '::1') return false;

    return true;
  }

  /**
   * Sanitize IP address (remove sensitive info)
   * @param {string} ip - IP address
   * @returns {string} Sanitized IP
   */
  sanitizeIP(ip) {
    if (!ip) return 'unknown';
    // Remove port if present
    return ip.split(':')[0];
  }

  /**
   * Sanitize domain name
   * @param {string} domain - Domain name
   * @returns {string} Sanitized domain
   */
  sanitizeDomain(domain) {
    if (!domain) return 'unknown';
    // Remove trailing dot and convert to lowercase
    return domain.replace(/\.$/, '').toLowerCase();
  }

  /**
   * Fetch statistics from AdGuard Home
   * @returns {Promise<Object>} Statistics object
   */
  async getStats() {
    try {
      const url = `${this.baseUrl}/control/stats`;
      const response = await fetch(url, {
        headers: {
          'Authorization': this.authHeader
        }
      });

      if (!response.ok) {
        throw new Error(`AdGuard API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return {
        numDnsQueries: data.num_dns_queries || 0,
        numBlockedFiltering: data.num_blocked_filtering || 0,
        avgProcessingTime: data.avg_processing_time || 0, // in milliseconds
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
    try {
      const url = `${this.baseUrl}/control/status`;
      const response = await fetch(url, {
        headers: {
          'Authorization': this.authHeader
        }
      });

      return response.ok;
    } catch (error) {
      console.error('AdGuard connection test failed:', error.message);
      return false;
    }
  }
}

export default AdGuardClient;
