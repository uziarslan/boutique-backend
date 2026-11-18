import jwt from 'jsonwebtoken';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  isFeatureEnabledForOutlet,
  isFeatureEnabledForUser,
  resolveAggregateOutletFeatures,
} from '../services/outletFeatures.service.js';

const requestOutlet = (req) => (
  req.user?.outletRef
  ?? req.user?.outletCode
  ?? req.user?.outlet
  ?? req.attendanceDevice?.outletId
  ?? req.attendanceDevice?.outletCode
  ?? req.headers?.['x-outlet-id']
  ?? req.query?.outletId
  ?? req.query?.outlet
  ?? req.body?.outletId
  ?? req.body?.outlet
  ?? req.params?.outletId
  ?? req.params?.outletCode
  ?? null
);

/**
 * requireFeature(key) — route-level guard for outlet feature flags.
 *
 * A user assigned to an outlet is checked against that outlet. Owner/global
 * requests with no outlet context are allowed when at least one outlet has the
 * feature, preserving list/report workflows that select an outlet inside the
 * page. Endpoints carrying outlet/outletId are checked against that target.
 */
export const requireFeature = (featureKey) => {
  const featureGuard = async (req, res, next) => {
    try {
      let tenant = req.tenant;

      if (!tenant) {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) return next();

        const token = authHeader.slice(7);
        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
        catch { return next(); }

        if (!decoded?.tenantSlug) return next();

        tenant = await TenantModel().findOne({ slug: decoded.tenantSlug }).lean();
        if (!tenant) return next();
      }

      const outlet = requestOutlet(req);
      const enabled = outlet
        ? isFeatureEnabledForOutlet(tenant, featureKey, outlet)
        : req.user
          ? isFeatureEnabledForUser(tenant, featureKey, req.user)
          : resolveAggregateOutletFeatures(tenant)[featureKey] === true;

      if (!enabled) {
        return res.status(403).json({
          success: false,
          code: 'FEATURE_DISABLED',
          message: 'This feature is not enabled for this outlet. Contact your administrator.',
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };

  // Exposed on the middleware for route diagnostics and regression tests.
  featureGuard.featureKey = featureKey;
  return featureGuard;
};
