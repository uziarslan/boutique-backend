import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';

const nextAssetNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { _id: 'AST' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `AST-${String(counter.seq).padStart(6, '0')}`;
};

const assetSchema = new mongoose.Schema(
  {
    assetNumber: { type: String, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssetCategory',
      required: true,
    },
    trackingMode: {
      type: String,
      enum: ['serialized', 'bulk'],
      required: true,
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: true,
    },
    location: { type: String, trim: true, default: '' },
    custodian: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    custodianName: { type: String, trim: true, default: '' },
    serialNumber: { type: String, trim: true, default: '' },
    modelNumber: { type: String, trim: true, default: '' },
    manufacturer: { type: String, trim: true, default: '' },
    unit: { type: String, trim: true, default: 'unit' },
    originalQuantity: { type: Number, min: 0, default: 1 },
    quantity: { type: Number, min: 0, default: 1 },
    originalUnitCost: { type: Number, min: 0, default: 0 },
    originalCost: { type: Number, min: 0, default: 0 },
    grossCarryingAmount: { type: Number, min: 0, default: 0 },
    residualValue: { type: Number, min: 0, default: 0 },
    acquisitionDate: { type: Date, default: Date.now },
    depreciationStartDate: { type: Date, default: null },
    usefulLifeMonths: { type: Number, min: 1, default: 60 },
    depreciationMethod: {
      type: String,
      enum: ['straightLine', 'none'],
      default: 'straightLine',
    },
    accumulatedDepreciation: { type: Number, min: 0, default: 0 },
    lastDepreciationDate: { type: Date, default: null },
    condition: {
      type: String,
      enum: ['good', 'fair', 'damaged', 'missing', 'underRepair'],
      default: 'good',
    },
    status: {
      type: String,
      enum: ['active', 'underRepair', 'missing', 'disposed', 'writtenOff', 'inactive'],
      default: 'active',
    },
    accounts: {
      asset: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts', required: true },
      accumulatedDepreciation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      depreciationExpense: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      lossOnDisposal: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      gainOnDisposal: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
    },
    purchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    purchaseLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
    acquisitionJournalEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    accountingLinked: { type: Boolean, default: false },
    source: {
      type: String,
      enum: ['manual', 'purchase', 'openingImport'],
      default: 'manual',
    },
    warrantyExpiresAt: { type: Date, default: null },
    attachmentUrls: { type: [String], default: [] },
    notes: { type: String, trim: true, default: '' },
    lastAuditAt: { type: Date, default: null },
    nextAuditDueAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

assetSchema.virtual('netBookValue').get(function () {
  return Math.max(
    0,
    Number(this.grossCarryingAmount || 0) - Number(this.accumulatedDepreciation || 0),
  );
});

assetSchema.pre('validate', function () {
  if (this.trackingMode === 'serialized') {
    this.originalQuantity = this.isNew ? 1 : Math.min(1, Number(this.originalQuantity) || 1);
    this.quantity = Math.min(1, Number(this.quantity) || 0);
  }
  this.originalCost = Number((
    Number(this.originalUnitCost || 0) * Number(this.originalQuantity || 0)
  ).toFixed(2));
  if (this.isNew && !this.grossCarryingAmount) {
    this.grossCarryingAmount = this.originalCost;
  }
  if (!this.depreciationStartDate) this.depreciationStartDate = this.acquisitionDate;
});

assetSchema.pre('save', async function () {
  if (this.isNew && !this.assetNumber) this.assetNumber = await nextAssetNumber();
});

assetSchema.index({ outlet: 1, status: 1, category: 1 });
assetSchema.index({ assetNumber: 'text', name: 'text', serialNumber: 'text' });
assetSchema.index({ nextAuditDueAt: 1, status: 1 });
assetSchema.index(
  { serialNumber: 1 },
  { unique: true, partialFilterExpression: { serialNumber: { $type: 'string', $gt: '' } } },
);

const Asset = defineModel('Asset', assetSchema);
export default Asset;
