import mongoose from 'mongoose';
import { getTaxConfig, ORDER_TYPES } from '../services/tax.service.js';
import Outlet from '../models/Outlet.js';
import TaxConfig from '../models/TaxConfig.js';

const clampRate = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return parseFloat(n.toFixed(2));
};

const validOutletId = (id) => (id && mongoose.isValidObjectId(id) ? id : null);

// Sanitize an incoming service-charge order-type list: must be an array of valid
// order types; deduped. Returns null when the input is not an array (caller can
// then reject). An empty array is valid and means "no service charge anywhere".
const sanitizeOrderTypes = (v) => {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((t) => ORDER_TYPES.includes(t)))];
};

// GET /api/tax/config[?outlet=<id>] — effective sales-tax rates. With an outlet
// it returns that outlet's rates (falling back to the tenant-global config when
// the outlet has none); without one it returns the global config. Readable by
// the POS (cashiers, scoped to their outlet) and managers.
export const getConfig = async (req, res) => {
  const outletId = validOutletId(req.query.outlet);
  const cfg = await getTaxConfig(outletId || undefined);
  return res.json({
    success: true,
    data: {
      standardRate: cfg.standardRate,
      cardRate: cfg.cardRate,
      cardReducedEnabled: cfg.cardReducedEnabled,
      onlineReducedEnabled: cfg.onlineReducedEnabled,
      serviceChargeRate: cfg.serviceChargeRate,
      serviceChargeOrderTypes: cfg.serviceChargeOrderTypes,
      outlet: outletId,
    },
  });
};

// PATCH /api/tax/config[?outlet=<id>] — update rates. Owner / finance only.
// With an outlet, writes that outlet's rates; without one, the tenant-global
// config. Partial updates preserve the other fields by seeding from the current
// effective values first.
export const updateConfig = async (req, res) => {
  const outletId = validOutletId(req.query.outlet);
  const {
    standardRate,
    cardRate,
    cardReducedEnabled,
    onlineReducedEnabled,
    serviceChargeRate,
    serviceChargeOrderTypes,
  } = req.body ?? {};

  if (standardRate !== undefined && clampRate(standardRate) === null) {
    return res.status(422).json({ success: false, message: 'standardRate must be between 0 and 100.' });
  }
  if (cardRate !== undefined && clampRate(cardRate) === null) {
    return res.status(422).json({ success: false, message: 'cardRate must be between 0 and 100.' });
  }
  if (serviceChargeRate !== undefined && clampRate(serviceChargeRate) === null) {
    return res.status(422).json({ success: false, message: 'serviceChargeRate must be between 0 and 100.' });
  }
  let scTypes;
  if (serviceChargeOrderTypes !== undefined) {
    scTypes = sanitizeOrderTypes(serviceChargeOrderTypes);
    if (scTypes === null) {
      return res.status(422).json({ success: false, message: 'serviceChargeOrderTypes must be an array of order types.' });
    }
  }

  // ── Per-outlet update ───────────────────────────────────────────────────────
  if (outletId) {
    const outlet = await Outlet.findById(outletId);
    if (!outlet) {
      return res.status(404).json({ success: false, message: 'Outlet not found.' });
    }
    // Seed from current effective values so a partial patch doesn't drop fields.
    const eff = await getTaxConfig(outletId);
    const next = {
      standardRate: outlet.tax?.standardRate ?? eff.standardRate,
      cardRate: outlet.tax?.cardRate ?? eff.cardRate,
      cardReducedEnabled: outlet.tax?.cardReducedEnabled ?? eff.cardReducedEnabled,
      onlineReducedEnabled: outlet.tax?.onlineReducedEnabled ?? eff.onlineReducedEnabled,
      serviceChargeRate: outlet.tax?.serviceChargeRate ?? eff.serviceChargeRate,
      serviceChargeOrderTypes: outlet.tax?.serviceChargeOrderTypes ?? eff.serviceChargeOrderTypes,
    };
    if (standardRate !== undefined) next.standardRate = clampRate(standardRate);
    if (cardRate !== undefined) next.cardRate = clampRate(cardRate);
    if (cardReducedEnabled !== undefined) next.cardReducedEnabled = Boolean(cardReducedEnabled);
    if (onlineReducedEnabled !== undefined) next.onlineReducedEnabled = Boolean(onlineReducedEnabled);
    if (serviceChargeRate !== undefined) next.serviceChargeRate = clampRate(serviceChargeRate);
    if (scTypes !== undefined) next.serviceChargeOrderTypes = scTypes;

    outlet.tax = next;
    await outlet.save();
    return res.json({ success: true, data: { ...next, outlet: outletId } });
  }

  // ── Tenant-global update (legacy / no outlet) ───────────────────────────────
  let cfg = await TaxConfig.findOne();
  if (!cfg) cfg = await TaxConfig.create({});
  if (standardRate !== undefined) cfg.standardRate = clampRate(standardRate);
  if (cardRate !== undefined) cfg.cardRate = clampRate(cardRate);
  if (cardReducedEnabled !== undefined) cfg.cardReducedEnabled = Boolean(cardReducedEnabled);
  if (onlineReducedEnabled !== undefined) cfg.onlineReducedEnabled = Boolean(onlineReducedEnabled);
  if (serviceChargeRate !== undefined) cfg.serviceChargeRate = clampRate(serviceChargeRate);
  if (scTypes !== undefined) cfg.serviceChargeOrderTypes = scTypes;
  await cfg.save();
  return res.json({
    success: true,
    data: {
      standardRate: cfg.standardRate,
      cardRate: cfg.cardRate,
      cardReducedEnabled: cfg.cardReducedEnabled,
      onlineReducedEnabled: cfg.onlineReducedEnabled !== false,
      serviceChargeRate: cfg.serviceChargeRate,
      serviceChargeOrderTypes: cfg.serviceChargeOrderTypes,
      outlet: null,
    },
  });
};
