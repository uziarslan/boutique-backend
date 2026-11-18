import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const storeCreditSchema = new mongoose.Schema({
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  currency: { type: String, uppercase: true, trim: true, default: 'PKR' },
  issuedAmount: { type: Number, required: true, min: 0.01 },
  balance: { type: Number, required: true, min: 0, default: 0 },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
  issuedFromReturn: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleReturn', default: null },
  status: { type: String, enum: ['active', 'redeemed', 'expired', 'void'], default: 'active' },
  expiresAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

storeCreditSchema.index({ outlet: 1, status: 1, createdAt: -1 });

export default defineModel('StoreCredit', storeCreditSchema);
