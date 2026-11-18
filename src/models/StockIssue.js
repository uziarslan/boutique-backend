import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * StockIssue — a two-party transfer of stock between the Store and Kitchen
 * within a single outlet. Now approval-gated:
 *   1. Sender ISSUES  → source qty ↓ immediately, status 'in_transit'
 *                       (one 'issue-out'/'return-out' ledger row per line).
 *   2. Receiver ACCEPTS → dest qty ↑, status 'accepted'
 *                       (one 'issue-in'/'return-in' ledger row per line).
 *      …or REJECTS     → source qty ↑ (stock returns), status 'rejected'
 *                       (one 'reversal' ledger row per line).
 * No journal entry — it is an internal move of the same asset within the same
 * outlet. Legacy rows carry status 'confirmed' (pre-approval one-shot moves that
 * already landed); they are treated as settled history.
 */
const stockIssueLineSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product is required on each issue line.'],
    },
    qty:  { type: Number, required: [true, 'Quantity is required.'], min: 0 }, // base stock units, store → kitchen
    unit: { type: String, trim: true }, // base stock unit (what qty is in)
    // What the user actually typed, before conversion to the base unit (e.g.
    // entered 500 g while the base unit is kg → enteredQty 500, enteredUnit 'g',
    // qty 0.5, unit 'kg'). Kept for a faithful issue register.
    enteredQty:  { type: Number },
    enteredUnit: { type: String, trim: true },
    // Store on-hand captured at confirm time (for the issue register display).
    storeQtyBefore: { type: Number },
    unitCost:  { type: Number, default: 0 },
    lineValue: { type: Number, default: 0 },
    notes: { type: String, trim: true },
  },
  { _id: true }
);

const stockIssueSchema = new mongoose.Schema(
  {
    issueNumber: {
      type: String,
      unique: true,
      trim: true,
      // populated by the controller before first save
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    // Direction of the transfer within the outlet.
    direction: {
      type: String,
      enum: ['storeToKitchen', 'kitchenToStore'],
      default: 'storeToKitchen',
    },
    lines: {
      type: [stockIssueLineSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'An issue must have at least one line.',
      },
    },
    totalValue: { type: Number, default: 0 },
    status: {
      type: String,
      // 'in_transit' — issued, awaiting the receiver's acceptance
      // 'accepted'   — receiver accepted; stock landed in the destination
      // 'rejected'   — receiver rejected; stock returned to the sender
      // 'confirmed'  — LEGACY one-shot move (pre-approval); treated as settled
      enum: ['in_transit', 'accepted', 'rejected', 'confirmed'],
      default: 'in_transit',
    },
    issuedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: { type: Date },   // legacy: set when a one-shot move landed
    // Set when the receiver acts (accept or reject).
    receivedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    receivedAt:   { type: Date },
    rejectReason: { type: String, trim: true },
    notes:       { type: String, trim: true },
    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

stockIssueSchema.index({ outlet: 1, status: 1, createdAt: -1 });
stockIssueSchema.index({ outlet: 1, direction: 1, status: 1, createdAt: -1 });
stockIssueSchema.index({ createdAt: -1 });

const StockIssue = defineModel('StockIssue', stockIssueSchema);

export default StockIssue;
