import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const printJobSchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true, unique: true, trim: true },
    stationId: { type: String, required: true, trim: true, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', required: true, index: true },
    submittedByDeviceId: { type: String, trim: true, default: '' },
    printerName: { type: String, required: true, trim: true },
    jobName: { type: String, required: true, trim: true },
    text: { type: String, required: true },
    copies: { type: Number, min: 1, max: 5, default: 1 },
    status: {
      type: String,
      enum: ['pending', 'claimed', 'printed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    availableAt: { type: Date, default: Date.now },
    claimedAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    printedAt: { type: Date, default: null },
    confirmation: { type: String, trim: true, default: '' },
    lastError: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

printJobSchema.index({ stationId: 1, status: 1, availableAt: 1, createdAt: 1 });
printJobSchema.index({ order: 1, status: 1 });

export default defineModel('PrintJob', printJobSchema);

