import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// Audit trail for every points movement. One document per earn/redeem/adjust/expire.
const loyaltyTransactionSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
    },
    sale: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SaleTransaction',
      default: null,
    },
    type: {
      type: String,
      enum: ['earn', 'redeem', 'adjust', 'expire', 'issue_card', 'refund_reversal'],
      required: true,
    },
    // Signed point delta. earn/adjust(+) = positive, redeem/expire/refund_reversal = negative.
    points: { type: Number, required: true },
    // Currency value at the moment of the transaction (points × redemptionValue).
    valueAtTxn: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0, min: 0 },
    // For earn rows — when these points expire (null if expiry is disabled).
    expiresAt: { type: Date, default: null },
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
    note: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

loyaltyTransactionSchema.index({ customer: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ sale: 1 });
loyaltyTransactionSchema.index({ type: 1, expiresAt: 1 });

const LoyaltyTransaction = defineModel('LoyaltyTransaction', loyaltyTransactionSchema);
export default LoyaltyTransaction;
