import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { allowedByDefault } from '../config/permissions.js';
import { runWithTenant } from '../db/tenantContext.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { cacheGet, cacheSet, TENANT_TTL_MS, USER_TTL_MS, tenantKey, userKey } from '../utils/requestCache.js';

// Routes that authenticated users can hit even when their subscription has
// lapsed — sign-out, refresh, profile/me, billing-blocked screen, and the
// onboarding wizard are always reachable.
const SUBSCRIPTION_BYPASS = [
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/me',
  '/api/onboarding',
  '/api/billing',
];

const isSubscriptionActive = (tenant) => {
  if (!tenant) return false;
  if (tenant.status === 'suspended') return false;
  if (!tenant.accessUntil) return false;
  return new Date(tenant.accessUntil).getTime() > Date.now();
};

const fail = (res, msg) => res.status(401).json({ success: false, message: msg });

// Rider credentials are intentionally scoped to the dedicated mobile API.
// This prevents a role with no management permissions from accidentally
// reaching older protect-only tenant routes that predate granular permissions.
const riderRouteAllowed = (req) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path === '/api/rider'
    || path.startsWith('/api/rider/')
    || path === '/api/auth/me'
    || path === '/api/auth/logout';
};

const verify = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
};

const loadUserAndAttach = async (req, res, decoded, next) => {
  // Per-request user lookup is cached (short TTL + invalidated on user edits) to
  // avoid a DB round-trip on every API call.
  let userObj = cacheGet(userKey(decoded.id, decoded.tenantSlug));
  if (!userObj) {
    const user = await User.findById(decoded.id).select(
      'name email role isActive outlet outletRef permissions posDiscountLimitPercent'
    );
    if (!user) return fail(res, 'User no longer exists.');
    userObj = user.toObject();
    cacheSet(userKey(decoded.id, decoded.tenantSlug), userObj, USER_TTL_MS);
  }
  if (!userObj.isActive) return fail(res, 'Account is deactivated.');

  req.user = {
    id: userObj._id,
    name: userObj.name,
    email: userObj.email,
    role: userObj.role,
    permissions: userObj.permissions || {},
    tenantSlug: decoded.tenantSlug,
    outlet: userObj.outlet || null,
    outletCode: userObj.outlet || null,
    outletRef: userObj.outletRef || null,
    posDiscountLimitPercent: Number.isFinite(Number(userObj.posDiscountLimitPercent))
      ? Number(userObj.posDiscountLimitPercent)
      : 100,
  };
  req.tenantSlug = decoded.tenantSlug;

  req.user.hasPermission = (key) => {
    // The owner is a full-access superuser — overrides never restrict them, so a
    // stale/bad stored override can't lock the owner out of any feature. (Tenant
    // feature flags are enforced separately and still apply.)
    if (req.user.role === 'owner') return true;
    if (req.user.permissions && Object.prototype.hasOwnProperty.call(req.user.permissions, key)) {
      return !!req.user.permissions[key];
    }
    return allowedByDefault(key, req.user.role);
  };

  if (req.user.role === 'rider' && !riderRouteAllowed(req)) {
    return res.status(403).json({
      success: false,
      code: 'RIDER_APP_ONLY',
      message: 'Rider accounts can access only the Rider application.',
    });
  }

  next();
};

const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return fail(res, 'No token provided.');

  const decoded = verify(authHeader.split(' ')[1]);
  if (!decoded) return fail(res, 'Invalid or expired token.');

  // Platform admins must use /api/admin routes — they have no tenant context.
  if (decoded.isPlatformAdmin) {
    return res.status(403).json({
      success: false,
      message: 'Platform admin tokens are not accepted on tenant routes.',
    });
  }

  if (!decoded.tenantSlug) return fail(res, 'Token missing tenant context.');

  // Look the tenant up to ensure it still exists and to attach status info.
  // Cached (short TTL + invalidated on admin feature/subscription changes) to
  // avoid a platform-DB round-trip on every request.
  let tenant = cacheGet(tenantKey(decoded.tenantSlug));
  if (!tenant) {
    tenant = await TenantModel().findOne({ slug: decoded.tenantSlug }).lean();
    if (!tenant) return fail(res, 'Tenant no longer exists.');
    cacheSet(tenantKey(decoded.tenantSlug), tenant, TENANT_TTL_MS);
  }
  req.tenant = tenant;

  // Subscription gate. Bypass for sign-out / refresh / me / onboarding so
  // an expired tenant can still finish setup or sign themselves out.
  const bypass = SUBSCRIPTION_BYPASS.some((p) => req.originalUrl.startsWith(p));
  if (!bypass && !isSubscriptionActive(tenant)) {
    return res.status(402).json({
      success: false,
      code: 'SUBSCRIPTION_INACTIVE',
      message:
        tenant.status === 'suspended'
          ? 'This account is suspended. Contact support to reactivate.'
          : 'Subscription has expired. Contact support to renew access.',
      tenantStatus: tenant.status,
      accessUntil: tenant.accessUntil,
    });
  }

  const conn = await getTenantConnectionFor(decoded.tenantSlug);
  runWithTenant({ conn, slug: decoded.tenantSlug }, () => {
    loadUserAndAttach(req, res, decoded, next).catch(next);
  });
};

export const optionalProtect = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();

  const decoded = verify(authHeader.split(' ')[1]);
  if (!decoded || decoded.isPlatformAdmin || !decoded.tenantSlug) return next();

  let tenant = cacheGet(tenantKey(decoded.tenantSlug));
  if (!tenant) {
    tenant = await TenantModel().findOne({ slug: decoded.tenantSlug }).lean();
    if (!tenant) return next();
    cacheSet(tenantKey(decoded.tenantSlug), tenant, TENANT_TTL_MS);
  }
  req.tenant = tenant;

  const conn = await getTenantConnectionFor(decoded.tenantSlug);
  runWithTenant({ conn, slug: decoded.tenantSlug }, () => {
    (async () => {
      let userObj = cacheGet(userKey(decoded.id, decoded.tenantSlug));
      if (!userObj) {
        const user = await User.findById(decoded.id).select(
          'name email role isActive outlet outletRef permissions posDiscountLimitPercent'
        );
        if (user) {
          userObj = user.toObject();
          cacheSet(userKey(decoded.id, decoded.tenantSlug), userObj, USER_TTL_MS);
        }
      }
      if (userObj && userObj.isActive) {
        req.user = {
          id: userObj._id,
          name: userObj.name,
          email: userObj.email,
          role: userObj.role,
          permissions: userObj.permissions || {},
          tenantSlug: decoded.tenantSlug,
          outlet: userObj.outlet || null,
          outletCode: userObj.outlet || null,
          outletRef: userObj.outletRef || null,
          posDiscountLimitPercent: Number.isFinite(Number(userObj.posDiscountLimitPercent))
            ? Number(userObj.posDiscountLimitPercent)
            : 100,
        };
        req.tenantSlug = decoded.tenantSlug;
      }
      next();
    })().catch(next);
  });
};

export default protect;
