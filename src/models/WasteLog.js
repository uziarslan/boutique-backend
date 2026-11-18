import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const wasteLogSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      // Not required when source is 'saleOrder' (no individual product link)
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    qty: {
      type: Number,
      default: 0,
      min: 0,
    },
    unit: {
      type: String,
      trim: true,
    },
    reason: {
      type: String,
      enum: ['spoilage', 'spillage', 'overProduction', 'theft', 'expired', 'other', 'orderVoid'],
      required: [true, 'Waste reason is required.'],
    },
    costAtTime: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    // How totalCost was valued for management waste reporting. Ingredient cost
    // remains the accounting basis even when the restaurant chooses to view the
    // loss at the order's final billed value.
    valuationMethod: {
      type: String,
      enum: ['ingredientCost', 'orderValue'],
      default: 'ingredientCost',
    },
    // Re-preparation (source 'saleOrder' only) ──────────────────────────────────
    // True when the wasted order was cooked AGAIN for the customer. When set, the
    // recipe was deducted from stock a second time (so on-hand stays exact) and
    // reMakeCost records the ingredient cost of that second batch (for display —
    // it is NOT a separate journal entry; the re-made batch's cost remains in
    // Purchase Expense as the cost of the food the customer actually received).
    rePrepared: {
      type: Boolean,
      default: false,
    },
    reMakeCost: {
      type: Number,
      default: 0,
      min: 0,
    },
    // True when this event wasted only a subset of the order's items/quantity
    // (partial waste) rather than the whole order in one go.
    partial: {
      type: Boolean,
      default: false,
    },
    // Source tracking ─────────────────────────────────────────────────────────
    // 'manual'    → logged manually via the waste log form (default)
    // 'saleOrder' → created from a punched POS sale transaction marked as loss
    source: {
      type: String,
      enum: ['manual', 'saleOrder'],
      default: 'manual',
    },
    // Reference to the POS sale that was voided as waste (set when source = 'saleOrder')
    saleTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SaleTransaction',
      default: null,
    },
    // Snapshot of sale order items (for display on waste log when source = 'saleOrder')
    saleOrderSnapshot: {
      transactionNumber: String,
      // Full order sale total (entire order, not just the wasted subset) — for display context.
      saleTotal: Number,
      // ingredientCost = calculated recipe cost; orderValue = the line's
      // proportional share of the final billed order value.
      items: [{ name: String, variation: { id: mongoose.Schema.Types.ObjectId, name: String }, qty: Number, unitPrice: Number, lineTotal: Number, ingredientCost: Number, orderValue: Number, usingFallback: Boolean }],
      // Ingredient cost is retained as the accounting basis regardless of the
      // management valuation selected for totalCost.
      recipeCost: Number,
      orderValue: Number,
    },
    // ─────────────────────────────────────────────────────────────────────────
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
    },
    loggedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    loggedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: false }   // loggedAt serves as the timestamp
);

wasteLogSchema.index({ product: 1, loggedAt: -1 });
wasteLogSchema.index({ outlet: 1, loggedAt: -1 });
wasteLogSchema.index({ reason: 1 });
wasteLogSchema.index({ source: 1 });
wasteLogSchema.index({ saleTransactionId: 1 }, { sparse: true });

const WasteLog = defineModel('WasteLog', wasteLogSchema);

export default WasteLog;
