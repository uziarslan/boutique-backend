import mongoose from 'mongoose';
import Outlet from '../models/Outlet.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { decryptSecret, encryptSecret } from '../utils/secretBox.js';
import {
  checkPraConfiguration,
  modeForPra,
  posIdForPra,
  submitCreditToPra,
  submitSaleToPra,
  tokenForPra,
} from '../services/pra.service.js';

const validId = (id) => (id && mongoose.isValidObjectId(id) ? id : null);
const text = (value) => (typeof value === 'string' ? value.trim() : undefined);
const pctCode = (value) => text(value)?.replace(/[.\s-]/g, '');
const parsePosId = (value) => {
  if (value === undefined) return { supplied: false };
  if (value === null || String(value).trim() === '') return { supplied: true, value: undefined };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { supplied: true, value: parsed }
    : { supplied: true, error: 'PRA POS ID must be a positive whole number.' };
};

const staticIps = () => String(process.env.PRA_STATIC_IPS || '34.232.217.139,18.213.181.255')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const maskedPra = (pra = {}) => ({
  enabled: Boolean(pra.enabled),
  mode: modeForPra(pra),
  sandboxPosId: pra.sandboxPosId || '',
  productionPosId: pra.productionPosId || '',
  defaultPctCode: pra.defaultPctCode || '',
  hasSandboxToken: Boolean(decryptSecret(pra.sandboxToken)),
  usesSharedSandboxToken: !decryptSecret(pra.sandboxToken) && Boolean(String(process.env.PRA_SANDBOX_TOKEN || '').trim()),
  hasProductionToken: Boolean(decryptSecret(pra.productionToken)),
  staticIps: staticIps(),
  ...checkPraConfiguration(pra),
});

export const getPraConfig = async (req, res) => {
  const outletId = validId(req.query.outlet);
  if (!outletId) return res.status(400).json({ success: false, message: 'A valid outlet is required.' });
  const outlet = await Outlet.findById(outletId).select('pra name').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });
  return res.json({ success: true, data: { ...maskedPra(outlet.pra || {}), outlet: outletId } });
};

export const updatePraConfig = async (req, res) => {
  const outletId = validId(req.query.outlet);
  if (!outletId) return res.status(400).json({ success: false, message: 'A valid outlet is required.' });
  const outlet = await Outlet.findById(outletId);
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  const body = req.body || {};
  if (body.mode !== undefined && !['sandbox', 'production'].includes(body.mode)) {
    return res.status(422).json({ success: false, message: 'Mode must be sandbox or production.' });
  }

  const pra = outlet.pra || {};
  if (body.enabled !== undefined) pra.enabled = Boolean(body.enabled);
  if (body.mode !== undefined) pra.mode = body.mode;
  const sandboxPos = parsePosId(body.sandboxPosId);
  const productionPos = parsePosId(body.productionPosId);
  if (sandboxPos.error || productionPos.error) {
    return res.status(422).json({ success: false, message: sandboxPos.error || productionPos.error });
  }
  if (sandboxPos.supplied) pra.sandboxPosId = sandboxPos.value;
  if (productionPos.supplied) pra.productionPosId = productionPos.value;
  if (body.defaultPctCode !== undefined) pra.defaultPctCode = pctCode(body.defaultPctCode);

  if (typeof body.sandboxToken === 'string' && body.sandboxToken.trim()) {
    pra.sandboxToken = encryptSecret(body.sandboxToken.trim());
  }
  if (body.clearSandboxToken) pra.sandboxToken = undefined;
  if (typeof body.productionToken === 'string' && body.productionToken.trim()) {
    pra.productionToken = encryptSecret(body.productionToken.trim());
  }
  if (body.clearProductionToken) pra.productionToken = undefined;

  // Removing the active credential is always allowed; reporting is disabled in
  // the same update so no new sale enters a permanently unreportable state.
  if ((body.clearSandboxToken && modeForPra(pra) === 'sandbox')
    || (body.clearProductionToken && modeForPra(pra) === 'production')) {
    pra.enabled = false;
  }

  const mode = modeForPra(pra);
  if (pra.defaultPctCode && !/^\d{8}$/.test(pra.defaultPctCode)) {
    return res.status(422).json({ success: false, message: 'PRA PCT code must contain exactly 8 digits.' });
  }
  if (pra.enabled) {
    if (!posIdForPra(pra, mode)) {
      return res.status(422).json({ success: false, message: `Enter a valid PRA ${mode} POS ID before enabling reporting.` });
    }
    if (!tokenForPra(pra, mode)) {
      return res.status(422).json({ success: false, message: `Enter the PRA ${mode} bearer token before enabling reporting.` });
    }
    if (!pra.defaultPctCode) {
      return res.status(422).json({ success: false, message: 'Enter the 8-digit PRA PCT service code before enabling reporting.' });
    }
    const readiness = checkPraConfiguration(pra);
    if (!readiness.ok) {
      return res.status(422).json({ success: false, message: readiness.message });
    }
  }

  outlet.pra = pra;
  await outlet.save();
  return res.json({ success: true, data: { ...maskedPra(outlet.pra || {}), outlet: outletId } });
};

// This is intentionally a local readiness check: PRA documents no harmless
// token-validation endpoint, and POSTing a fake invoice would create fiscal data.
export const checkPraSetup = async (req, res) => {
  const outletId = validId(req.query.outlet);
  if (!outletId) return res.status(400).json({ success: false, message: 'A valid outlet is required.' });
  const outlet = await Outlet.findById(outletId).select('pra').lean();
  if (!outlet) return res.status(404).json({ success: false, message: 'Outlet not found.' });

  const pra = { ...(outlet.pra || {}) };
  const mode = req.body?.mode || modeForPra(pra);
  if (!['sandbox', 'production'].includes(mode)) {
    return res.status(422).json({ success: false, message: 'Mode must be sandbox or production.' });
  }
  pra.mode = mode;
  if (req.body?.posId !== undefined) {
    const parsed = parsePosId(req.body.posId);
    if (parsed.error) return res.status(422).json({ success: false, message: parsed.error });
    if (mode === 'production') pra.productionPosId = parsed.value;
    else pra.sandboxPosId = parsed.value;
  }
  if (typeof req.body?.token === 'string' && req.body.token.trim()) {
    // Avoid persisting the unsaved token while still including it in readiness.
    if (mode === 'production') pra.productionToken = encryptSecret(req.body.token.trim());
    else pra.sandboxToken = encryptSecret(req.body.token.trim());
  }
  if (req.body?.defaultPctCode !== undefined) pra.defaultPctCode = pctCode(req.body.defaultPctCode);

  const result = checkPraConfiguration(pra);
  return res.status(result.ok ? 200 : 422).json({ success: result.ok, data: result, message: result.message });
};

export const retryPra = async (req, res) => {
  const saleId = validId(req.params.saleId);
  if (!saleId) return res.status(400).json({ success: false, message: 'Invalid sale id.' });
  const transaction = await SaleTransaction.findById(saleId);
  if (!transaction) return res.status(404).json({ success: false, message: 'Sale not found.' });

  const isCredit = ['void', 'refunded'].includes(transaction.status)
    && transaction.pra?.status === 'reported';
  const current = isCredit ? transaction.pra?.credit : transaction.pra;
  if (current?.status === 'reported' && current?.invoiceNumber) {
    return res.status(409).json({ success: false, message: `This PRA ${isCredit ? 'credit' : 'sale'} invoice is already reported.`, data: current });
  }

  const result = isCredit
    ? await submitCreditToPra(transaction)
    : await submitSaleToPra(transaction);
  if (!result) {
    return res.status(409).json({ success: false, message: 'PRA reporting is not applicable or is not configured for this transaction.' });
  }
  return res.json({ success: true, data: result, invoiceType: isCredit ? 'credit' : 'sale' });
};
