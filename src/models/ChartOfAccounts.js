import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const chartOfAccountsSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, 'Account code is required.'],
      unique: true,
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'Account name is required.'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['asset', 'liability', 'equity', 'revenue', 'expense'],
      required: [true, 'Account type is required.'],
    },
    subType: {
      type: String,
      trim: true,  // e.g. currentAsset, accountsPayable, costOfGoodsSold
    },
    normalBalance: {
      type: String,
      enum: ['debit', 'credit'],
      required: [true, 'Normal balance is required.'],
    },
    isSystemAccount: {
      type: Boolean,
      default: false,
    },
    parentAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccounts',
    },
    description: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

chartOfAccountsSchema.index({ type: 1, isActive: 1 });

const ChartOfAccounts = defineModel('ChartOfAccounts', chartOfAccountsSchema);

export default ChartOfAccounts;
