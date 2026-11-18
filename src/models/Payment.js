import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const paymentSchema = new mongoose.Schema(
  {
    purchase: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Purchase',
      required: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required.'],
      min: [0.01, 'Amount must be greater than 0.'],
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'PKR',
    },
    method: {
      type: String,
      enum: ['bankTransfer', 'cash', 'cheque', 'creditCard'],
      required: [true, 'Payment method is required.'],
    },
    reference:     { type: String, trim: true },
    paymentDate:   { type: Date, default: Date.now },
    notes:         { type: String, trim: true },
    journalEntryId:{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    status: {
      type: String,
      enum: ['posted', 'reversed'],
      default: 'posted',
    },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reversalReason: { type: String, trim: true },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

paymentSchema.index({ purchase: 1 });
paymentSchema.index({ vendor: 1, paymentDate: -1 });

const Payment = defineModel('Payment', paymentSchema);

export default Payment;
