import { Router } from 'express';
import crypto from 'crypto';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import User from '../models/User.js';
import SaleSession from '../models/SaleSession.js';
import logger from '../utils/logger.js';
import sendTemplateEmail from '../services/mailtrap.js';
import { UserIndexModel } from '../platform/models/UserIndex.js';
import { cacheDel, userKey } from '../utils/requestCache.js';
import Outlet from '../models/Outlet.js';
import { isFeatureEnabledForOutlet } from '../services/outletFeatures.service.js';

const router = Router();

// Helpers to store permission keys safely in Mongo (dots are not allowed in keys)
const safeKey = (k) => String(k).replaceAll('.', '___');
const restoreKey = (k) => String(k).replaceAll('___', '.');
const sanitizePermissionsForSave = (perms) => {
  if (!perms || typeof perms !== 'object') return perms;
  const out = {};
  Object.entries(perms).forEach(([k, v]) => {
    out[safeKey(k)] = !!v;
  });
  return out;
};
const restorePermissionsForResponse = (perms) => {
  if (!perms) return perms;
  // perms may be a Map-like object or plain object
  const out = {};
  try {
    const entries = Object.entries(perms);
    entries.forEach(([k, v]) => {
      out[restoreKey(k)] = !!v;
    });
  } catch (e) {
    return perms;
  }
  return out;
};

const riderRoleAllowed = (req, role, outlet) => {
  if (role !== 'rider') return true;
  return Boolean(outlet?._id && isFeatureEnabledForOutlet(req.tenant, 'riderTracking', outlet._id));
};

// Convert role identifiers like `receivingManager` -> `Receiving manager`
const humanizeRole = (r) => {
  if (!r) return r;
  try {
    const spaced = String(r).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  } catch (e) {
    return r;
  }
};

// All routes require authentication first
router.use(protect);

// GET /api/users — list all users (requires settings.users OR settings.roles permission)
router.get('/', async (req, res, next) => {
  if (!req.user || typeof req.user.hasPermission !== 'function') {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }
  if (!req.user.hasPermission('settings.users') && !req.user.hasPermission('settings.roles')) {
    return res.status(403).json({ success: false, message: 'Forbidden.' });
  }
  return next();
}, async (req, res) => {
  const query = req.user.role !== 'owner' ? { role: { $ne: 'owner' } } : {};
  const users = await User.find(query).select('-refreshToken -passwordResetToken -passwordResetExpires').sort({ createdAt: -1 }).lean();

  // Restore dotted permission keys — do NOT humanize role (role must remain camelCase for
  // client-side permission lookups against the PERMISSIONS table).
  const normalized = users.map((u) => {
    if (u && u.permissions) {
      u.permissions = restorePermissionsForResponse(u.permissions);
    }
    return u;
  });

  res.json({
    success: true,
    data: { users: normalized },
  });
});

// PATCH /api/users/me/profile — update own profile (name only; email/role are protected)
router.patch('/me/profile', async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Name is required.' });
  }
  if (name.trim().length > 120) {
    return res.status(400).json({ success: false, message: 'Name is too long.' });
  }
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { name: name.trim() },
    { returnDocument: 'after', runValidators: true }
  ).select('-password -refreshToken -passwordResetToken -passwordResetExpires').lean();
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  cacheDel(userKey(req.user.id, req.tenantSlug)); // name is part of the cached auth payload
  res.json({ success: true, data: { user } });
});

// POST /api/users/me/change-password — verify current password then set a new one
router.post('/me/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Current and new password are required.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ success: false, message: 'New password must be different from current password.' });
  }
  const user = await User.findById(req.user.id).select('+password');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const ok = await user.comparePassword(currentPassword);
  if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
  user.password = newPassword;
  user.refreshToken = undefined;
  await user.save();
  logger.info(`Password changed by user ${user.email}`);
  res.json({ success: true, message: 'Password updated.' });
});

// PATCH /api/users/me/sidebar-preferences — let any authenticated user update their own
// sidebar tab visibility. Body: { hiddenTabs: ['/vendors', '/reports/cogs', ...] }
router.patch('/me/sidebar-preferences', async (req, res) => {
  const { hiddenTabs } = req.body ?? {};
  if (!Array.isArray(hiddenTabs) || !hiddenTabs.every((t) => typeof t === 'string')) {
    return res.status(400).json({ success: false, message: 'hiddenTabs must be an array of strings.' });
  }
  const cleaned = [...new Set(hiddenTabs.map((t) => t.trim()).filter(Boolean))];

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { sidebarPreferences: { hiddenTabs: cleaned } },
    { returnDocument: 'after', runValidators: true }
  ).select('-password -refreshToken -passwordResetToken -passwordResetExpires').lean();

  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  res.json({
    success: true,
    data: { sidebarPreferences: { hiddenTabs: user.sidebarPreferences?.hiddenTabs ?? [] } },
  });
});

// PATCH /api/users/:id — toggle isActive or update role/outlet/permissions (requires settings.users permission)
router.patch('/:id', requirePermission('settings.users'), async (req, res) => {
  const { isActive, role, outlet, permissions, posDiscountLimitPercent } = req.body;
  const targetUser = await User.findById(req.params.id).select('role outlet outletRef').lean();
  if (!targetUser) return res.status(404).json({ success: false, message: 'User not found.' });

  // Prevent a user from deactivating their own account
  const isSelf = String(req.params.id) === String(req.user.id);
  if (isSelf && typeof isActive === 'boolean' && isActive === false) {
    return res.status(403).json({ success: false, message: 'You cannot deactivate your own account.' });
  }

  // Self-edit guard: an owner cannot change their own role or permissions —
  // they could lock themselves out of the very screens that fix it. To
  // change anything here, ask another owner.
  if (isSelf && (permissions !== undefined || role !== undefined || posDiscountLimitPercent !== undefined)) {
    return res.status(403).json({
      success: false,
      message: 'You cannot change your own role or permissions.',
    });
  }

  // Only owners can modify per-user permission overrides or change roles
  if (permissions !== undefined && req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only owners can modify user permissions.' });
  }
  if (role !== undefined && req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only owners can change user roles.' });
  }
  if (posDiscountLimitPercent !== undefined && req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only owners can change POS discount limits.' });
  }

  // Non-owners cannot edit owner accounts
  if (req.user.role !== 'owner') {
    if (targetUser.role === 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can edit owner accounts.' });
    }
  }

  // Log incoming payload for debugging
  try {
    const logger = await import('../utils/logger.js');
    logger.default.info(`[users.patch] id=${req.params.id} payload=${JSON.stringify({ isActive, role, outlet, permissions, posDiscountLimitPercent })}`);
  } catch (e) { }

  const allowed = {};
  if (typeof isActive === 'boolean') allowed.isActive = isActive;
  if (role) allowed.role = role;
  if (posDiscountLimitPercent !== undefined) {
    const limit = Number(posDiscountLimitPercent);
    if (!Number.isFinite(limit) || limit < 0 || limit > 100) {
      return res.status(400).json({ success: false, message: 'Discount limit must be between 0 and 100 percent.' });
    }
    allowed.posDiscountLimitPercent = Math.round(limit * 100) / 100;
  }
  if (outlet !== undefined) {
    // Resolve outlet: accept ObjectId or code string, store both outlet (code) and outletRef (ObjectId)
    try {
      const mongoose = await import('mongoose');
      let outletDoc = null;
      if (mongoose.default.isValidObjectId(outlet)) {
        outletDoc = await Outlet.findById(outlet).lean();
      } else if (outlet) {
        outletDoc = await Outlet.findOne({ code: String(outlet).toUpperCase() }).lean();
      }
      if (outletDoc) {
        if (!riderRoleAllowed(req, role || targetUser.role, outletDoc)) {
          return res.status(403).json({ success: false, code: 'FEATURE_DISABLED', message: 'Enable Rider Tracking & Dispatch for this outlet before assigning the rider role.' });
        }
        allowed.outlet = outletDoc.code;
        allowed.outletRef = outletDoc._id;
      } else if ((role || targetUser.role) === 'rider') {
        return res.status(422).json({ success: false, message: 'A valid outlet is required for rider users.' });
      } else {
        allowed.outlet = outlet;
      }
    } catch (e) {
      if ((role || targetUser.role) === 'rider') throw e;
      allowed.outlet = outlet;
    }
  }

  // Changing only the role must still validate the target user's existing
  // outlet. Otherwise the outlet entitlement could be bypassed.
  if (role === 'rider' && outlet === undefined) {
    const existingOutlet = targetUser.outletRef
      ? await Outlet.findById(targetUser.outletRef).lean()
      : targetUser.outlet
        ? await Outlet.findOne({ code: String(targetUser.outlet).toUpperCase() }).lean()
        : null;
    if (!riderRoleAllowed(req, role, existingOutlet)) {
      return res.status(403).json({ success: false, code: 'FEATURE_DISABLED', message: 'Enable Rider Tracking & Dispatch for this user’s outlet before assigning the rider role.' });
    }
  }

  if (Object.keys(allowed).length === 0 && permissions === undefined) {
    return res.status(400).json({ success: false, message: 'No valid fields provided.' });
  }

  let user;
  if (permissions !== undefined) {
    // Two-step atomic update: first wipe the entire Map, then write the new keys.
    // A plain $set on a Mongoose Map only updates/adds keys — it never removes old ones.
    const sanitized = sanitizePermissionsForSave(permissions);
    await User.updateOne({ _id: req.params.id }, { $unset: { permissions: '' } });
    user = await User.findByIdAndUpdate(
      req.params.id,
      { ...allowed, permissions: sanitized },
      { returnDocument: 'after', runValidators: true }
    ).select('-refreshToken -passwordResetToken -passwordResetExpires').lean();
  } else {
    user = await User.findByIdAndUpdate(req.params.id, allowed, { returnDocument: 'after', runValidators: true })
      .select('-refreshToken -passwordResetToken -passwordResetExpires').lean();
  }

  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  // Drop the cached auth payload so the new role/permissions/outlet/isActive take
  // effect on the target user's very next request instead of after the TTL.
  cacheDel(userKey(req.params.id, req.tenantSlug));

  if (user && user.permissions) user.permissions = restorePermissionsForResponse(user.permissions);
  // Role is returned as-is (camelCase) — display formatting is the client's responsibility.

  try {
    const logger = await import('../utils/logger.js');
    logger.default.info(`[users.patch] saved user=${req.params.id} permissions=${JSON.stringify(user.permissions || {})}`);
  } catch (e) { }

  res.json({ success: true, data: { user } });
});

// POST /api/users — create a user as admin (requires settings.users permission)
router.post('/', requirePermission('settings.users'), async (req, res) => {
  const { name, email, password, role, outlet, isActive } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'Name, email, password and role are required.' });
  }

  const exists = await User.findOne({ email }).lean();
  if (exists) {
    return res.status(409).json({ success: false, message: 'A user with that email already exists.' });
  }

  // Default admin-created users to active unless explicitly provided
  const userData = { name, email, password, role, outlet, isActive: isActive === undefined ? true : !!isActive };

  // Resolve every assigned user's outlet to both code and ObjectId. Feature
  // entitlements are outlet-scoped, so managers need the same typed assignment
  // cashiers have always used.
  if (outlet) {
    try {
      const mongoose = await import('mongoose');
      let outletDoc = null;
      if (mongoose.default.isValidObjectId(outlet)) {
        outletDoc = await Outlet.findById(outlet).lean();
      } else {
        outletDoc = await Outlet.findOne({ code: String(outlet).toUpperCase() }).lean();
      }
      if (!outletDoc) {
        return res.status(422).json({ success: false, message: `Outlet not found. Create the outlet first in Settings > Outlets.` });
      }
      if (!outletDoc.isActive) {
        return res.status(422).json({ success: false, message: `Outlet '${outletDoc.name}' is inactive. Activate it before assigning cashiers.` });
      }
      if (!riderRoleAllowed(req, role, outletDoc)) {
        return res.status(403).json({ success: false, code: 'FEATURE_DISABLED', message: 'Enable Rider Tracking & Dispatch for this outlet before creating rider users.' });
      }
      userData.outletRef = outletDoc._id;
      userData.outlet = outletDoc.code;
    } catch (e) {
      // fallback — continue without outlet resolution
      if (role === 'rider') throw e;
    }
  }

  // Enforce that only owners may be created without an outlet
  if (role !== 'owner' && (!outlet || String(outlet).trim() === '')) {
    return res.status(422).json({ success: false, message: 'Outlet is required for non-owner users.' });
  }

  // Email must be globally unique across the platform.
  const platformDup = await UserIndexModel().findOne({ email }).lean();
  if (platformDup) {
    return res.status(409).json({ success: false, message: 'A user with that email already exists.' });
  }

  const user = await User.create(userData);
  await UserIndexModel().create({ email, tenantSlug: req.tenantSlug, role });

  const uobj = user.toObject ? user.toObject() : user;
  // remove sensitive fields
  delete uobj.password;
  delete uobj.refreshToken;
  delete uobj.passwordResetToken;
  delete uobj.passwordResetExpires;

  if (uobj && uobj.permissions) uobj.permissions = restorePermissionsForResponse(uobj.permissions);
  // Role is returned as-is (camelCase) — display formatting is the client's responsibility.

  return res.status(201).json({
    success: true, data: {
      user: {
        id: uobj._id,
        name: uobj.name,
        email: uobj.email,
        role: uobj.role,
        outlet: uobj.outlet,
        isActive: uobj.isActive,
        createdAt: uobj.createdAt,
        permissions: uobj.permissions || {},
      }
    }
  });
});

// POST /api/users/invite — create a user and return an invite link (requires settings.users permission)
router.post('/invite', requirePermission('settings.users'), async (req, res) => {
  const { name, email, role, outlet } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ success: false, message: 'Name, email and role are required.' });
  }

  const exists = await User.findOne({ email }).lean();
  if (exists) {
    return res.status(409).json({ success: false, message: 'A user with that email already exists.' });
  }
  const platformDup = await UserIndexModel().findOne({ email }).lean();
  if (platformDup) {
    return res.status(409).json({ success: false, message: 'A user with that email already exists.' });
  }

  // Resolve outlet: accept ObjectId or code string
  let outletName = '';
  let outletRefId = undefined;
  let outletCode = outlet;
  if (outlet) {
    try {
      const mongoose = await import('mongoose');
      let outletDoc = null;
      if (mongoose.default.isValidObjectId(outlet)) {
        outletDoc = await Outlet.findById(outlet).lean();
      } else {
        outletDoc = await Outlet.findOne({ code: String(outlet).toUpperCase() }).lean();
      }
      if (outletDoc) {
        if (!riderRoleAllowed(req, role, outletDoc)) {
          return res.status(403).json({ success: false, code: 'FEATURE_DISABLED', message: 'Enable Rider Tracking & Dispatch for this outlet before inviting rider users.' });
        }
        outletName = outletDoc.name;
        outletRefId = outletDoc._id;
        outletCode = outletDoc.code;
      } else if (role === 'rider') {
        return res.status(422).json({ success: false, message: 'A valid outlet is required for rider users.' });
      }
    } catch (e) {
      // ignore — continue without resolved outlet
      if (role === 'rider') throw e;
    }
  }

  // Generate a one-time invite token (plain token will be included in the URL)
  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  // Create a user with a random password and attach the reset token so they can set a password via the link
  const randomPassword = crypto.randomBytes(12).toString('hex');
  const createPayload = {
    name,
    email,
    password: randomPassword,
    role,
    isActive: false,
    passwordResetToken: hashedToken,
    passwordResetExpires: expires,
  };
  // Enforce that only owners may be created without an outlet (additional server-side guard)
  if (role !== 'owner' && !outletRefId && !outlet) {
    return res.status(422).json({ success: false, message: 'Outlet is required for non-owner users.' });
  }
  if (outletRefId) {
    createPayload.outletRef = outletRefId;
    createPayload.outlet = outletCode;
  } else if (outlet) {
    // keep whatever was passed (likely a code)
    createPayload.outlet = outlet;
  }

  const user = await User.create(createPayload);
  await UserIndexModel().create({ email, tenantSlug: req.tenantSlug, role });

  // Use explicit DOMAIN env var when available, fallback to CLIENT_URL
  const host = process.env.DOMAIN || process.env.CLIENT_URL;
  const inviteUrl = `${host}/set-password?token=${plainToken}`;
  logger.info(`[INVITE] Invite URL for ${email}: ${inviteUrl}`);
  // Prepare template variables
  const companyName = outletName || 'Cenciss';
  const supportEmail = process.env.SUPPORT_EMAIL || process.env.MAILTRAP_SENDER_EMAIL || 'support@cenciss.com';
  const domain = process.env.DOMAIN || (process.env.CLIENT_URL || '').split(',')[0] || '';
  const variables = {
    companyName,
    role: humanizeRole(role),
    firstName: (name || '').split(' ')[0] || name,
    outletName: outletName || outletCode || '',
    inviteUrl,
    expiresAt: expires.toUTCString(),
    inviterName: req.user?.name || req.user?.email || 'Admin',
    supportEmail,
    outletCode: outletCode || '',
    currentYear: String(new Date().getFullYear()),
  };

  // Attempt to send invite email (non-blocking on success)
  try {
    await sendTemplateEmail({ to: email, variables });
    logger.info(`[INVITE] Sent invite email to ${email}`);
  } catch (err) {
    logger.error(`[INVITE] Failed to send invite email to ${email}: ${err.message || err}`);
  }

  return res.json({ success: true, data: { inviteUrl } });
});

// POST /api/users/:id/invite — generate an invite/reset link for an existing user (requires settings.users permission)
router.post('/:id/invite', requirePermission('settings.users'), async (req, res) => {
  const userId = req.params.id;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  // Generate a one-time token for setting password
  const plainToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  user.passwordResetToken = hashedToken;
  user.passwordResetExpires = expires;
  // ensure user remains inactive until they set password (admin can activate)
  user.isActive = false;
  await user.save({ validateBeforeSave: false });

  // Resolve outlet name if present on the user
  let outletName = '';
  try {
    if (user.outletRef) {
      const Outlet = await import('../models/Outlet.js');
      const outletDoc = await Outlet.default.findById(user.outletRef).lean();
      if (outletDoc) outletName = outletDoc.name;
    } else if (user.outlet) {
      const Outlet = await import('../models/Outlet.js');
      const outletDoc = await Outlet.default.findOne({ code: String(user.outlet).toUpperCase() }).lean();
      if (outletDoc) outletName = outletDoc.name;
    }
  } catch (e) {
    // ignore resolution errors
  }

  const host = process.env.DOMAIN || process.env.CLIENT_URL;
  const inviteUrl = `${host}/set-password?token=${plainToken}`;
  logger.info(`[INVITE] Invite URL for ${user.email}: ${inviteUrl}`);
  // Prepare template variables
  const companyName = process.env.COMPANY_NAME || 'Cenciss';
  const supportEmail = process.env.SUPPORT_EMAIL || process.env.MAILTRAP_SENDER_EMAIL || 'support@cenciss.com';
  const domain = process.env.DOMAIN || (process.env.CLIENT_URL || '').split(',')[0] || '';
  const variables = {
    companyName,
    role: humanizeRole(user.role),
    firstName: (user.name || '').split(' ')[0] || user.name,
    outletName: outletName || user.outlet || '',
    inviteUrl,
    expiresAt: expires.toUTCString(),
    inviterName: req.user?.name || req.user?.email || 'Admin',
    supportEmail,
    domain,
    currentYear: String(new Date().getFullYear()),
  };

  try {
    await sendTemplateEmail({ to: user.email, variables });
    logger.info(`[INVITE] Sent invite email to ${user.email}`);
  } catch (err) {
    logger.error(`[INVITE] Failed to send invite email to ${user.email}: ${err.message || err}`);
  }

  return res.json({ success: true, data: { inviteUrl } });
});

// DELETE /api/users/:id — permanently delete a user (owner-only)
router.delete('/:id', authorize('owner'), async (req, res) => {
  // Require explicit hard delete query to avoid accidental deletes in UI
  const hard = String(req.query.hard) === 'true';
  if (!hard) {
    return res.status(400).json({ success: false, message: 'To permanently delete a user set ?hard=true. Use PATCH to deactivate a user.' });
  }

  const user = await User.findById(req.params.id).select('-refreshToken -passwordResetToken -passwordResetExpires');
  if (!user) {
    return res.status(404).json({ success: false, message: 'User not found.' });
  }

  // Older sessions predate cashier-name snapshots. Preserve their label before
  // removing the account, without changing any shift status or cash records.
  await SaleSession.updateMany(
    { cashier: user._id, $or: [{ cashierName: { $exists: false } }, { cashierName: null }, { cashierName: '' }] },
    { $set: { cashierName: user.name } },
  );
  await User.deleteOne({ _id: user._id });
  cacheDel(userKey(req.params.id, req.tenantSlug)); // evict any cached auth payload for the deleted user
  if (user.email) {
    await UserIndexModel().deleteOne({ email: user.email });
  }

  // restore permission keys if present
  const uobj = user.toObject ? user.toObject() : user;
  if (uobj && uobj.permissions) uobj.permissions = restorePermissionsForResponse(uobj.permissions);

  res.json({ success: true, data: { user: uobj } });
});

export default router;
