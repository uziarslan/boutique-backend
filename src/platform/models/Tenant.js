import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';
import { DEFAULT_FEATURES } from '../../config/features.js';

const outletFeatureAssignmentSchema = new mongoose.Schema(
  {
    // Outlet documents live in the tenant database, so platform stores their
    // identifiers as strings rather than cross-database ObjectId references.
    outletId: { type: String, required: true, trim: true },
    outletCode: { type: String, trim: true, uppercase: true, default: '' },
    features: { type: Map, of: Boolean, default: () => ({ ...DEFAULT_FEATURES }) },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const billingConfigSchema = new mongoose.Schema(
  {
    recurringAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'PKR', uppercase: true, trim: true },
    cycle: {
      type: String,
      enum: ['monthly', 'quarterly', 'annual', 'custom'],
      default: 'monthly',
    },
    extensionDays: { type: Number, default: 30, min: 1, max: 3660 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    billingEmail: { type: String, lowercase: true, trim: true, default: '' },
    remindersEnabled: { type: Boolean, default: false },
    paymentInstructions: { type: String, trim: true, default: '' },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const tenantSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    outletName: { type: String, required: true, trim: true },
    ownerEmail: { type: String, required: true, lowercase: true, trim: true },
    ownerName: { type: String, trim: true },
    // Shopify webhook routing hint. The app credentials remain
    // encrypted in the tenant database; the platform registry stores only the
    // normalized shop domain needed to find the tenant before HMAC validation.
    shopifyDomain: { type: String, lowercase: true, trim: true, default: undefined },

    // 'trial' | 'active' | 'suspended' | 'expired'
    status: { type: String, enum: ['trial', 'active', 'suspended', 'expired'], default: 'trial' },
    // Hard cutoff. null = no access. The subscription provider checks this.
    accessUntil: { type: Date, default: null },

    // True once the post-signup outlet wizard has been completed in the
    // tenant DB. Until then the management app routes the user to /onboarding.
    outletConfigured: { type: Boolean, default: false },

    // Optional notes the super-admin can leave on a tenant record.
    notes: { type: String, default: '' },

    // Platform-owned subscription billing configuration. This is deliberately
    // kept outside tenant databases so it remains available after access ends.
    // Existing tenants start with reminders OFF until an admin reviews the
    // negotiated amount and recipient.
    billing: { type: billingConfigSchema, default: () => ({}) },

    // Legacy tenant-wide flags. Kept as a compatibility roll-up while older
    // application instances and production data transition to outletFeatures.
    // New admin writes are outlet-scoped and update this map only as an "any
    // outlet enabled" projection; it is no longer the source of truth.
    features: { type: Map, of: Boolean, default: () => ({ ...DEFAULT_FEATURES }) },

    // Source of truth for feature entitlements. Each row is a complete snapshot
    // for one outlet, which makes reads deterministic and avoids a partial-map
    // accidentally inheriting a future default.
    outletFeatures: { type: [outletFeatureAssignmentSchema], default: [] },
    outletFeaturesMigratedAt: { type: Date, default: null },

    // Legacy Asset Audit scope retained for rolling-deployment compatibility.
    // It mirrors outletFeatures.assetAudit and can be removed after every
    // production consumer has moved to the generic outlet feature model.
    featureScopes: {
      assetAudit: {
        enabledOutletIds: { type: [String], default: [] },
        updatedAt: { type: Date, default: null },
        updatedBy: { type: String, trim: true, default: '' },
      },
    },
  },
  { timestamps: true }
);

tenantSchema.index({ ownerEmail: 1 });
tenantSchema.index(
  { shopifyDomain: 1 },
  { unique: true, partialFilterExpression: { shopifyDomain: { $type: 'string' } } },
);

let cached = null;
export const TenantModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('Tenant', tenantSchema);
  return cached;
};
