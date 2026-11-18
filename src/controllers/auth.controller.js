import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Outlet from '../models/Outlet.js';
import AuditLog from '../models/AuditLog.js';
import logger from '../utils/logger.js';
import { clientInfo } from '../utils/clientInfo.js';
import { PERMISSIONS } from '../config/permissions.js';
import {
  isFeatureEnabledForOutlet,
  outletFeatureMap,
  resolveFeaturesForUser,
} from '../services/outletFeatures.service.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { UserIndexModel } from '../platform/models/UserIndex.js';
import {
  getTenantConnectionFor,
  sanitizeSlug,
  dropTenantDatabase,
} from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import seedAccounts from '../accounting/seedAccounts.js';
import { ACCESS_TOKEN_EXPIRES_IN } from '../config/authTokens.js';

const REFRESH_COOKIE = 'refreshToken';

// Window during which a just-rotated (previous) refresh token is still accepted,
// so near-simultaneous refresh calls don't false-trigger reuse detection.
const REFRESH_GRACE_MS = 60 * 1000;

// Cookie attributes are environment-driven so the same code works for a
// same-origin dev setup and a cross-domain production deployment.
//   COOKIE_SAMESITE  = 'strict' (default) | 'lax' | 'none'
//   COOKIE_SECURE    = 'true' | 'false'  (defaults to NODE_ENV === 'production')
// Note: browsers require Secure whenever SameSite=None, so we force it on.
const baseCookieOptions = () => {
  const sameSite = (process.env.COOKIE_SAMESITE || 'strict').toLowerCase();
  const secure = sameSite === 'none'
    ? true
    : (process.env.COOKIE_SECURE !== undefined
        ? process.env.COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production');
  return { httpOnly: true, sameSite, secure };
};

const cookieOptions = () => ({
  ...baseCookieOptions(),
  maxAge: 7 * 24 * 60 * 60 * 1000,
});

// ─── Token helpers (tenant slug now lives in the JWT) ────────────────────────

const signAccess = (user, tenantSlug) => {
  const payload = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    tenantSlug,
  };
  if (['cashier', 'rider'].includes(user.role) && user.outlet) payload.outletCode = user.outlet;
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
};

const signRefresh = (user, tenantSlug) =>
  jwt.sign(
    { id: user._id, tenantSlug },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN }
  );

// Permissions an owner can never lose, regardless of stored overrides.
// Without these, an owner who accidentally toggles their own settings.users /
// settings.roles to "None" would brick their account — they'd have no way to
// undo it from the UI.
const OWNER_NON_REVOCABLE = ['settings.users', 'settings.roles'];

const buildEffectivePermissions = (user) => {
  const userObj = user.toObject();
  const rawPerms = userObj.permissions ?? {};
  const effective = {};
  for (const perm of PERMISSIONS) {
    const roleDefault = !!perm[user.role];
    effective[perm.key] = Object.prototype.hasOwnProperty.call(rawPerms, perm.key)
      ? !!rawPerms[perm.key]
      : roleDefault;
  }
  if (user.role === 'owner') {
    for (const k of OWNER_NON_REVOCABLE) effective[k] = true;
  }
  return { effective, userObj };
};

const sendTokens = async (user, tenantSlug, statusCode, res, tenant, options = {}) => {
  const { rotate = true, exposeRefresh = false } = options;
  const accessToken = signAccess(user, tenantSlug);

  let refreshToken;
  if (rotate) {
    refreshToken = signRefresh(user, tenantSlug);
    // Keep the token we're replacing valid for a short grace window so a
    // concurrent refresh that still holds it doesn't get rejected as reuse.
    user.previousRefreshToken = user.refreshToken || null;
    user.refreshToken = refreshToken;
    user.refreshTokenRotatedAt = new Date();
    await user.save({ validateBeforeSave: false });
  } else {
    // Grace-window hit: a concurrent refresh already rotated the token. Don't
    // rotate again — just mint a fresh access token and re-send the current
    // refresh cookie so this caller stays in sync.
    refreshToken = user.refreshToken;
  }

  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());

  const { effective, userObj } = buildEffectivePermissions(user);

  // Assigned users receive their outlet's flags. Owners receive an any-outlet
  // roll-up so modules remain discoverable while the page selects an outlet.
  const tenantFeatures = tenant ? resolveFeaturesForUser(tenant, user) : null;
  const tenantOutletFeatures = tenant ? outletFeatureMap(tenant) : {};
  const featureScopes = tenant?.featureScopes?.toObject?.()
    ?? tenant?.featureScopes
    ?? {};

  const payload = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: effective,
    posDiscountLimitPercent: Number.isFinite(Number(user.posDiscountLimitPercent))
      ? Number(user.posDiscountLimitPercent)
      : 100,
    sidebarPreferences: { hiddenTabs: userObj.sidebarPreferences?.hiddenTabs ?? [] },
    tenant: tenant
      ? {
          slug: tenant.slug,
          outletName: tenant.outletName,
          status: tenant.status,
          accessUntil: tenant.accessUntil,
          outletConfigured: tenant.outletConfigured,
          features: tenantFeatures,
          outletFeatures: tenantOutletFeatures,
          featureScopes,
        }
      : null,
  };
  if (user.outlet) {
    payload.outlet = user.outlet;
    payload.outletCode = user.outlet;
  }
  if (user.outletRef) payload.outletRef = user.outletRef;

  return res.status(statusCode).json({
    success: true,
    accessToken,
    ...(exposeRefresh ? { refreshToken } : {}),
    user: payload,
  });
};

// ─── Slug allocation ─────────────────────────────────────────────────────────

const allocateSlug = async (outletName) => {
  const base = sanitizeSlug(outletName) || 'outlet';
  let candidate = base;
  let suffix = 2;
  while (await TenantModel().exists({ slug: candidate })) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
};

// ─── signup ─────────────────────────────────────────────────────────────────

export const signup = async (req, res) => {
  const { outletName, ownerName, email, password } = req.body;

  const existingIndex = await UserIndexModel().findOne({ email }).lean();
  if (existingIndex) {
    return res.status(409).json({
      success: false,
      message: 'An account with this email already exists.',
    });
  }

  const slug = await allocateSlug(outletName);
  const trialDays = parseInt(process.env.TRIAL_DAYS || '14', 10);
  const accessUntil = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);

  const tenant = await TenantModel().create({
    slug,
    outletName,
    ownerEmail: email,
    ownerName,
    status: 'trial',
    accessUntil,
    outletConfigured: false,
    // Brand-new tenants start directly on the outlet-scoped model. Existing
    // tenants without this marker use the compatibility migration path.
    outletFeaturesMigratedAt: new Date(),
  });

  const conn = await getTenantConnectionFor(slug);

  return new Promise((resolve, reject) => {
    runWithTenant({ conn, slug }, () => {
      (async () => {
        try {
          await seedAccounts();

          const owner = await User.create({
            name: ownerName,
            email,
            password,
            role: 'owner',
            isActive: true,
          });

          await UserIndexModel().create({ email, tenantSlug: slug, role: 'owner' });

          logger.info(`Tenant created: slug=${slug} owner=${email}`);
          resolve(sendTokens(owner, slug, 201, res, tenant.toObject()));
        } catch (err) {
          logger.error(`Signup failed for ${email}: ${err.message}. Rolling back.`);
          try { await dropTenantDatabase(slug); } catch (e) { logger.error(`Rollback drop DB failed: ${e.message}`); }
          await TenantModel().deleteOne({ slug });
          await UserIndexModel().deleteOne({ email });
          reject(err);
        }
      })();
    });
  });
};

// ─── register (owner adds team member) ───────────────────────────────────────

export const register = async (req, res) => {
  const { name, email, password, role, outlet } = req.body;

  if (role === 'owner') {
    if (!req.user || req.user.role !== 'owner') {
      return res.status(403).json({
        success: false,
        message: 'Only an owner can register another owner account.',
      });
    }
  }

  const existingIndex = await UserIndexModel().findOne({ email }).lean();
  if (existingIndex) {
    return res.status(409).json({
      success: false,
      message: 'An account with this email already exists.',
    });
  }

  const userData = { name, email, password, role };

  if (outlet) {
    let outletDoc = null;
    if (mongoose.isValidObjectId(outlet)) {
      outletDoc = await Outlet.findById(outlet).lean();
    } else {
      outletDoc = await Outlet.findOne({ code: outlet.toUpperCase() }).lean();
    }
    if (!outletDoc) {
      return res.status(422).json({
        success: false,
        message: 'Outlet not found. Create the outlet first in Settings > Outlets.',
      });
    }
    if (!outletDoc.isActive) {
      return res.status(422).json({
        success: false,
        message: `Outlet '${outletDoc.name}' is inactive. Activate it before assigning cashiers.`,
      });
    }
    if (role === 'rider' && !isFeatureEnabledForOutlet(req.tenant, 'riderTracking', outletDoc._id)) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_DISABLED',
        message: 'Enable Rider Tracking & Dispatch for this outlet before creating rider users.',
      });
    }
    userData.outletRef = outletDoc._id;
    userData.outlet = outletDoc.code;
  }

  const user = await User.create(userData);
  await UserIndexModel().create({ email, tenantSlug: req.tenantSlug, role });

  logger.info(`New user registered: ${email} [${role}] in tenant=${req.tenantSlug}`);
  return sendTokens(user, req.tenantSlug, 201, res, req.tenant);
};

// ─── login (resolves tenant via platform UserIndex) ──────────────────────────

const findTenantForEmail = async (email) => {
  const indexDoc = await UserIndexModel().findOne({ email }).lean();
  if (!indexDoc) return null;
  const tenant = await TenantModel().findOne({ slug: indexDoc.tenantSlug }).lean();
  return tenant ? { tenant, slug: indexDoc.tenantSlug } : null;
};

const runLogin = async ({ email, password, posMode, riderMode, ip, device, location, userAgent }, res) => {
  const path = riderMode ? '/api/auth/rider-login' : posMode ? '/api/auth/pos-login' : '/api/auth/login';
  // Best-effort audit write; never let it break login. Every entry carries the
  // client origin (ip/device/location).
  const audit = (entry) => { AuditLog.create({ ip, device, location, userAgent, ...entry }).catch(() => {}); };

  const lookup = await findTenantForEmail(email);
  if (!lookup) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }
  const { tenant, slug } = lookup;
  const conn = await getTenantConnectionFor(slug);

  return new Promise((resolve, reject) => {
    runWithTenant({ conn, slug }, () => {
      (async () => {
        try {
          const user = await User.findOne({ email }).select('+password');
          if (!user) {
            audit({ action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 401, ip, source: 'auth', after: { email, reason: 'unknown_user' } });
            return resolve(res.status(401).json({ success: false, message: 'Invalid email or password.' }));
          }
          const ok = await user.comparePassword(password);
          if (!ok) {
            audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 401, ip, source: 'auth', after: { email, reason: 'bad_password' } });
            return resolve(res.status(401).json({ success: false, message: 'Invalid email or password.' }));
          }
          if (!user.isActive) {
            audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 401, ip, source: 'auth', after: { email, reason: 'deactivated' } });
            return resolve(res.status(401).json({ success: false, message: 'Account is deactivated.' }));
          }

          if (!riderMode && user.role === 'rider') {
            audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 403, ip, source: 'auth', after: { email, reason: 'rider_app_required' } });
            return resolve(res.status(403).json({ success: false, code: 'USE_RIDER_APP', message: 'Rider accounts can sign in only through the Cenciss Rider Android application.' }));
          }

          if (riderMode) {
            if (user.role !== 'rider') {
              audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 403, ip, source: 'auth', after: { email, reason: 'not_rider' } });
              return resolve(res.status(403).json({ success: false, code: 'RIDER_ACCOUNT_REQUIRED', message: 'Use a rider role account to sign in to the rider application.' }));
            }
            let outletId = user.outletRef || null;
            if (!outletId && user.outlet) {
              outletId = (await Outlet.findOne({ code: user.outlet }).select('_id').lean())?._id || null;
            }
            if (!outletId || !isFeatureEnabledForOutlet(tenant, 'riderTracking', outletId)) {
              audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login_failed', module: 'auth', method: 'POST', path, statusCode: 403, ip, source: 'auth', after: { email, reason: 'rider_tracking_disabled' } });
              return resolve(res.status(403).json({ success: false, code: 'FEATURE_DISABLED', message: 'Rider Tracking & Dispatch is not enabled for this outlet.' }));
            }
          }

          // Note: cashiers can log in here too. The POS terminal enforces its
          // own `pos.sale` permission check; the management UI sends them to
          // /terminal via AppGate. No global "no permissions = blocked" rule.

          audit({ user: user._id, actorName: user.name, actorRole: user.role, action: 'auth.login', module: 'auth', method: 'POST', path, statusCode: 200, ip, source: 'auth', after: { posMode: !!posMode } });
          logger.info(`User logged in: ${email} [tenant=${slug}]`);
          resolve(sendTokens(user, slug, 200, res, tenant, { exposeRefresh: riderMode === true }));
        } catch (err) {
          reject(err);
        }
      })();
    });
  });
};

export const login = (req, res) => runLogin({ ...req.body, posMode: false, ...clientInfo(req) }, res);
export const posLogin = (req, res) => runLogin({ ...req.body, posMode: true, ...clientInfo(req) }, res);
export const riderLogin = (req, res) => runLogin({ ...req.body, posMode: false, riderMode: true, ...clientInfo(req) }, res);

// ─── refresh ─────────────────────────────────────────────────────────────────

export const refresh = async (req, res) => {
  // Browser clients use the HttpOnly cookie. The sideloaded Android rider app
  // stores the returned token in the OS secure keystore and submits it here.
  const mobileRefresh = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
  const token = req.cookies?.[REFRESH_COOKIE] || mobileRefresh;
  if (!token) return res.status(401).json({ success: false, message: 'No refresh token.' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
  }
  if (!decoded.tenantSlug) {
    return res.status(401).json({ success: false, message: 'Token missing tenant context.' });
  }

  const tenant = await TenantModel().findOne({ slug: decoded.tenantSlug }).lean();
  if (!tenant) return res.status(401).json({ success: false, message: 'Tenant no longer exists.' });

  const conn = await getTenantConnectionFor(decoded.tenantSlug);

  return new Promise((resolve, reject) => {
    runWithTenant({ conn, slug: decoded.tenantSlug }, () => {
      (async () => {
        try {
          const user = await User.findById(decoded.id)
            .select('+refreshToken +previousRefreshToken +refreshTokenRotatedAt');
          if (!user) {
            return resolve(res.status(401).json({ success: false, message: 'Refresh token reuse detected.' }));
          }
          if (!user.isActive) {
            return resolve(res.status(401).json({ success: false, message: 'Account is deactivated.' }));
          }

          const matchesCurrent = user.refreshToken === token;
          const withinGrace = user.refreshTokenRotatedAt &&
            (Date.now() - new Date(user.refreshTokenRotatedAt).getTime()) < REFRESH_GRACE_MS;
          const matchesPrevious = Boolean(user.previousRefreshToken) &&
            user.previousRefreshToken === token && withinGrace;

          if (!matchesCurrent && !matchesPrevious) {
            return resolve(res.status(401).json({ success: false, message: 'Refresh token reuse detected.' }));
          }

          // Only rotate when the caller presented the current token. A grace-window
          // (previous-token) hit re-issues an access token without rotating again.
          resolve(sendTokens(user, decoded.tenantSlug, 200, res, tenant, {
            rotate: matchesCurrent,
            exposeRefresh: Boolean(mobileRefresh),
          }));
        } catch (err) {
          reject(err);
        }
      })();
    });
  });
};

// ─── logout ──────────────────────────────────────────────────────────────────

export const logout = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] || (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '');
  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      if (decoded?.tenantSlug) {
        const conn = await getTenantConnectionFor(decoded.tenantSlug);
        const info = clientInfo(req);
        await new Promise((resolve) => {
          runWithTenant({ conn, slug: decoded.tenantSlug }, () => {
            // Match by id (not just the current token) so a logout still clears
            // state when the cookie holds a within-grace previous token. Also
            // wipe the grace fields so no token survives the logout.
            User.findByIdAndUpdate(decoded.id, {
              refreshToken: null,
              previousRefreshToken: null,
              refreshTokenRotatedAt: null,
            })
              .then((u) => {
                AuditLog.create({
                  user: decoded.id,
                  actorName: u?.name ?? null,
                  actorRole: u?.role ?? null,
                  action: 'auth.logout',
                  module: 'auth',
                  method: 'POST',
                  path: '/api/auth/logout',
                  statusCode: 200,
                  source: 'auth',
                  ip: info.ip,
                  device: info.device,
                  location: info.location,
                  userAgent: info.userAgent,
                }).catch(() => {});
                resolve();
              })
              .catch(() => resolve());
          });
        });
      }
    } catch { /* ignore */ }
  }
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions());
  return res.json({ success: true, message: 'Logged out successfully.' });
};

// ─── forgotPassword ──────────────────────────────────────────────────────────

export const forgotPassword = async (req, res) => {
  const { email } = req.body;
  const lookup = await findTenantForEmail(email);
  if (!lookup) {
    return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  }

  const { slug } = lookup;
  const conn = await getTenantConnectionFor(slug);

  await new Promise((resolve, reject) => {
    runWithTenant({ conn, slug }, () => {
      (async () => {
        try {
          const user = await User.findOne({ email });
          if (user) {
            const plainToken = crypto.randomBytes(32).toString('hex');
            const hashed = crypto.createHash('sha256').update(plainToken).digest('hex');
            user.passwordResetToken = hashed;
            user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
            await user.save({ validateBeforeSave: false });
            const resetUrl = `${process.env.CLIENT_URL.split(',')[0]}/reset-password?token=${plainToken}`;
            logger.info(`[PASSWORD RESET] Reset URL for ${email}: ${resetUrl}`);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      })();
    });
  });
  return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
};

// ─── resetPassword ───────────────────────────────────────────────────────────

export const resetPassword = async (req, res) => {
  const { token, password } = req.body;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const tenants = await TenantModel().find().lean();
  for (const tenant of tenants) {
    const conn = await getTenantConnectionFor(tenant.slug);
    // eslint-disable-next-line no-await-in-loop
    const found = await new Promise((resolve, reject) => {
      runWithTenant({ conn, slug: tenant.slug }, () => {
        User.findOne({
          passwordResetToken: hashedToken,
          passwordResetExpires: { $gt: Date.now() },
        })
          .select('+passwordResetToken +passwordResetExpires')
          .then((user) => {
            if (!user) return resolve(null);
            user.password = password;
            user.isActive = true;
            user.passwordResetToken = undefined;
            user.passwordResetExpires = undefined;
            user.refreshToken = undefined;
            user.previousRefreshToken = undefined;
            user.refreshTokenRotatedAt = undefined;
            user.save().then(() => resolve({ user })).catch(reject);
          })
          .catch(reject);
      });
    });
    if (found) {
      logger.info(`Password reset successful for ${found.user.email}`);
      return res.json({ success: true, message: 'Password has been reset. Please log in.' });
    }
  }
  return res.status(400).json({ success: false, message: 'Reset token is invalid or has expired.' });
};

// ─── me ──────────────────────────────────────────────────────────────────────

export const me = async (req, res) => {
  const user = await User.findById(req.user.id).select(
    '-password -refreshToken -passwordResetToken -passwordResetExpires'
  );
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  // One-shot cleanup: if an owner has stale overrides on the non-revocable
  // permission keys, drop them. They were previously settable from
  // RoleSettings before the self-edit lock landed and can hide the tabs
  // owners need to recover.
  if (user.role === 'owner' && user.permissions) {
    const owned = user.permissions instanceof Map ? user.permissions : new Map(Object.entries(user.permissions));
    let dirty = false;
    for (const k of ['settings.users', 'settings.roles', 'settings___users', 'settings___roles']) {
      if (owned.has(k)) { owned.delete(k); dirty = true; }
    }
    if (dirty) {
      user.permissions = owned;
      try { await user.save({ validateBeforeSave: false }); } catch { /* best-effort */ }
    }
  }

  const { effective, userObj } = buildEffectivePermissions(user);

  return res.json({
    success: true,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      outlet: user.outlet,
      outletCode: user.outlet || null,
      permissions: effective,
      posDiscountLimitPercent: Number.isFinite(Number(user.posDiscountLimitPercent))
        ? Number(user.posDiscountLimitPercent)
        : 100,
      sidebarPreferences: { hiddenTabs: userObj.sidebarPreferences?.hiddenTabs ?? [] },
      tenant: req.tenant
        ? {
            slug: req.tenant.slug,
            outletName: req.tenant.outletName,
            status: req.tenant.status,
            accessUntil: req.tenant.accessUntil,
            outletConfigured: req.tenant.outletConfigured,
            features: resolveFeaturesForUser(req.tenant, req.user),
            outletFeatures: outletFeatureMap(req.tenant),
            featureScopes: req.tenant.featureScopes?.toObject?.()
              ?? req.tenant.featureScopes
              ?? {},
          }
        : null,
    },
  });
};
