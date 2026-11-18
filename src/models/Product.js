import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import { normalizeLegacyProductPriceHistory } from '../utils/productPriceHistory.js';

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const priceHistorySchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: ['vendor', 'purchase', 'purchaseAdjustment', 'manual'], default: 'manual' },
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
    purchaseAdjustment: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseAdjustment' },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    legacyGrnId: { type: mongoose.Schema.Types.ObjectId },
  },
  { _id: false }
);

const vendorEntrySchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    vendorProductCode: { type: String, trim: true },
    packSize: { type: String, trim: true },
    currentPrice: { type: Number, default: 0, min: 0 },
    lastPrice: { type: Number, default: 0, min: 0 },
    priceHistory: { type: [priceHistorySchema], default: [] },
  },
  { _id: false }
);

// ─── Product schema ───────────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required.'],
      trim: true,
    },
    sku: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
      // populated by pre-save hook
    },
    category: {
      type: String,
      required: [true, 'Category is required.'],
      trim: true,
    },
    // 'standard' = a normal purchased ingredient/raw material.
    // 'prep'     = the stockable backing product for a Prep Recipe (marination,
    //              sauce…). It is produced in-house rather than bought, and its
    //              currentPrice holds the computed cost-per-unit of the recipe.
    kind: {
      type: String,
      enum: ['standard', 'prep'],
      default: 'standard',
    },
    unit: {
      type: String,
      required: [true, 'Unit of measure is required.'],
      trim: true,
    },
    storageLocation: { type: String, trim: true },
    shelfLifeDays: { type: Number, min: 0 },
    packSize: { type: String, trim: true },
    defaultPrice: { type: Number, default: 0, min: 0 },
    currentPrice: { type: Number, default: 0, min: 0 },
    lastPrice: { type: Number, default: 0, min: 0 },
    priceHistory: { type: [priceHistorySchema], default: [] },
    vendors: { type: [vendorEntrySchema], default: [] },
    parLevel: { type: Number, default: 0, min: 0 },
    reorderQty: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

productSchema.index({ name: 'text', sku: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ 'vendors.vendorId': 1 });

// ─── SKU generation helper ────────────────────────────────────────────────────

const generateSku = (category) => {
  const prefix = category.trim().toUpperCase().replace(/[^A-Z]/gi, '').slice(0, 3).padEnd(3, 'X');
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}-${datePart}-${rand}`;
};

// ─── Pre-save: auto-generate unique SKU ──────────────────────────────────────

productSchema.pre('save', async function () {
  if (!this.isNew || this.sku) return;

  let candidate = generateSku(this.category);
  let attempts = 0;

  // Retry with fresh random on collision (extremely rare)
  while (await this.constructor.exists({ sku: candidate })) {
    candidate = generateSku(this.category);
    if (++attempts > 10) {
      throw new Error('Could not generate a unique SKU. Please retry.');
    }
  }

  this.sku = candidate;
});

// Older GRN history was migrated to unified purchases. A small number of rows
// can still carry `source: "grn"` when their original GRN was not represented
// in the migration map. Normalize them before enum validation on any product
// save, while retaining the old identifier only as historical lineage.
productSchema.pre('validate', function () {
  normalizeLegacyProductPriceHistory(this);
});

const Product = defineModel('Product', productSchema);

export default Product;
