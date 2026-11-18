import TaxConfig from '../models/TaxConfig.js';
import Outlet from '../models/Outlet.js';
import mongoose from 'mongoose';

const round2 = (n) => parseFloat((n ?? 0).toFixed(2));

export const ORDER_TYPES = ['dine-in', 'takeaway', 'delivery'];
// Fallback when neither the outlet nor the global config has a value set.
const DEFAULT_SERVICE_CHARGE_ORDER_TYPES = ['dine-in'];

// Keep only valid order-type strings (deduped). Returns null when the input
// isn't an array, so callers can distinguish "not set" from "set to none ([])".
const normalizeOrderTypes = (arr) => {
  if (!Array.isArray(arr)) return null;
  return [...new Set(arr.filter((t) => ORDER_TYPES.includes(t)))];
};

// Resolve the sales-tax rates + service-charge applicability for a sale.
//
// Outlets can be different business natures with different rates, so a per-outlet
// config (outlet.tax) takes precedence. When an outlet has no rates set we fall
// back to the tenant-global TaxConfig, then to hard defaults — so outlets that
// were never edited keep behaving exactly as before. Always returns a plain
// normalized object (never a Mongoose document).
export const getTaxConfig = async (outletIdOrSnapshot) => {
  let global = null;
  const loadGlobal = async () => {
    if (!global) {
      global = await TaxConfig.findOne();
      if (!global) global = await TaxConfig.create({});
    }
    return global;
  };

  let rates = null;            // { standardRate, cardRate, cardReducedEnabled, onlineReducedEnabled }
  let serviceChargeOrderTypes = null;
  let serviceChargeRate = null;

  if (outletIdOrSnapshot) {
    // BSON ObjectIds expose an `_id` getter that returns themselves. Treating
    // every object with `_id` as an already-loaded outlet therefore caused an
    // ObjectId argument to skip Outlet.findById(), leaving `tax` undefined and
    // silently falling back to the tenant-global rates. Only a real outlet
    // snapshot should bypass the lookup; identifiers must always be resolved.
    const isObjectId = outletIdOrSnapshot instanceof mongoose.Types.ObjectId;
    const outlet = typeof outletIdOrSnapshot === 'object'
      && !isObjectId
      && (
        outletIdOrSnapshot._id
        || Object.prototype.hasOwnProperty.call(outletIdOrSnapshot, 'tax')
      )
      ? outletIdOrSnapshot
      : await Outlet.findById(outletIdOrSnapshot).select('tax').lean();
    const t = outlet?.tax;
    if (t && Number.isFinite(Number(t.standardRate))) {
      const standardRate = Number(t.standardRate);
      rates = {
        standardRate,
        cardRate: Number(t.cardRate ?? standardRate),
        cardReducedEnabled: t.cardReducedEnabled !== false,
        onlineReducedEnabled: t.onlineReducedEnabled !== false,
      };
    }
    serviceChargeOrderTypes = normalizeOrderTypes(t?.serviceChargeOrderTypes);
    if (Number.isFinite(Number(t?.serviceChargeRate))) serviceChargeRate = Number(t.serviceChargeRate);
  }

  if (!rates) {
    const cfg = await loadGlobal();
    rates = {
      standardRate: cfg.standardRate,
      cardRate: cfg.cardRate,
      cardReducedEnabled: cfg.cardReducedEnabled !== false,
      onlineReducedEnabled: cfg.onlineReducedEnabled !== false,
    };
  }
  if (serviceChargeOrderTypes === null) {
    const cfg = await loadGlobal();
    serviceChargeOrderTypes =
      normalizeOrderTypes(cfg.serviceChargeOrderTypes) ?? [...DEFAULT_SERVICE_CHARGE_ORDER_TYPES];
  }
  if (serviceChargeRate === null) {
    const cfg = await loadGlobal();
    serviceChargeRate = Number.isFinite(Number(cfg.serviceChargeRate)) ? Number(cfg.serviceChargeRate) : 0;
  }

  return { ...rates, serviceChargeRate, serviceChargeOrderTypes };
};

// Whether the per-item service charge should be applied for a given order type,
// per the resolved config. Defaults to dine-in only when no list is present.
export const serviceChargeAppliesTo = (config, orderType) => {
  const types = Array.isArray(config?.serviceChargeOrderTypes)
    ? config.serviceChargeOrderTypes
    : DEFAULT_SERVICE_CHARGE_ORDER_TYPES;
  return types.includes(orderType);
};

// Fraction of a bill eligible for the shared reduced payment rate. This is
// deliberately server-side so stale or modified POS clients cannot choose a
// tax rate that the outlet has disabled.
export const reducedRateFractionFor = (paymentMethod, payload, config) => {
  if (paymentMethod === 'card') return config?.cardReducedEnabled ? 1 : 0;
  if (paymentMethod === 'online-transfer') return config?.onlineReducedEnabled ? 1 : 0;
  if (paymentMethod === 'split-bill' && payload?.splitBill?.parts?.length) {
    let reducedShare = 0;
    let totalShare = 0;
    for (const part of payload.splitBill.parts) {
      const share = Number(part.share) || 0;
      totalShare += share;
      if (config?.cardReducedEnabled && part.method === 'card') reducedShare += share;
    }
    return totalShare > 0 ? reducedShare / totalShare : 0;
  }
  return 0;
};

// Effective tax rate (%) for a bill given the fraction eligible for the reduced
// digital-payment rate. Callers decide eligibility from the payment method and
// its per-method setting before passing the fraction here.
export const effectiveTaxRate = (config, reducedFraction) => {
  const f = Math.min(1, Math.max(0, Number(reducedFraction) || 0));
  const standard = Number(config?.standardRate ?? 0);
  const reduced = Number(config?.cardRate ?? standard);
  return round2(reduced * f + standard * (1 - f));
};

// Blended tax for a taxable base. Returns the amount + the effective/source
// rates so callers can persist a full breakdown for receipts and reports.
export const computeBlendedTax = ({ taxableBase, reducedFraction, config }) => {
  const rate = effectiveTaxRate(config, reducedFraction);
  return {
    taxAmount: round2((Number(taxableBase) || 0) * (rate / 100)),
    effectiveRate: rate,
    standardRate: Number(config?.standardRate ?? 0),
    cardRate: Number(config?.cardRate ?? config?.standardRate ?? 0),
  };
};
