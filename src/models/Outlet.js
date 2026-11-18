import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// ─── Sub-schema ────────────────────────────────────────────────────────────────

const addressSchema = new mongoose.Schema(
  {
    street:  { type: String, trim: true },
    city:    { type: String, trim: true },
    country: { type: String, trim: true },
  },
  { _id: false }
);

// Per-outlet sales-tax rates. Outlets can be different business natures
// (restaurant / retail / etc.), so each carries its own standard + reduced
// (card) rate. Left unset until the owner configures it — the tax service then
// falls back to the tenant-global TaxConfig, then to defaults, so behaviour is
// unchanged for outlets that have never been edited.
const outletTaxSchema = new mongoose.Schema(
  {
    standardRate: { type: Number, min: 0, max: 100 },
    cardRate: { type: Number, min: 0, max: 100 },
    cardReducedEnabled: { type: Boolean },
    // Unset means inherit. Existing outlets without this field keep the legacy
    // reduced-rate behaviour through the global/default value.
    onlineReducedEnabled: { type: Boolean },
    // Default service-charge percentage for this outlet. Used to auto-fill the
    // per-item service charge (MenuItem.serviceCharge) when creating new menu
    // items — the per-item value stays authoritative at sale time.
    serviceChargeRate: { type: Number, min: 0, max: 100 },
    // Which order types this outlet charges service charge on. The per-item
    // service-charge rate (MenuItem.serviceCharge) only applies when the sale's
    // order type is listed here. Unset (undefined) means "inherit the tenant
    // global default"; an empty array means "no service charge on any type".
    serviceChargeOrderTypes: {
      type: [String],
      enum: ['dine-in', 'takeaway', 'delivery'],
      default: undefined,
    },
  },
  { _id: false }
);

// Per-outlet FBR (Pakistan) Digital Invoicing config. Each outlet can be a
// different business/registration, so seller identity + default item codes live
// here. Tokens are stored ENCRYPTED (see utils/secretBox). When disabled or
// missing a token for the active mode, the outlet's sales are not reported.
const outletFbrSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    sellerNTNCNIC: { type: String, trim: true },
    sellerBusinessName: { type: String, trim: true },
    sellerProvince: { type: String, trim: true },
    sellerAddress: { type: String, trim: true },
    mode: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    sandboxToken: { type: String },     // encrypted at rest
    productionToken: { type: String },  // encrypted at rest
    // Sandbox posting requires a scenario id from the seller's IRIS portal.
    sandboxScenarioId: { type: String, trim: true },
    // Default item classification for this outlet's business nature; a menu item
    // may override via MenuItem.fbr.
    defaultHsCode: { type: String, trim: true },
    defaultSaleType: { type: String, trim: true },
    defaultUoM: { type: String, trim: true },
  },
  { _id: false }
);

// Per-outlet Punjab Revenue Authority eIMS configuration. PRA issues a POS ID
// and bearer token for each registered POS. Sandbox and production identifiers
// are kept separately because the PRA portal generates a dedicated Test POS ID.
// Tokens are encrypted at rest by the PRA settings controller.
const outletPraSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    mode: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
    sandboxPosId: { type: Number, min: 1 },
    productionPosId: { type: Number, min: 1 },
    sandboxToken: { type: String },
    productionToken: { type: String },
    // Eight-character service classification from the Second Schedule of the
    // Punjab Sales Tax on Services Act. A menu item may override this value.
    defaultPctCode: { type: String, trim: true, maxlength: 8 },
  },
  { _id: false }
);

// Customer-facing table QR settings. Bank details are deliberately stored as
// ordinary outlet configuration because they are meant to be displayed to
// guests; no private banking credentials or API secrets belong here.
const qrCustomerPaymentSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    bankName: { type: String, trim: true, maxlength: 120, default: '' },
    accountTitle: { type: String, trim: true, maxlength: 120, default: '' },
    accountNumber: { type: String, trim: true, maxlength: 80, default: '' },
    iban: { type: String, trim: true, uppercase: true, maxlength: 50, default: '' },
    instructions: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { _id: false }
);

// A customer-facing preparation area (for example Kitchen, Bar or Desserts).
// Existing Menu Management categories are assigned to exactly one area and
// each area carries its own estimate. The order takes a snapshot when its
// kitchen ticket is confirmed, so later settings changes cannot rewrite an
// estimate that a guest is already watching.
const qrPreparationCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    preparationMinutes: { type: Number, min: 0, max: 240, required: true },
    menuCategoryIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' }],
      default: [],
    },
  },
  { timestamps: false }
);

const qrOrderingSchema = new mongoose.Schema(
  {
    preparationMinutes: { type: Number, min: 0, max: 240, default: 20 },
    preparationCategories: { type: [qrPreparationCategorySchema], default: [] },
    customerPayment: { type: qrCustomerPaymentSchema, default: () => ({}) },
  },
  { _id: false }
);

const kdsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    warningMinutes: { type: Number, min: 1, max: 240, default: 15 },
    criticalMinutes: { type: Number, min: 1, max: 240, default: 25 },
  },
  { _id: false },
);

const riderOutletPointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value)
          && value.length === 2
          && value.every(Number.isFinite),
        message: 'Outlet coordinates must be [longitude, latitude].',
      },
    },
  },
  { _id: false },
);

const riderTrackingSchema = new mongoose.Schema(
  {
    location: { type: riderOutletPointSchema, default: undefined },
    geofenceRadiusMeters: { type: Number, min: 50, max: 2000, default: 150 },
    locationRetentionDays: { type: Number, min: 7, max: 730, default: 90 },
    staleAfterSeconds: { type: Number, min: 30, max: 900, default: 120 },
    // Optional operational report. Off by default so outlets that do not rate
    // riders keep their current screens and workflow unchanged.
    performanceEnabled: { type: Boolean, default: false },
  },
  { _id: false },
);

// ─── Outlet schema ─────────────────────────────────────────────────────────────

const outletSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Outlet name is required.'],
      trim: true,
    },
    code: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
      // populated by pre-save hook — do not set manually
    },
    address: addressSchema,
    phone: {
      type: String,
      trim: true,
    },
    timezone: {
      type: String,
      trim: true,
      default: 'Asia/Karachi',
    },
    // Local clock time at which a new operating day begins. For example,
    // 05:00 means sales from midnight through 04:59 belong to the prior day.
    businessDayStart: {
      type: String,
      trim: true,
      default: '00:00',
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Business day start must be HH:mm.'],
    },
    businessDayEnd: {
      type: String,
      trim: true,
      default: '00:00',
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Business day end must be HH:mm.'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Per-outlet sales-tax rates (see outletTaxSchema). Optional — unset means
    // "inherit the tenant-global rates".
    tax: outletTaxSchema,
    // Legacy federal DI configuration retained only so old tenant documents can
    // still be read during the PRA rollout. New invoices use `pra` below.
    fbr: outletFbrSchema,
    // Punjab Revenue Authority eIMS fiscal-invoicing configuration.
    pra: outletPraSchema,
    // Public self-order experience configuration for this outlet.
    qrOrdering: { type: qrOrderingSchema, default: () => ({}) },
    // Owner-controlled, per-outlet KDS switch. Default OFF preserves every
    // existing tenant's POS and printing behaviour until explicitly enabled.
    kds: { type: kdsSchema, default: () => ({}) },
    riderTracking: { type: riderTrackingSchema, default: () => ({}) },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

outletSchema.index({ name: 'text', code: 'text' });
outletSchema.index({ isActive: 1 });
outletSchema.index({ 'riderTracking.location': '2dsphere' });

// ─── Helper: derive base code from name ───────────────────────────────────────

const baseCode = (name) => {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const suffix = Date.now().toString().slice(-4);
  return `${initials}-${suffix}`;
};

// ─── Pre-save: auto-generate unique outlet code ───────────────────────────────

outletSchema.pre('save', async function () {
  if (!this.isNew || this.code) return;

  const candidate = baseCode(this.name);
  const exists = await this.constructor.findOne({ code: candidate }).lean();

  if (!exists) {
    this.code = candidate;
    return;
  }

  let counter = 1;
  let unique = false;
  while (!unique) {
    const withCounter = `${candidate}-${counter}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await this.constructor.findOne({ code: withCounter }).lean();
    if (!clash) {
      this.code = withCounter;
      unique = true;
    } else {
      counter++;
    }
  }
});

const Outlet = defineModel('Outlet', outletSchema);

export default Outlet;
