import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const kdsItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuCategory' },
    categoryName: { type: String, trim: true, default: '' },
    variation: {
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true, default: '' },
    },
    name: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    serviceChargeAmount: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
);

const lifecycleEventSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'sent', 'accepted', 'prep-started', 'dispatched',
        'cashier-acknowledged', 'cancelled', 'revised',
        'rider-assigned', 'relinked', 'item-cancelled',
      ],
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, trim: true, default: '' },
    source: { type: String, enum: ['pos', 'kds', 'system'], default: 'system' },
    fromStatus: { type: String, default: '' },
    toStatus: { type: String, default: '' },
    reason: { type: String, trim: true, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { _id: true },
);

const revisionSchema = new mongoose.Schema(
  {
    sequence: { type: Number, required: true, min: 1 },
    signature: { type: String, required: true },
    sentAt: { type: Date, required: true, default: Date.now },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sentByName: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    items: { type: [kdsItemSchema], default: [] },
  },
  { _id: true },
);

const deliveryAddressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: '' },
    street: { type: String, trim: true, default: '' },
    area: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const kdsOrderSchema = new mongoose.Schema(
  {
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true },
    saleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', required: true },
    originalSaleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', required: true },
    finalSaleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', default: null },
    ticketNumber: { type: String, required: true, trim: true },
    finalTransactionNumber: { type: String, trim: true, default: '' },
    businessDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    source: {
      type: String,
      enum: ['cashier', 'qr-self-order', 'staff-tablet'],
      default: 'cashier',
    },
    orderType: {
      type: String,
      enum: ['dine-in', 'takeaway', 'delivery', 'foodpanda'],
      default: 'dine-in',
    },
    tableNumber: { type: String, trim: true, default: '' },
    customerName: { type: String, trim: true, default: '' },
    customerPhone: { type: String, trim: true, default: '' },
    deliveryAddress: { type: deliveryAddressSchema, default: undefined },
    cashier: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cashierName: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    items: { type: [kdsItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, default: 0, min: 0 },
    currentStatus: {
      type: String,
      enum: ['new', 'accepted', 'preparing', 'dispatched', 'cancelled'],
      default: 'new',
      index: true,
    },
    punchedAt: { type: Date, required: true },
    sentToKitchenAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acceptedByName: { type: String, trim: true, default: '' },
    prepStartedAt: { type: Date, default: null },
    prepStartedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    prepStartedByName: { type: String, trim: true, default: '' },
    kitchenDispatchedAt: { type: Date, default: null },
    kitchenDispatchedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    kitchenDispatchedByName: { type: String, trim: true, default: '' },
    cashierAcknowledgedAt: { type: Date, default: null },
    cashierAcknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cashierAcknowledgedByName: { type: String, trim: true, default: '' },
    assignedRider: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    assignedRiderUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedRiderName: { type: String, trim: true, default: '' },
    riderAssignedAt: { type: Date, default: null },
    riderAssignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    riderAssignedByName: { type: String, trim: true, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledByName: { type: String, trim: true, default: '' },
    cancelledFrom: { type: String, enum: ['pos', 'kds'], default: undefined },
    cancellationReason: { type: String, trim: true, default: '' },
    statusAtCancellation: { type: String, trim: true, default: '' },
    preparedAtCancellation: { type: Boolean, default: null },
    wasteValue: { type: Number, default: 0, min: 0 },
    printStatus: { type: String, enum: ['unknown', 'queued', 'printed', 'failed'], default: 'printed' },
    revisions: { type: [revisionSchema], default: [] },
    lifecycle: { type: [lifecycleEventSchema], default: [] },
    version: { type: Number, default: 1, min: 1 },
  },
  { timestamps: true },
);

kdsOrderSchema.index({ outlet: 1, currentStatus: 1, sentToKitchenAt: 1 });
kdsOrderSchema.index({ originalSaleTransaction: 1 }, { unique: true });
kdsOrderSchema.index({ finalSaleTransaction: 1 }, { sparse: true });
kdsOrderSchema.index({ businessDate: -1, outlet: 1 });

export default defineModel('KdsOrder', kdsOrderSchema);
