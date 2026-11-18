import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import {
  isFeatureEnabledForOutlet,
  resolveAggregateOutletFeatures,
} from '../services/outletFeatures.service.js';
import logger from '../utils/logger.js';

/**
 * Resolves :tenantSlug from the URL, opens the tenant connection, and runs
 * the rest of the request inside that tenant's context. Used for public
 * endpoints (no JWT) that still need to read/write tenant data.
 *
 * Also enforces the requested feature against the outlet code carried by the
 * public URL. Routes without an outlet code use the safe any-outlet roll-up.
 */
const tenantFromSlug = (featureKey) => async (req, res, next) => {
  const slug = req.params.tenantSlug;
  if (!slug) return res.status(400).json({ success: false, message: 'Missing tenant slug.' });

  try {
    const tenant = await TenantModel().findOne({ slug }).lean();
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found.' });
    }
    if (tenant.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'This restaurant is currently unavailable.' });
    }
    const outletCode = req.params.outletCode;
    const enabled = !featureKey
      || (outletCode
        ? isFeatureEnabledForOutlet(tenant, featureKey, outletCode)
        : resolveAggregateOutletFeatures(tenant)[featureKey] === true);
    if (!enabled) {
      logger.warn(
        `[publicTenant] feature '${featureKey}' not enabled for tenant '${slug}' ` +
        `outlet='${outletCode || 'any'}'.`
      );
      return res.status(403).json({ success: false, message: 'This restaurant does not accept self-orders.' });
    }

    const conn = await getTenantConnectionFor(slug);
    req.tenantSlug = slug;
    req.tenantOutletName = tenant.outletName;

    runWithTenant({ conn, slug }, () => next());
  } catch (err) {
    logger.error(`[publicTenant] failed for ${slug}: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Could not load restaurant.' });
  }
};

export default tenantFromSlug;
