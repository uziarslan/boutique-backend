import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';

const nextRunNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { _id: 'ADR' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `ADR-${String(counter.seq).padStart(6, '0')}`;
};

const depreciationLineSchema = new mongoose.Schema(
  {
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true },
    openingAccumulatedDepreciation: { type: Number, min: 0, default: 0 },
    amount: { type: Number, min: 0, required: true },
    closingAccumulatedDepreciation: { type: Number, min: 0, default: 0 },
    assetAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
    accumulatedDepreciationAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccounts',
      required: true,
    },
    depreciationExpenseAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccounts',
      required: true,
    },
  },
  { _id: true },
);

const assetDepreciationRunSchema = new mongoose.Schema(
  {
    runNumber: { type: String, unique: true, trim: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
    throughDate: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'posted', 'reversed'], default: 'draft' },
    lines: { type: [depreciationLineSchema], default: [] },
    totalAmount: { type: Number, min: 0, default: 0 },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    postedAt: { type: Date, default: null },
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

assetDepreciationRunSchema.pre('save', async function () {
  if (this.isNew && !this.runNumber) this.runNumber = await nextRunNumber();
});

assetDepreciationRunSchema.index({ outlet: 1, throughDate: -1 });
assetDepreciationRunSchema.index({ status: 1 });

const AssetDepreciationRun = defineModel('AssetDepreciationRun', assetDepreciationRunSchema);
export default AssetDepreciationRun;
