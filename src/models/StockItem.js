import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const stockItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product is required.'],
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    qtyOnHand: {
      type: Number,
      default: 0,
    },
    unit: {
      type: String,
      trim: true,
    },
    lastCountDate:     { type: Date },
    lastCountQty:      { type: Number },
    lastCountVariance: { type: Number },
    // Free-text shelf/bin label (e.g. "Cold Room 2"). Distinct from `area`.
    location:          { type: String, trim: true },
    // Which holding area this balance lives in. Purchases can land in the
    // `store` (buffer) and are later issued to the `kitchen`, where all
    // consumption (sales, waste, prep, counts) happens. Default 'kitchen' keeps
    // every pre-existing row and single-location outlet behaving as before.
    area: {
      type: String,
      enum: ['store', 'kitchen'],
      default: 'kitchen',
    },
  },
  {
    timestamps: true,
    // updatedAt is included via timestamps
  }
);

// Unique stock entry per product+outlet+area combination. NOTE: the legacy
// { product, outlet } unique index must be dropped by the migration
// (scripts/migrateStockArea.js) or store+kitchen rows for the same product
// cannot coexist.
stockItemSchema.index({ product: 1, outlet: 1, area: 1 }, { unique: true });
stockItemSchema.index({ outlet: 1, area: 1 });

const StockItem = defineModel('StockItem', stockItemSchema);

export default StockItem;
