import {
  isFeatureEnabledForOutlet,
  outletFeatureMap,
} from './outletFeatures.service.js';

const legacyEnabledIds = (tenant) => (
  tenant?.featureScopes?.assetAudit?.enabledOutletIds
  ?? tenant?.featureScopes?.get?.('assetAudit')?.enabledOutletIds
  ?? []
).map(String);

export const enabledAssetAuditOutletIds = (tenant) => {
  const outletFeatures = outletFeatureMap(tenant);
  if (tenant?.outletFeaturesMigratedAt && Object.keys(outletFeatures).length) {
    return Object.entries(outletFeatures)
      .filter(([, features]) => features.assetAudit === true)
      .map(([outletId]) => outletId);
  }
  return legacyEnabledIds(tenant);
};

export const isAssetAuditEnabledForOutlet = (tenant, outletId) => {
  if (!outletId) return false;
  if (tenant?.outletFeaturesMigratedAt) {
    return isFeatureEnabledForOutlet(tenant, 'assetAudit', outletId);
  }
  return legacyEnabledIds(tenant).includes(String(outletId));
};

export const sendAssetAuditDisabled = (res) => res.status(403).json({
  success: false,
  code: 'FEATURE_DISABLED',
  message: 'Asset Register & Audit is not enabled for this outlet. Contact your administrator.',
});

export const requireAssetAuditOutlet = (req, res, outletId) => {
  if (isAssetAuditEnabledForOutlet(req.tenant, outletId)) return true;
  sendAssetAuditDisabled(res);
  return false;
};
