import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import Counter from './Counter.js';
import { summarizePurchaseItems } from '../utils/purchaseSummary.js';
import { calculatePurchaseLineTotal } from '../utils/purchaseLineTotals.js';

const generatePurchaseNumber = async () => {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'PUR' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return `PUR-${String(doc.seq).padStart(6, '0')}`;
};

const purchaseLineSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, trim: true },
  description: { type: String, trim: true },
  accountingTreatment: {
    type: String,
    enum: ['inventory', 'expense', 'asset'],
    default: undefined,
  },
  assetCategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AssetCategory',
    default: null,
  },
  assetAccount: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChartOfAccounts',
    default: null,
  },
  assetLocation: { type: String, trim: true, default: '' },
  assetUsefulLifeMonths: { type: Number, min: 1, default: null },
  assetResidualValue: { type: Number, min: 0, default: null },
  qty: { type: Number, required: true, min: 0 },
  entryMode: { type: String, enum: ['loose', 'pack'], default: 'loose' },
  packSize: { type: Number, default: 1, min: 1 },
  unit: { type: String, trim: true },
  priceEntryMode: { type: String, enum: ['unit', 'total'], default: 'unit' },
  unitPrice: { type: Number, required: true, min: 0 },
  lineDiscount: { type: Number, default: 0, min: 0 },
  lineTotal: { type: Number, default: 0 },
  notes: { type: String, trim: true },
}, { _id: true });

const purchaseSchema = new mongoose.Schema({
  purchaseNumber: { type: String, unique: true, trim: true },
  type: { type: String, enum: ['stock', 'expense', 'mixed'], default: 'stock' },
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null },
  vendorName: { type: String, trim: true },
  vendorInvoiceNumber: { type: String, trim: true },
  purchaseDate: { type: Date, default: Date.now },
  dueDate: { type: Date, default: null },
  outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', default: null },
  destination: { type: String, enum: ['store', 'kitchen', 'none'], default: 'store' },
  lines: {
    type: [purchaseLineSchema],
    validate: {
      validator: (value) => Array.isArray(value) && value.length > 0,
      message: 'A purchase must contain at least one line.',
    },
  },
  subtotal: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0, min: 0 },
  taxRate: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0 },
  aitRate: { type: Number, default: 0, min: 0, max: 100 },
  aitAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0, min: 0 },
  currency: { type: String, trim: true, uppercase: true, default: 'PKR' },
  itemSummary: { type: String, trim: true, default: 'Purchase' },
  status: {
    type: String,
    enum: [
      'draft', 'pendingApproval', 'open', 'partiallyPaid', 'paid',
      'disputed', 'corrected', 'reversed', 'migrationReview',
    ],
    default: 'draft',
  },
  migrationReview: {
    required: { type: Boolean, default: false },
    reasons: { type: [String], default: [] },
  },
  attachmentUrl: { type: String, trim: true },
  ocrData: { type: mongoose.Schema.Types.Mixed },
  notes: { type: String, trim: true },
  stockPostedAt: { type: Date, default: null },
  assetPostedAt: { type: Date, default: null },
  postedAt: { type: Date, default: null },
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
  reversedAt: { type: Date, default: null },
  reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reversalReason: { type: String, trim: true },
  reversalInventoryAction: {
    type: String,
    enum: ['adjust', 'keep'],
    default: 'adjust',
  },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deleteReason: { type: String, trim: true },
  legacy: {
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, default: null },
    purchaseOrderNumber: { type: String, trim: true },
    purchaseOrderSnapshot: { type: mongoose.Schema.Types.Mixed },
    grnId: { type: mongoose.Schema.Types.ObjectId, default: null },
    grnNumber: { type: String, trim: true },
    grnSnapshot: { type: mongoose.Schema.Types.Mixed },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    invoiceRef: { type: String, trim: true },
    invoiceSnapshot: { type: mongoose.Schema.Types.Mixed },
    migratedAt: { type: Date, default: null },
    migrationVersion: { type: String, trim: true },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

purchaseSchema.index({ vendor: 1, status: 1 });
purchaseSchema.index({ outlet: 1, purchaseDate: -1 });
purchaseSchema.index({ status: 1, dueDate: 1 });
purchaseSchema.index({ deletedAt: 1, status: 1 });
purchaseSchema.index({ 'legacy.grnId': 1 });
purchaseSchema.index({ 'legacy.invoiceId': 1 });
purchaseSchema.index({ 'legacy.purchaseOrderId': 1 });

purchaseSchema.virtual('balance').get(function () {
  return Number((this.totalAmount - this.amountPaid).toFixed(2));
});

purchaseSchema.methods.recalculateTotals = function () {
  let subtotal = 0;
  for (const line of this.lines) {
    line.lineTotal = calculatePurchaseLineTotal(line);
    subtotal += line.lineTotal;
  }
  this.subtotal = Number(subtotal.toFixed(2));
  const discount = Math.min(this.subtotal, Math.max(0, Number(this.discountAmount) || 0));
  const taxable = Math.max(0, this.subtotal - discount);
  this.taxAmount = Number((taxable * ((Number(this.taxRate) || 0) / 100)).toFixed(2));
  this.aitAmount = Number((taxable * ((Number(this.aitRate) || 0) / 100)).toFixed(2));
  this.totalAmount = Number((taxable + this.taxAmount + this.aitAmount).toFixed(2));
  this.itemSummary = summarizePurchaseItems(this.lines);
  if (this.type === 'expense') this.destination = 'none';
};

purchaseSchema.pre('save', async function () {
  if (this.isNew && !this.purchaseNumber) this.purchaseNumber = await generatePurchaseNumber();
  this.recalculateTotals();
});

const Purchase = defineModel('Purchase', purchaseSchema);
export default Purchase;
