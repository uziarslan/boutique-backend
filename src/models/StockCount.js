import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const stockCountLineSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Product is required on each count line.'],
    },
    systemQty:  { type: Number, default: 0 },
    countedQty: { type: Number, required: [true, 'Counted quantity is required.'], min: 0 },
    variance:   { type: Number, default: 0 },   // countedQty - systemQty
    unit:       { type: String, trim: true },
    notes:      { type: String, trim: true },
  },
  { _id: true }
);

const stockCountSchema = new mongoose.Schema(
  {
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    // Which holding area was counted. Defaults to kitchen (legacy counts).
    area: {
      type: String,
      enum: ['store', 'kitchen'],
      default: 'kitchen',
    },
    countedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lines: {
      type: [stockCountLineSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'A stock count must have at least one line.',
      },
    },
    status: {
      type: String,
      enum: ['inProgress', 'completed'],
      default: 'inProgress',
    },
    completedAt: { type: Date },
    // How shortages were booked: 'sold' (consumption — cost stays in Purchase
    // Expense) or 'waste' (reclassified to Waste & Spoilage). Default 'sold'.
    shortageMode: {
      type: String,
      enum: ['sold', 'waste'],
      default: 'sold',
    },
    notes:       { type: String, trim: true },
  },
  { timestamps: true }
);

stockCountSchema.index({ outlet: 1, status: 1 });
stockCountSchema.index({ createdAt: -1 });

const StockCount = defineModel('StockCount', stockCountSchema);

export default StockCount;
