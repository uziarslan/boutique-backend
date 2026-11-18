import {
  DEFAULT_FEATURES,
  FEATURES,
  resolveTenantFeatures,
} from '../config/features.js';

const FEATURE_KEYS = FEATURES.map((feature) => feature.key);
const VALID_FEATURE_KEYS = new Set(FEATURE_KEYS);

const mapToObject = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.toObject === 'function') return value.toObject();
  return value;
};

const assignmentsFrom = (tenant) => {
  const rows = tenant?.outletFeatures;
  return Array.isArray(rows) ? rows : [];
};

const legacyAssetOutletIds = (tenant) => {
  const raw = tenant?.featureScopes?.assetAudit?.enabledOutletIds
    ?? tenant?.featureScopes?.get?.('assetAudit')?.enabledOutletIds
    ?? [];
  return new Set((raw || []).map(String));
};

const outletIdentity = (outlet) => ({
  id: String(outlet?._id ?? outlet?.id ?? outlet?.outletId ?? ''),
  code: String(outlet?.code ?? outlet?.outletCode ?? '').trim().toUpperCase(),
});

const findAssignment = (tenant, outletIdOrCode) => {
  if (!outletIdOrCode) return null;
  const needle = String(outletIdOrCode).trim();
  const upperNeedle = needle.toUpperCase();
  return assignmentsFrom(tenant).find((row) => (
    String(row?.outletId ?? '') === needle
    || (row?.outletCode && String(row.outletCode).toUpperCase() === upperNeedle)
  )) || null;
};

export const normalizeFeatureSnapshot = (raw, fallback = DEFAULT_FEATURES) => {
  const stored = mapToObject(raw);
  const normalized = {};
  for (const key of FEATURE_KEYS) {
    normalized[key] = Object.prototype.hasOwnProperty.call(stored, key)
      ? stored[key] === true
      : fallback[key] === true;
  }
  return normalized;
};

const legacySnapshotForOutlet = (tenant, outletId) => {
  const snapshot = normalizeFeatureSnapshot(resolveTenantFeatures(tenant?.features));

  // Asset Audit already had outlet-level production data before the generic
  // model. Preserve that exact scope while materializing the new snapshots.
  if (tenant?.featureScopes?.assetAudit) {
    snapshot.assetAudit = legacyAssetOutletIds(tenant).has(String(outletId));
  }
  return snapshot;
};

/**
 * Resolve one outlet's effective flags.
 *
 * Before a tenant is migrated, a missing row inherits the legacy tenant flags
 * (and the old Asset Audit scope). After migration, a missing/new outlet gets
 * canonical defaults. That is the compatibility boundary that prevents an
 * existing production outlet losing access while ensuring new outlets do not
 * silently inherit another outlet's approvals.
 */
export const resolveOutletFeatures = (tenant, outletIdOrCode) => {
  const assignment = findAssignment(tenant, outletIdOrCode);
  if (assignment) return normalizeFeatureSnapshot(assignment.features);

  if (!tenant?.outletFeaturesMigratedAt) {
    return legacySnapshotForOutlet(tenant, outletIdOrCode);
  }
  return normalizeFeatureSnapshot(DEFAULT_FEATURES);
};

export const resolveAggregateOutletFeatures = (tenant) => {
  const rows = assignmentsFrom(tenant);
  if (!tenant?.outletFeaturesMigratedAt) {
    const legacy = normalizeFeatureSnapshot(resolveTenantFeatures(tenant?.features));
    if (tenant?.featureScopes?.assetAudit) {
      legacy.assetAudit = legacyAssetOutletIds(tenant).size > 0;
    }
    return legacy;
  }
  if (!rows.length) return normalizeFeatureSnapshot(DEFAULT_FEATURES);

  const snapshots = rows.map((row) => normalizeFeatureSnapshot(row.features));
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, snapshots.some((snapshot) => snapshot[key] === true)])
  );
};

export const outletFeatureMap = (tenant) => Object.fromEntries(
  assignmentsFrom(tenant)
    .filter((row) => row?.outletId)
    .map((row) => [String(row.outletId), normalizeFeatureSnapshot(row.features)])
);

export const resolveFeaturesForUser = (tenant, user) => {
  const outlet = user?.outletRef ?? user?.outletCode ?? user?.outlet;
  return outlet
    ? resolveOutletFeatures(tenant, outlet)
    : resolveAggregateOutletFeatures(tenant);
};

export const isFeatureEnabledForOutlet = (tenant, featureKey, outletIdOrCode) => (
  VALID_FEATURE_KEYS.has(featureKey)
  && resolveOutletFeatures(tenant, outletIdOrCode)[featureKey] === true
);

export const isFeatureEnabledForUser = (tenant, featureKey, user) => (
  VALID_FEATURE_KEYS.has(featureKey)
  && resolveFeaturesForUser(tenant, user)[featureKey] === true
);

/**
 * Idempotently materialize complete outlet snapshots on a Mongoose Tenant doc.
 * Pass completeMigration=true only when `outlets` is the tenant's complete
 * outlet list. Existing assignment rows are never overwritten.
 */
export const ensureOutletFeatureAssignments = async (
  tenant,
  outlets,
  { completeMigration = false, updatedBy = 'system:migration', save = true } = {},
) => {
  if (!tenant || typeof tenant.save !== 'function') {
    throw new TypeError('A writable Tenant document is required.');
  }

  const wasMigrated = Boolean(tenant.outletFeaturesMigratedAt);
  if (!Array.isArray(tenant.outletFeatures)) tenant.outletFeatures = [];
  const existing = new Map(
    assignmentsFrom(tenant).map((row) => [String(row.outletId), row])
  );
  let changed = false;

  for (const outlet of outlets || []) {
    const { id, code } = outletIdentity(outlet);
    if (!id) continue;

    const row = existing.get(id);
    if (row) {
      if (code && String(row.outletCode || '').toUpperCase() !== code) {
        row.outletCode = code;
        changed = true;
      }
      continue;
    }

    const snapshot = wasMigrated
      ? normalizeFeatureSnapshot(DEFAULT_FEATURES)
      : legacySnapshotForOutlet(tenant, id);
    tenant.outletFeatures.push({
      outletId: id,
      outletCode: code,
      features: snapshot,
      updatedAt: new Date(),
      updatedBy,
    });
    changed = true;
  }

  if (completeMigration && !tenant.outletFeaturesMigratedAt) {
    tenant.outletFeaturesMigratedAt = new Date();
    changed = true;
  }

  if (changed) {
    tenant.markModified('outletFeatures');
    if (save) await tenant.save();
  }
  return changed;
};

export const setOutletFeatureValues = (tenant, outletId, values, updatedBy = '') => {
  const row = findAssignment(tenant, outletId);
  if (!row) throw new Error(`Outlet feature assignment not found for ${outletId}.`);

  const snapshot = normalizeFeatureSnapshot(row.features);
  for (const [key, value] of Object.entries(values || {})) {
    if (VALID_FEATURE_KEYS.has(key)) snapshot[key] = value === true;
  }

  row.features = snapshot;
  row.updatedAt = new Date();
  row.updatedBy = updatedBy;
  tenant.markModified('outletFeatures');
  return snapshot;
};

/**
 * Maintain the old tenant map and Asset Audit list as compatibility projections
 * for older application instances during a rolling production deployment.
 */
export const syncLegacyFeatureProjections = (tenant) => {
  const aggregate = resolveAggregateOutletFeatures(tenant);
  if (!(tenant.features instanceof Map)) tenant.features = new Map();
  for (const key of FEATURE_KEYS) tenant.features.set(key, aggregate[key] === true);

  const assetOutletIds = assignmentsFrom(tenant)
    .filter((row) => normalizeFeatureSnapshot(row.features).assetAudit === true)
    .map((row) => String(row.outletId));

  tenant.set('featureScopes.assetAudit.enabledOutletIds', assetOutletIds);
  tenant.set('featureScopes.assetAudit.updatedAt', new Date());
  tenant.markModified('features');
  tenant.markModified('featureScopes');
  return aggregate;
};

export const knownFeatureKeys = () => [...FEATURE_KEYS];
