import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const assetAuditLineSchema = new mongoose.Schema(
  {
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetAudit', required: true },
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', default: null },
    unregisteredName: { type: String, trim: true, default: '' },
    assetNumberSnapshot: { type: String, trim: true, default: '' },
    nameSnapshot: { type: String, trim: true, default: '' },
    trackingMode: { type: String, enum: ['serialized', 'bulk'], default: 'serialized' },
    expectedQuantity: { type: Number, min: 0, default: 0 },
    countedQuantity: { type: Number, min: 0, default: null },
    approvedQuantity: { type: Number, min: 0, default: null },
    variance: { type: Number, default: 0 },
    expectedLocation: { type: String, trim: true, default: '' },
    foundLocation: { type: String, trim: true, default: '' },
    expectedCondition: { type: String, trim: true, default: '' },
    countedCondition: {
      type: String,
      enum: ['', 'good', 'fair', 'damaged', 'missing', 'underRepair'],
      default: '',
    },
    originalUnitCostSnapshot: { type: Number, min: 0, default: 0 },
    originalCostSnapshot: { type: Number, min: 0, default: 0 },
    accumulatedDepreciationSnapshot: { type: Number, min: 0, default: 0 },
    reviewAction: {
      type: String,
      enum: [
        'pending',
        'noChange',
        'quantityAdjustment',
        'conditionUpdate',
        'writeOff',
        'recount',
        'investigate',
        'registerAsset',
      ],
      default: 'pending',
    },
    status: {
      type: String,
      enum: ['pending', 'counted', 'recountRequired', 'resolved'],
      default: 'pending',
    },
    evidenceUrls: { type: [String], default: [] },
    notes: { type: String, trim: true, default: '' },
    reviewerNotes: { type: String, trim: true, default: '' },
    countedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    countedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

assetAuditLineSchema.index({ audit: 1, status: 1 });
assetAuditLineSchema.index(
  { audit: 1, asset: 1 },
  { unique: true, partialFilterExpression: { asset: { $type: 'objectId' } } },
);

const AssetAuditLine = defineModel('AssetAuditLine', assetAuditLineSchema);
export default AssetAuditLine;
