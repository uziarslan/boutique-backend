import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One LoyaltyConfig document per tenant. Settings page upserts; sale flow reads.
const loyaltyConfigSchema = new mongoose.Schema(
  {
    // ── Earning ─────────────────────────────────────────────────────────
    // Points awarded per 1 currency unit spent. Default = 0.01 = 1 pt / 100.
    pointsPerCurrencyUnit: { type: Number, default: 0.01, min: 0 },
    // Which amount points are computed against.
    earnBasis: {
      type: String,
      enum: ['subtotal', 'subtotalPlusTax'],
      default: 'subtotal',
    },
    // Payment methods that earn points. Allowance sales never earn.
    earnOnPaymentMethods: {
      type: [String],
      default: ['cash', 'card', 'split'],
    },

    // ── Redemption ──────────────────────────────────────────────────────
    // Currency value of one point.
    redemptionValue: { type: Number, default: 1, min: 0 },
    minRedeemPoints: { type: Number, default: 100, min: 0 },
    maxRedeemPercent: { type: Number, default: 50, min: 0, max: 100 },
    // Apply redemption discount before or after tax.
    redemptionApplyMode: {
      type: String,
      enum: ['preTax', 'postTax'],
      default: 'preTax',
    },

    // ── Cards ───────────────────────────────────────────────────────────
    cardNumberMode: {
      type: String,
      enum: ['auto', 'manual'],
      default: 'auto',
    },
    cardNumberPrefix: { type: String, default: 'MC', trim: true },

    // ── Rules ───────────────────────────────────────────────────────────
    refundReversesPoints: { type: Boolean, default: true },
    expiryMonths: { type: Number, default: 0, min: 0 }, // 0 = never expire
    // Where breakage flows on expiry.
    breakageAccountCode: {
      type: String,
      enum: ['4003', '5005'],
      default: '4003',
    },

    // Mirror of the platform feature flag — convenience copy so this doc can
    // be read without hopping back to the Tenant doc.
    enabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const LoyaltyConfig = defineModel('LoyaltyConfig', loyaltyConfigSchema);
export default LoyaltyConfig;
