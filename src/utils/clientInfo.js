// Extracts client IP, device (from User-Agent), and a coarse location label for
// audit logging. No external dependencies — UA parsing is heuristic and the
// geo label only distinguishes local/private networks from public IPs (true
// city-level geo would need a geo-IP dataset).

// Reliable client IP: prefer Express's req.ip (honours `trust proxy`), then the
// first X-Forwarded-For hop, then the raw socket address. Normalises IPv6-mapped
// IPv4 (::ffff:1.2.3.4 → 1.2.3.4) and loopback (::1 → 127.0.0.1).
export const getClientIp = (req) => {
  let ip =
    req.ip ||
    (typeof req.headers?.['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : '') ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip || null;
};

const isPrivateIp = (ip) => {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === 'localhost') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^(fc|fd)/i.test(ip)) return true; // IPv6 unique-local
  return false;
};

// Coarse location label. Private/loopback → "Local network". Public IPs are
// returned as-is (city/country lookup would require a geo-IP database/service).
export const locationFromIp = (ip) => {
  if (!ip) return null;
  if (isPrivateIp(ip)) return 'Local network';
  return null; // unknown without a geo dataset; the IP itself is still shown
};

// Friendly device label from a User-Agent string, e.g. "Chrome on macOS".
export const parseDevice = (ua) => {
  if (!ua || typeof ua !== 'string') return null;

  let browser = 'Unknown browser';
  if (/edg(e|a|ios)?\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/(chrome|crios|chromium)\//i.test(ua)) browser = 'Chrome';
  else if (/(firefox|fxios)\//i.test(ua)) browser = 'Firefox';
  else if (/version\/.*safari/i.test(ua) || /safari\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown OS';
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x|macintosh/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';

  const isMobile = /mobile|iphone|ipod|android.*mobile/i.test(ua);
  const isTablet = /ipad|tablet|android(?!.*mobile)/i.test(ua);
  const kind = isTablet ? ' · Tablet' : isMobile ? ' · Mobile' : '';
  return `${browser} on ${os}${kind}`;
};

// Convenience: everything we want to stamp on an audit entry from a request.
export const clientInfo = (req) => {
  const ip = getClientIp(req);
  const userAgent = req.headers?.['user-agent'] || null;
  return { ip, userAgent, device: parseDevice(userAgent), location: locationFromIp(ip) };
};
