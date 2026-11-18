import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One Table per outlet seating area. The `code` is a slug used in the public
// QR URL — must be unique within an outlet but not across outlets.
const tableSchema = new mongoose.Schema(
  {
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: [true, 'Outlet is required.'],
    },
    label: {
      type: String,
      required: [true, 'Table label is required.'],
      trim: true,
      maxlength: 80,
    },
    code: {
      type: String,
      required: [true, 'Table code is required.'],
      trim: true,
      maxlength: 50,
      lowercase: true,
      match: [/^[a-z0-9-]+$/, 'Code must contain only lowercase letters, digits, and hyphens.'],
    },
    capacity: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Short-lived distributed mutex used while a QR submission is attached
    // to this table's active transaction. It prevents two web dynos receiving
    // simultaneous taps from creating two transaction numbers.
    _qrOrderLock: {
      type: new mongoose.Schema(
        { token: { type: String }, expiresAt: { type: Date } },
        { _id: false },
      ),
      select: false,
      default: undefined,
    },
  },
  { timestamps: true }
);

tableSchema.index({ outlet: 1, code: 1 }, { unique: true });
tableSchema.index({ outlet: 1, isActive: 1 });

const Table = defineModel('Table', tableSchema);
export default Table;
