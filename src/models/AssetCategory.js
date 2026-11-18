import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const assetCategorySchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Asset category code is required.'],
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'Asset category name is required.'],
      trim: true,
    },
    description: { type: String, trim: true },
    trackingMode: {
      type: String,
      enum: ['serialized', 'bulk'],
      default: 'serialized',
    },
    defaultUnit: { type: String, trim: true, default: 'unit' },
    defaultUsefulLifeMonths: { type: Number, min: 1, default: 60 },
    defaultResidualValuePercent: { type: Number, min: 0, max: 100, default: 0 },
    depreciationMethod: {
      type: String,
      enum: ['straightLine', 'none'],
      default: 'straightLine',
    },
    auditFrequencyDays: { type: Number, min: 1, default: 90 },
    capitalisationThreshold: { type: Number, min: 0, default: 0 },
    accounts: {
      asset: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts', required: true },
      accumulatedDepreciation: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      depreciationExpense: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      lossOnDisposal: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
      gainOnDisposal: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccounts' },
    },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

assetCategorySchema.index({ name: 1 });
assetCategorySchema.index({ isActive: 1 });

const AssetCategory = defineModel('AssetCategory', assetCategorySchema);
export default AssetCategory;
