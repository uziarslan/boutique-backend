import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

const billingEmailLogSchema = new mongoose.Schema({
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'BillingInvoice', required: true },
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tenantSlug: { type: String, required: true, trim: true, lowercase: true },
  deliveryKey: { type: String, required: true, unique: true, trim: true },
  type: {
    type: String,
    enum: ['invoice', 'reminder', 'paymentConfirmation', 'manualResend'],
    required: true,
  },
  recipient: { type: String, required: true, trim: true, lowercase: true },
  status: { type: String, enum: ['processing', 'sent', 'failed'], default: 'processing' },
  attemptedAt: { type: Date, default: Date.now },
  sentAt: { type: Date, default: null },
  providerMessageIds: { type: [String], default: [] },
  error: { type: String, trim: true, default: '' },
  triggeredBy: { type: String, trim: true, default: 'system' },
}, { timestamps: true });

billingEmailLogSchema.index({ invoice: 1, createdAt: -1 });
billingEmailLogSchema.index({ tenant: 1, createdAt: -1 });

let cached = null;
export const BillingEmailLogModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('BillingEmailLog', billingEmailLogSchema);
  return cached;
};
