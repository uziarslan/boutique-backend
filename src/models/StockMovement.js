import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * StockMovement — the immutable stock ledger.
 *
 * Every increment/decrement of StockItem.qtyOnHand writes exactly one movement
 * row here. StockItem.qtyOnHand remains the fast cached balance; this collection
 * is the audit trail and the backbone of the Store/Kitchen reports (group by
 * outlet + area + type over a date range).
 *
 * `qty` is SIGNED and expressed in the product's stock base unit:
 *   + = stock came in    (receipt, issue-in, prep-in, positive count/adjust)
 *   - = stock went out    (sale, waste, issue-out, prep-out, negative count/adjust)
 *
 * A Store→Kitchen issue produces TWO rows: an `issue-out` (area store, −qty) and
 * an `issue-in` (area kitchen, +qty), linked by the same StockIssue ref.
 */
const stockMovementSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    area: {
      type: String,
      enum: ['store', 'kitchen'],
      required: true,
    },
    qty: {
      type: Number,
      required: true, // signed; base stock units
    },
    unit: { type: String, trim: true },
    type: {
      type: String,
      enum: [
        'receipt',        // goods received into store/kitchen from a purchase
        'issue-out',      // issued out of store (store → kitchen)
        'issue-in',       // received into kitchen from an issue
        'return-out',     // returned out of kitchen (kitchen → store)
        'return-in',      // received back into store from a return
        'sale',           // recipe deduction on a POS sale
        'waste',          // waste log
        'reprepare',      // re-prepare re-deduction
        'prep-in',        // finished prep added
        'prep-out',       // prep ingredients consumed
        'production-out', // raw materials issued to a boutique production order
        'production-in',  // raw materials returned if production is cancelled
        'count-adjust',   // stock-count variance
        'manual-adjust',  // direct manual quantity change
        'reversal',       // stock returned by a void/refund of a sale
      ],
      required: true,
    },
    // WAC (Product.currentPrice) captured at movement time, for valuation.
    unitCost: { type: Number, default: 0 },
    // Signed value = qty * unitCost (rounded), for quick money roll-ups.
    value: { type: Number, default: 0 },
    // Tenant-global weighted-average inventory cost immediately before/after a
    // purchase or purchase correction. These snapshots let historical reports
    // rewind valuation exactly without applying today's Product.currentPrice to
    // an older quantity. Legacy movements may not have these fields.
    inventoryUnitCostBefore: { type: Number, min: 0 },
    inventoryUnitCostAfter: { type: Number, min: 0 },
    // Polymorphic source document.
    ref: {
      kind: {
        type: String,
      enum: ['purchase', 'purchaseAdjustment', 'stockIssue', 'saleTransaction', 'wasteLog', 'stockCount', 'prepRecipe', 'productionOrder', 'manual', null],
        default: null,
      },
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    note: { type: String, trim: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

stockMovementSchema.index({ outlet: 1, area: 1, at: -1 });
stockMovementSchema.index({ product: 1, area: 1, at: -1 });
stockMovementSchema.index({ type: 1, at: -1 });
stockMovementSchema.index({ 'ref.kind': 1, 'ref.id': 1 });

const StockMovement = defineModel('StockMovement', stockMovementSchema);

export default StockMovement;
