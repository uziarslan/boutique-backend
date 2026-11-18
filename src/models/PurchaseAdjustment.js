import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';

const generateNumber = async () => {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'PAC' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `PAC-${String(doc.seq).padStart(6, '0')}`;
};

const purchaseAdjustmentSchema = new mongoose.Schema({
  adjustmentNumber: { type: String, unique: true, trim: true },
  purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', required: true },
  type: {
    type: String,
    enum: ['metadata', 'quantity', 'value', 'mixed', 'return', 'reversal'],
    required: true,
  },
  reason: { type: String, required: true, trim: true },
  inventoryAction: {
    type: String,
    enum: ['adjust', 'keep', 'notApplicable'],
    default: 'adjust',
  },
  before: { type: mongoose.Schema.Types.Mixed, required: true },
  after: { type: mongoose.Schema.Types.Mixed, required: true },
  stockDeltas: { type: [mongoose.Schema.Types.Mixed], default: [] },
  paymentChanges: { type: [mongoose.Schema.Types.Mixed], default: [] },
  financialDelta: { type: Number, default: 0 },
  financialBreakdown: {
    goods: { type: Number, default: 0 },
    ait: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

purchaseAdjustmentSchema.index({ purchase: 1, createdAt: -1 });
purchaseAdjustmentSchema.pre('save', async function () {
  if (this.isNew && !this.adjustmentNumber) this.adjustmentNumber = await generateNumber();
});

const PurchaseAdjustment = defineModel('PurchaseAdjustment', purchaseAdjustmentSchema);
export default PurchaseAdjustment;
