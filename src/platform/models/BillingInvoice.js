import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, default: 1, min: 0 },
  unitPrice: { type: Number, default: 0, min: 0 },
  amount: { type: Number, default: 0, min: 0 },
}, { _id: false });

const auditEventSchema = new mongoose.Schema({
  action: { type: String, required: true, trim: true },
  at: { type: Date, default: Date.now },
  by: { type: String, trim: true, default: 'system' },
  details: { type: mongoose.Schema.Types.Mixed },
}, { _id: false });

const bankDetailsSchema = new mongoose.Schema({
  active: { type: Boolean, default: false },
  bankName: { type: String, trim: true, default: '' },
  accountTitle: { type: String, trim: true, default: '' },
  accountNumber: { type: String, trim: true, default: '' },
  iban: { type: String, trim: true, uppercase: true, default: '' },
  branchName: { type: String, trim: true, default: '' },
  branchCode: { type: String, trim: true, default: '' },
  swiftCode: { type: String, trim: true, uppercase: true, default: '' },
  currency: { type: String, trim: true, uppercase: true, default: 'PKR' },
  paymentNotes: { type: String, trim: true, default: '' },
}, { _id: false });

const billingInvoiceSchema = new mongoose.Schema({
  tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
  tenantSlug: { type: String, required: true, trim: true, lowercase: true },
  renewalKey: { type: String, required: true, unique: true, trim: true },
  invoiceNumber: { type: String, required: true, unique: true, trim: true },
  receiptNumber: { type: String, unique: true, sparse: true, trim: true },

  restaurantName: { type: String, required: true, trim: true },
  ownerName: { type: String, trim: true, default: '' },
  ownerEmail: { type: String, required: true, trim: true, lowercase: true },
  billingEmail: { type: String, required: true, trim: true, lowercase: true },
  bankDetails: { type: bankDetailsSchema, default: () => ({}) },

  currency: { type: String, default: 'PKR', uppercase: true, trim: true },
  lineItems: { type: [lineItemSchema], default: [] },
  subtotal: { type: Number, required: true, min: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  taxRate: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0, min: 0 },
  total: { type: Number, required: true, min: 0 },
  amountPaid: { type: Number, default: 0, min: 0 },
  balance: { type: Number, required: true, min: 0 },

  issueDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  accessUntilBefore: { type: Date, required: true },
  projectedAccessUntil: { type: Date, required: true },
  accessGrantedUntil: { type: Date, default: null },
  paymentInstructions: { type: String, trim: true, default: '' },

  status: {
    type: String,
    enum: ['draft', 'issued', 'overdue', 'paid', 'void'],
    default: 'issued',
  },
  paidAt: { type: Date, default: null },
  paymentMethod: { type: String, trim: true, default: '' },
  paymentReference: { type: String, trim: true, default: '' },
  paymentNotes: { type: String, trim: true, default: '' },

  remindersEnabled: { type: Boolean, default: true },
  reminderCount: { type: Number, default: 0, min: 0 },
  lastReminderAt: { type: Date, default: null },
  nextReminderAt: { type: Date, default: null },
  reminderLeaseUntil: { type: Date, default: null },
  lastReminderError: { type: String, trim: true, default: '' },
  invoiceSentAt: { type: Date, default: null },
  paymentEmailSentAt: { type: Date, default: null },

  createdBy: { type: String, trim: true, default: 'system' },
  paidBy: { type: String, trim: true, default: '' },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: String, trim: true, default: '' },
  voidReason: { type: String, trim: true, default: '' },
  auditTrail: { type: [auditEventSchema], default: [] },
}, { timestamps: true });

billingInvoiceSchema.index({ tenant: 1, createdAt: -1 });
billingInvoiceSchema.index({ status: 1, nextReminderAt: 1 });
billingInvoiceSchema.index({ tenantSlug: 1, status: 1 });

let cached = null;
export const BillingInvoiceModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('BillingInvoice', billingInvoiceSchema);
  return cached;
};
