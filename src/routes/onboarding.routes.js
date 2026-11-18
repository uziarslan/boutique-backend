import { Router } from 'express';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import Outlet from '../models/Outlet.js';
import { TenantModel } from '../platform/models/Tenant.js';
import logger from '../utils/logger.js';
import { ensureOutletFeatureAssignments } from '../services/outletFeatures.service.js';
import { cacheDel, tenantKey } from '../utils/requestCache.js';

const router = Router();

// POST /api/onboarding/outlet — completes the post-signup outlet wizard.
// Creates the first Outlet doc in the tenant DB and flips
// platform.tenants.outletConfigured to true so the management app stops
// redirecting the owner to /onboarding.
router.post('/outlet', protect, authorize('owner'), async (req, res) => {
  const { name, code, address, phone, timezone, currency } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(422).json({ success: false, message: 'Outlet name is required.' });
  }

  let normalizedCode;
  if (code != null && String(code).trim().length > 0) {
    normalizedCode = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9-]{2,32}$/.test(normalizedCode)) {
      return res.status(422).json({
        success: false,
        message: 'Outlet code may only contain letters, numbers, and dashes (2–32 chars).',
      });
    }
    const codeClash = await Outlet.findOne({ code: normalizedCode }).lean();
    if (codeClash) {
      return res.status(409).json({
        success: false,
        message: 'That outlet code is already in use. Please choose another.',
      });
    }
  }

  // Allow re-running the wizard if no outlet exists yet, otherwise reject.
  const existing = await Outlet.findOne().lean();
  if (existing) {
    return res.status(409).json({
      success: false,
      message: 'An outlet has already been configured for this account.',
    });
  }

  const outlet = await Outlet.create({
    name: name.trim(),
    ...(normalizedCode ? { code: normalizedCode } : {}),
    address: address || {},
    phone: phone || '',
    timezone: timezone || 'Asia/Karachi',
    createdBy: req.user.id,
  });

  const tenant = await TenantModel().findOne({ slug: req.tenantSlug });
  if (tenant) {
    tenant.outletConfigured = true;
    tenant.outletName = outlet.name;
    await ensureOutletFeatureAssignments(tenant, [outlet], {
      completeMigration: false,
      updatedBy: req.user?.email || 'tenant-owner',
      save: false,
    });
    await tenant.save();
    cacheDel(tenantKey(req.tenantSlug));
  }

  logger.info(`Outlet wizard completed: tenant=${req.tenantSlug} outlet=${outlet.code}`);
  return res.status(201).json({ success: true, outlet, currency: currency || null });
});

export default router;
