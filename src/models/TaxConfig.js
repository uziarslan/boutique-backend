import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One TaxConfig document per tenant. Holds the sales-tax rates applied at the
// POS. Pakistan policy: a standard rate on cash and an optional reduced rate on
// card/online payments. An item is taxable when its MenuItem.taxRate > 0; the
// actual percentage charged comes from here (not the per-item value), so the
// owner can change rates in one place.
const taxConfigSchema = new mongoose.Schema(
  {
    // Standard sales-tax rate (%), applied to cash / non-card payments.
    standardRate: { type: Number, default: 16, min: 0, max: 100 },
    // Reduced rate (%) applied to the card-paid portion of a bill.
    cardRate: { type: Number, default: 5, min: 0, max: 100 },
    // When false, card payments are taxed at the standard rate too (no reduction).
    cardReducedEnabled: { type: Boolean, default: true },
    // Online transfers can independently use the same reduced rate or the
    // standard rate. Default true preserves the pre-setting POS behaviour.
    onlineReducedEnabled: { type: Boolean, default: true },
    // Tenant-global default service-charge percentage. Auto-fills new menu items'
    // per-item service charge. Per-outlet config (outlet.tax.serviceChargeRate)
    // overrides this.
    serviceChargeRate: { type: Number, default: 0, min: 0, max: 100 },
    // Tenant-global default for which order types are charged service charge.
    // Per-outlet config (outlet.tax.serviceChargeOrderTypes) overrides this.
    // Default: dine-in only — service charge is not added to takeaway/delivery
    // unless an outlet opts in.
    serviceChargeOrderTypes: {
      type: [String],
      enum: ['dine-in', 'takeaway', 'delivery'],
      default: ['dine-in'],
    },
  },
  { timestamps: true }
);

const TaxConfig = defineModel('TaxConfig', taxConfigSchema);
export default TaxConfig;
