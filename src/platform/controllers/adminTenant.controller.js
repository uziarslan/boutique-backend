import { TenantModel } from '../models/Tenant.js';
import { UserIndexModel } from '../models/UserIndex.js';
import {
  getTenantConnectionFor,
  dropTenantDatabase,
} from '../../db/connections.js';
import { runWithTenant } from '../../db/tenantContext.js';
import User from '../../models/User.js';
import Outlet from '../../models/Outlet.js';
import logger from '../../utils/logger.js';
import { FEATURES } from '../../config/features.js';
import { cacheDel, tenantKey } from '../../utils/requestCache.js';
import { ensureAssetDefaults } from '../../services/assetDefaults.service.js';
import DeliveryAssignment from '../../models/DeliveryAssignment.js';
import KdsOrder from '../../models/KdsOrder.js';
import RiderDevice from '../../models/RiderDevice.js';
import RiderEvent from '../../models/RiderEvent.js';
import RiderShift from '../../models/RiderShift.js';
import SaleTransaction from '../../models/SaleTransaction.js';
import { emitRiderEvent } from '../../services/riderTracking.service.js';
import {
  ensureOutletFeatureAssignments,
  outletFeatureMap,
  resolveAggregateOutletFeatures,
  resolveOutletFeatures,
  setOutletFeatureValues,
  syncLegacyFeatureProjections,
} from '../../services/outletFeatures.service.js';

const sanitize = (t) => {
  const featureScopes = t.featureScopes?.toObject?.() ?? t.featureScopes ?? {};
  return {
    id: t._id,
    slug: t.slug,
    outletName: t.outletName,
    ownerEmail: t.ownerEmail,
    ownerName: t.ownerName,
    status: t.status,
    accessUntil: t.accessUntil,
    outletConfigured: t.outletConfigured,
    notes: t.notes,
    billing: t.billing?.toObject?.() ?? t.billing ?? {},
    // `features` remains an aggregate compatibility projection for older
    // clients; outletFeatures is the authoritative per-outlet data.
    features: resolveAggregateOutletFeatures(t),
    outletFeatures: outletFeatureMap(t),
    outletFeaturesMigratedAt: t.outletFeaturesMigratedAt || null,
    featureScopes,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
};

const runInTenant = async (slug, callback) => {
  const conn = await getTenantConnectionFor(slug);
  return new Promise((resolve, reject) => {
    runWithTenant({ conn, slug }, () => {
      Promise.resolve(callback()).then(resolve, reject);
    });
  });
};

const loadTenantOutlets = (slug) => runInTenant(
  slug,
  () => Outlet.find().select('name code isActive pra').sort({ name: 1 }).lean(),
);

const disableRiderTrackingForOutlet = async (tenantSlug, outletId, actorName) => runInTenant(
  tenantSlug,
  async () => {
    const now = new Date();
    const shifts = await RiderShift.find({ outlet: outletId, status: 'active' }).select('_id rider').lean();
    await Promise.all([
      RiderShift.updateMany(
        { outlet: outletId, status: 'active' },
        { $set: { status: 'feature_disabled', endedAt: now, endReason: `Feature disabled by ${actorName}` } },
      ),
      RiderDevice.updateMany({ outlet: outletId }, { $set: { trackingEnabled: false, lastSeenAt: now } }),
      DeliveryAssignment.updateMany(
        { outlet: outletId, active: true },
        {
          $set: { active: false, status: 'cancelled', completedAt: now },
          $push: { statusHistory: { status: 'cancelled', at: now, actorName, reason: 'Rider Tracking & Dispatch was disabled.' } },
        },
      ),
      SaleTransaction.updateMany(
        { outlet: outletId, assignedRiderUser: { $ne: null } },
        { $set: { assignedRiderUser: null }, $unset: { riderDeliveryStatus: '' } },
      ),
      KdsOrder.updateMany(
        { outlet: outletId, assignedRiderUser: { $ne: null } },
        { $set: { assignedRiderUser: null, assignedRiderName: '' } },
      ),
    ]);
    if (shifts.length) {
      await RiderEvent.insertMany(shifts.map((shift) => ({
        rider: shift.rider,
        outlet: outletId,
        shift: shift._id,
        type: 'feature_disabled',
        at: now,
        metadata: { actorName },
      })));
    }
  },
);

export const listTenants = async (req, res) => {
  const { search } = req.query;
  const filter = {};
  if (search) {
    const re = new RegExp(String(search).trim(), 'i');
    filter.$or = [{ outletName: re }, { ownerEmail: re }, { slug: re }];
  }
  const tenants = await TenantModel().find(filter).sort({ createdAt: -1 }).lean();
  return res.json({ success: true, tenants: tenants.map(sanitize) });
};

export const getTenant = async (req, res) => {
  const tenant = await TenantModel().findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  // Pull a small set of stats + the outlet list (with PRA status) from the
  // tenant DB so the console can show which outlets report sales to PRA.
  let stats = { users: 0, outlets: 0 };
  let outlets = [];
  try {
    const snapshot = await runInTenant(tenant.slug, async () => {
      const [users, outletDocs] = await Promise.all([
        User.countDocuments(),
        Outlet.find().select('name code isActive pra').sort({ name: 1 }).lean(),
      ]);
      return { users, outletDocs };
    });

    // Safe lazy migration: existing tenant-wide values are copied as complete
    // snapshots to every current outlet. Existing Asset Audit outlet approvals
    // are preserved by ensureOutletFeatureAssignments.
    try {
      await ensureOutletFeatureAssignments(tenant, snapshot.outletDocs, {
        completeMigration: true,
        updatedBy: req.admin.email || 'platform-admin',
      });
    } catch (err) {
      // Reading the admin page should remain available even if a platform write
      // is temporarily unavailable. Effective values still resolve through the
      // legacy fallback and the next request retries the idempotent migration.
      logger.warn(`Outlet feature migration deferred for ${tenant.slug}: ${err.message}`);
    }

    outlets = snapshot.outletDocs.map((outlet) => {
      const features = resolveOutletFeatures(tenant, outlet._id);
      return {
        id: String(outlet._id),
        name: outlet.name,
        code: outlet.code,
        isActive: outlet.isActive !== false,
        features,
        // Kept for an older admin bundle during rolling deployments.
        assetAuditEnabled: features.assetAudit === true,
        // Never expose encrypted PRA tokens.
        praEnabled: !!outlet.pra?.enabled,
        praMode: outlet.pra?.mode || 'sandbox',
      };
    });
    stats = { users: snapshot.users, outlets: snapshot.outletDocs.length };
  } catch (err) {
    logger.warn(`Could not load outlets for ${tenant.slug}: ${err.message}`);
  }

  return res.json({
    success: true,
    tenant: sanitize(tenant),
    stats,
    outlets,
    featureDefinitions: FEATURES,
  });
};

export const updateTenant = async (req, res) => {
  const { id } = req.params;
  const { status, accessUntil, notes, outletName } = req.body;
  const update = {};
  if (status) {
    if (!['trial', 'active', 'suspended', 'expired'].includes(status)) {
      return res.status(422).json({ success: false, message: 'Invalid status.' });
    }
    update.status = status;
  }
  if (accessUntil !== undefined) {
    update.accessUntil = accessUntil ? new Date(accessUntil) : null;
  }
  if (notes !== undefined) update.notes = String(notes);
  if (outletName) update.outletName = String(outletName);

  const tenant = await TenantModel().findByIdAndUpdate(id, update, { returnDocument: 'after' }).lean();
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  cacheDel(tenantKey(tenant.slug)); // status/accessUntil are cached by auth — evict
  logger.info(`Tenant updated by admin ${req.admin.email}: slug=${tenant.slug} update=${JSON.stringify(update)}`);
  return res.json({ success: true, tenant: sanitize(tenant) });
};

export const grantAccess = async (req, res) => {
  // Convenience endpoint — set accessUntil to a date and flip status to 'active'.
  const { id } = req.params;
  const { accessUntil } = req.body;
  if (!accessUntil) {
    return res.status(422).json({ success: false, message: 'accessUntil date required.' });
  }
  const tenant = await TenantModel().findByIdAndUpdate(
    id,
    { accessUntil: new Date(accessUntil), status: 'active' },
    { returnDocument: 'after' }
  ).lean();
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  cacheDel(tenantKey(tenant.slug));
  logger.info(`Admin granted access: tenant=${tenant.slug} until=${accessUntil}`);
  return res.json({ success: true, tenant: sanitize(tenant) });
};

export const suspendTenant = async (req, res) => {
  const tenant = await TenantModel().findByIdAndUpdate(
    req.params.id,
    { status: 'suspended' },
    { returnDocument: 'after' }
  ).lean();
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  cacheDel(tenantKey(tenant.slug));
  logger.info(`Admin suspended tenant: ${tenant.slug}`);
  return res.json({ success: true, tenant: sanitize(tenant) });
};

export const deleteTenant = async (req, res) => {
  const tenant = await TenantModel().findById(req.params.id).lean();
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  // Hard delete: drop the tenant DB and remove platform records. Irreversible.
  try {
    await dropTenantDatabase(tenant.slug);
  } catch (err) {
    logger.error(`Drop DB failed for ${tenant.slug}: ${err.message}`);
  }
  await UserIndexModel().deleteMany({ tenantSlug: tenant.slug });
  await TenantModel().deleteOne({ _id: tenant._id });

  cacheDel(tenantKey(tenant.slug));
  logger.info(`Admin deleted tenant: ${tenant.slug}`);
  return res.json({ success: true });
};

export const updateFeatures = async (req, res) => {
  const { features } = req.body;
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    return res.status(422).json({ success: false, message: 'features must be a key-value object.' });
  }

  const validKeys = new Set(FEATURES.map((f) => f.key));
  const tenant = await TenantModel().findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const validValues = Object.fromEntries(
    Object.entries(features)
      .filter(([key]) => validKeys.has(key))
      .map(([key, value]) => [key, value === true])
  );
  const outletDocs = await loadTenantOutlets(tenant.slug);

  await ensureOutletFeatureAssignments(tenant, outletDocs, {
    completeMigration: true,
    updatedBy: req.admin.email || 'platform-admin',
    save: false,
  });

  if (outletDocs.length) {
    for (const outlet of outletDocs) {
      setOutletFeatureValues(
        tenant,
        outlet._id,
        validValues,
        req.admin.email || 'platform-admin',
      );
    }
    syncLegacyFeatureProjections(tenant);
  } else {
    // No outlet exists yet. Preserve the old endpoint's behavior for a rolling
    // admin deployment; the onboarding outlet will inherit these values.
    for (const [key, value] of Object.entries(validValues)) tenant.features.set(key, value);
    tenant.markModified('features');
  }

  if (validValues.assetAudit === true) {
    await runInTenant(tenant.slug, () => ensureAssetDefaults());
  }
  if (validValues.riderTracking === false) {
    for (const outlet of outletDocs) {
      await disableRiderTrackingForOutlet(tenant.slug, outlet._id, req.admin.email || 'platform-admin');
    }
  }
  await tenant.save();

  cacheDel(tenantKey(tenant.slug));
  if (validValues.riderTracking === false) {
    for (const outlet of outletDocs) {
      emitRiderEvent({ tenantSlug: tenant.slug, outletId: outlet._id, event: 'rider-tracking:disabled', payload: { outletId: String(outlet._id), at: new Date() } });
    }
  }
  logger.info(
    `Legacy bulk feature update applied to all outlets for tenant ${tenant.slug} ` +
    `by admin ${req.admin.email}: ${JSON.stringify(validValues)}`
  );
  return res.json({ success: true, tenant: sanitize(tenant.toObject()) });
};

// PATCH /api/admin/tenants/:id/outlets/:outletId/features
// Body: { features: { [featureKey]: boolean } }
export const updateOutletFeatures = async (req, res) => {
  const { id, outletId } = req.params;
  const requested = req.body?.features;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    return res.status(422).json({
      success: false,
      message: 'features must be a key-value object.',
    });
  }

  const validKeys = new Set(FEATURES.map((feature) => feature.key));
  const values = Object.fromEntries(
    Object.entries(requested)
      .filter(([key]) => validKeys.has(key))
      .map(([key, value]) => [key, value === true])
  );
  if (!Object.keys(values).length) {
    return res.status(422).json({ success: false, message: 'No valid feature flags provided.' });
  }

  const tenant = await TenantModel().findById(id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const outletDocs = await loadTenantOutlets(tenant.slug);
  const outlet = outletDocs.find((row) => String(row._id) === String(outletId));
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  if (values.assetAudit === true) {
    await runInTenant(tenant.slug, () => ensureAssetDefaults());
  }
  if (values.riderTracking === false) {
    await disableRiderTrackingForOutlet(tenant.slug, outlet._id, req.admin.email || 'platform-admin');
  }

  await ensureOutletFeatureAssignments(tenant, outletDocs, {
    completeMigration: true,
    updatedBy: req.admin.email || 'platform-admin',
    save: false,
  });
  const snapshot = setOutletFeatureValues(
    tenant,
    outlet._id,
    values,
    req.admin.email || 'platform-admin',
  );
  syncLegacyFeatureProjections(tenant);
  tenant.set('featureScopes.assetAudit.updatedBy', req.admin.email || String(req.admin._id || 'admin'));
  await tenant.save();

  cacheDel(tenantKey(tenant.slug));
  if (values.riderTracking === false) {
    emitRiderEvent({ tenantSlug: tenant.slug, outletId: outlet._id, event: 'rider-tracking:disabled', payload: { outletId: String(outlet._id), at: new Date() } });
  }
  logger.info(
    `Outlet features updated for tenant=${tenant.slug} outlet=${outlet.code || outlet._id} ` +
    `by admin=${req.admin.email}: ${JSON.stringify(values)}`
  );

  return res.json({
    success: true,
    tenant: sanitize(tenant.toObject()),
    outlet: {
      id: String(outlet._id),
      name: outlet.name,
      code: outlet.code,
      isActive: outlet.isActive !== false,
      features: snapshot,
      assetAuditEnabled: snapshot.assetAudit === true,
    },
  });
};

// Compatibility route for an older admin bundle that exposed Asset Audit as a
// separate per-outlet switch.
export const updateAssetAuditOutlet = async (req, res) => {
  req.body = { features: { assetAudit: req.body?.enabled === true } };
  return updateOutletFeatures(req, res);
};
