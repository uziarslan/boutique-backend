import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// ─── Sub-schema ───────────────────────────────────────────────────────────────

const addressSchema = new mongoose.Schema(
  {
    street: { type: String, trim: true },
    city:   { type: String, trim: true },
    country:{ type: String, trim: true },
  },
  { _id: false }
);

// ─── Vendor schema ────────────────────────────────────────────────────────────

const vendorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Vendor name is required.'],
      trim: true,
    },
    code: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
      // populated by pre-save hook
    },
    category: {
      type: String,
      trim: true,
    },
    address: addressSchema,
    contactName: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    paymentTerms: {
      type: Number,   // days
      default: 30,
      min: 0,
    },
    creditLimit: {
      type: Number,
      default: 0,
      min: 0,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'USD',
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'onHold'],
      default: 'active',
    },
    notes: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

vendorSchema.index({ name: 'text', code: 'text' });
vendorSchema.index({ status: 1 });
vendorSchema.index({ category: 1 });

// ─── Helper: derive base code from name ──────────────────────────────────────

const baseCode = (name) => {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const suffix = Date.now().toString().slice(-4);
  return `${initials}-${suffix}`;
};

// ─── Pre-save: auto-generate unique vendor code ───────────────────────────────

vendorSchema.pre('save', async function () {
  // Only generate on new documents without an existing code
  if (!this.isNew || this.code) return;

  const candidate = baseCode(this.name);
  const exists = await this.constructor.findOne({ code: candidate }).lean();

  if (!exists) {
    this.code = candidate;
    return;
  }

  // Append incrementing counter until unique
  let counter = 1;
  let unique = false;
  while (!unique) {
    const withCounter = `${candidate}-${counter}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await this.constructor.findOne({ code: withCounter }).lean();
    if (!clash) {
      this.code = withCounter;
      unique = true;
    } else {
      counter++;
    }
  }
});

const Vendor = defineModel('Vendor', vendorSchema);

export default Vendor;
