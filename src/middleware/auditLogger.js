import { runWithTenant } from '../db/tenantContext.js';
import { getTenantConnectionFor } from '../db/connections.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { clientInfo } from '../utils/clientInfo.js';

// Global audit logger — records EVERY mutating API request (create/update/delete)
// into the tenant's AuditLog after the response is sent. Read requests (GET) are
// skipped to keep the trail readable. Auth events (login/logout) are logged
// separately inside the auth controller (no tenant context at request start).
//
// The write happens in a `res.on('finish')` hook and re-enters the tenant
// connection explicitly via runWithTenant, so it works regardless of async
// context timing and never blocks/breaks the response.

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SENSITIVE = new Set([
  'password', 'newPassword', 'currentPassword', 'oldPassword',
  'pin', 'token', 'refreshToken', 'accessToken', 'clientSecret', 'shopifySecret',
  'accessTokenEncrypted', 'clientIdEncrypted', 'clientSecretEncrypted', 'selfieImage', 'image',
  'faceDescriptor', 'descriptor',
]);

// Shallow-redact sensitive keys and trim huge values (e.g. base64 images) so
// the audit entry stays small and never stores secrets.
const sanitizeBody = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (SENSITIVE.has(k)) { out[k] = '***'; continue; }
    if (typeof v === 'string' && v.length > 500) { out[k] = `[${v.length} chars]`; continue; }
    if (v && typeof v === 'object') {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > 1000 ? `[object ${s.length} chars]` : v;
      } catch { out[k] = '[unserialisable]'; }
      continue;
    }
    out[k] = v;
  }
  return out;
};

const moduleFromPath = (path) => {
  const m = path.match(/^\/api\/([^/?#]+)/);
  return m ? m[1] : 'api';
};

const VERB = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

const objectIdInPath = (path) => {
  const m = path.match(/\/([a-f\d]{24})(?:[/?#]|$)/i);
  return m ? m[1] : undefined;
};

export const auditLogger = (req, res, next) => {
  if (!MUTATING.has(req.method)) return next();

  // Snapshot the body + client info now (req may be mutated by handlers later).
  const bodySnapshot = sanitizeBody(req.body);
  const { ip, userAgent, device, location } = clientInfo(req);

  res.on('finish', () => {
    try {
      const slug = req.tenantSlug;
      if (!slug) return; // unauthenticated / platform-admin — nothing to attribute

      const path = (req.originalUrl || req.url || '').replace(/[?#].*$/, '');
      const mod = moduleFromPath(path);
      const recordId = objectIdInPath(path);

      const entry = {
        user: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        actorRole: req.user?.role ?? null,
        action: `${mod}.${VERB[req.method] || req.method.toLowerCase()}`,
        module: mod,
        method: req.method,
        path,
        statusCode: res.statusCode,
        recordId,
        after: bodySnapshot,
        ip,
        device,
        location,
        userAgent,
        source: 'auto',
      };

      // Fire-and-forget: the response is already sent. Re-enter the tenant
      // connection so the write lands in the right database.
      getTenantConnectionFor(slug)
        .then((conn) => runWithTenant({ conn, slug }, () => AuditLog.create(entry)))
        .catch((err) => logger.warn(`[audit] failed to log ${req.method} ${path}: ${err.message}`));
    } catch (err) {
      logger.warn(`[audit] hook error: ${err.message}`);
    }
  });

  next();
};

export default auditLogger;
