import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const assetMovementSchema = new mongoose.Schema(
  {
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
    type: {
      type: String,
      enum: [
        'acquisition',
        'openingImport',
        'transfer',
        'auditAdjustment',
        'conditionChange',
        'depreciation',
        'disposal',
        'writeOff',
        'reversal',
      ],
      required: true,
    },
    quantityBefore: { type: Number, default: 0 },
    quantityChange: { type: Number, default: 0 },
    quantityAfter: { type: Number, default: 0 },
    conditionBefore: { type: String, trim: true },
    conditionAfter: { type: String, trim: true },
    locationBefore: { type: String, trim: true },
    locationAfter: { type: String, trim: true },
    fromOutlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
    toOutlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
    audit: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetAudit', default: null },
    depreciationRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AssetDepreciationRun',
      default: null,
    },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    amount: { type: Number, default: 0 },
    reason: { type: String, trim: true, default: '' },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

assetMovementSchema.index({ asset: 1, at: -1 });
assetMovementSchema.index({ outlet: 1, type: 1, at: -1 });
assetMovementSchema.index({ audit: 1 });

const AssetMovement = defineModel('AssetMovement', assetMovementSchema);
export default AssetMovement;
