// Punjab Revenue Authority eIMS cloud fiscal-invoicing integration.
//
// Cloud POS systems post directly to PRA's sandbox/production endpoints; the
// Windows .exe/local port 8524 component described in the PRA guide is only for
// an on-premises Windows POS. Every outlet has its own PRA POS registration.

import { fetch as undiciFetch, ProxyAgent } from 'undici';
import MenuItem from '../models/MenuItem.js';
import Outlet from '../models/Outlet.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { decryptSecret } from '../utils/secretBox.js';
import logger from '../utils/logger.js';

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const clampText = (value, max) => String(value ?? '').trim().slice(0, max);
const creditUsin = (value) => `${clampText(value, 47)}-CR`;

export const PRA_POST_URL = Object.freeze({
  sandbox: process.env.PRA_SANDBOX_URL || 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData',
  production: process.env.PRA_PRODUCTION_URL || 'https://ims.pral.com.pk/ims/production/api/Live/PostData',
});

const TIMEOUT_MS = Math.max(1_000, Number(process.env.PRA_TIMEOUT_MS) || 8_000);
const PRA_PROXY_URL = (
  process.env.PRA_PROXY_URL
  || process.env.QUOTAGUARDSTATIC_URL
  || process.env.FIXIE_URL
  || ''
).trim();
const praDispatcher = PRA_PROXY_URL ? new ProxyAgent(PRA_PROXY_URL) : null;

export const isPraStaticEgressConfigured = () => Boolean(praDispatcher);

export const modeForPra = (pra) => (pra?.mode === 'production' ? 'production' : 'sandbox');

export const posIdForPra = (pra, requestedMode = modeForPra(pra)) => {
  const raw = requestedMode === 'production' ? pra?.productionPosId : pra?.sandboxPosId;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export const tokenForPra = (pra, requestedMode = modeForPra(pra)) => {
  if (!pra) return '';
  const encrypted = requestedMode === 'production' ? pra.productionToken : pra.sandboxToken;
  const stored = decryptSecret(encrypted);
  if (stored) return stored;
  // PRA publishes one shared sandbox bearer token in the technical guide. Keep
  // it in server configuration rather than copying it into every tenant DB.
  return requestedMode === 'sandbox' ? String(process.env.PRA_SANDBOX_TOKEN || '').trim() : '';
};

export const isPraEnabled = (pra) => {
  const mode = modeForPra(pra);
  return Boolean(
    pra?.enabled
    && isPraModeConfigured(pra, mode),
  );
};

export const isPraModeConfigured = (pra, mode = modeForPra(pra)) => Boolean(
  posIdForPra(pra, mode)
  && tokenForPra(pra, mode)
  && /^\d{8}$/.test(String(pra?.defaultPctCode || ''))
  && (mode !== 'production' || isPraStaticEgressConfigured()),
);

export const initialPraState = (pra) => {
  if (!isPraEnabled(pra)) return null;
  return { status: 'pending', mode: modeForPra(pra) };
};

export const initialPraCreditState = (transaction, pra) => {
  if (transaction?.pra?.status !== 'reported' || !transaction?.pra?.invoiceNumber) {
    return null;
  }
  const refUsin = clampText(transaction.pra.usin || transaction.transactionNumber, 50);
  return {
    status: 'pending',
    // A credit must go back to the same PRA environment as its original sale.
    mode: transaction.pra.mode || modeForPra(pra),
    usin: creditUsin(refUsin),
    refUsin,
    requestedAt: new Date(),
  };
};

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await undiciFetch(url, {
      ...options,
      signal: controller.signal,
      ...(praDispatcher ? { dispatcher: praDispatcher } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
};

const praDateTime = (value, timezone = 'Asia/Karachi') => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

export const praPaymentMode = (paymentMethod) => {
  if (paymentMethod === 'cash') return 1;
  if (paymentMethod === 'card' || paymentMethod === 'online-transfer' || paymentMethod === 'foodpanda') return 2;
  if (paymentMethod === 'allowance' || paymentMethod === 'charge-to-salary') return 4;
  if (paymentMethod === 'split' || paymentMethod === 'split-bill') return 5;
  return 5;
};

const allocateMoney = (amount, weights) => {
  const total = round2(amount);
  if (!weights.length) return [];
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  let allocated = 0;
  return safeWeights.map((weight, index) => {
    if (index === safeWeights.length - 1) return round2(total - allocated);
    const share = weightTotal > 0 ? round2(total * (weight / weightTotal)) : 0;
    allocated = round2(allocated + share);
    return share;
  });
};

const buyerFields = (transaction) => {
  const customer = transaction.customer && typeof transaction.customer === 'object'
    ? transaction.customer
    : null;
  const name = customer?.name
    || transaction.qrOrder?.customerName
    || transaction.foodPandaCustomerName
    || '';
  const phone = customer?.phone || transaction.qrOrder?.customerPhone || '';
  return {
    ...(name ? { BuyerName: clampText(name, 150) } : {}),
    ...(phone ? { BuyerPhoneNumber: clampText(phone, 20) } : {}),
  };
};

// Pure payload builder exported for contract tests. Amounts are allocated so
// sum(Item.TotalAmount) always equals TotalBillAmount to the paisa, including
// service/delivery charges and order-level discounts.
export const buildPraInvoicePayload = (
  transaction,
  pra,
  menuPraById = {},
  { invoiceType = 1, timezone = 'Asia/Karachi' } = {},
) => {
  const mode = modeForPra(pra);
  const posId = posIdForPra(pra, mode);
  if (!posId) throw new Error(`A valid PRA ${mode} POS ID is required.`);

  const lines = transaction.items || [];
  if (!lines.length) throw new Error('PRA requires at least one invoice item.');

  const lineWeights = lines.map((item) => Math.max(0, Number(item.lineTotal) || 0));
  const extraValue = round2(
    Number(transaction.serviceChargeAmount || 0) + Number(transaction.deliveryChargeAmount || 0),
  );
  const discountTotal = round2(
    Number(transaction.discountAmount || 0) + Number(transaction.pointsRedeemedValue || 0),
  );
  const extraShares = allocateMoney(extraValue, lineWeights);
  const discountShares = allocateMoney(discountTotal, lineWeights);
  const refUsin = invoiceType === 3
    ? clampText(transaction.pra?.usin || transaction.transactionNumber, 50)
    : null;
  const baseUsin = clampText(transaction.transactionNumber, 50);
  const usin = invoiceType === 3
    ? clampText(transaction.pra?.credit?.usin || creditUsin(baseUsin), 50)
    : baseUsin;

  const items = lines.map((item, index) => {
    const menuId = item.menuItem?._id || item.menuItem;
    const override = item.pra || (menuId ? menuPraById[String(menuId)] : null);
    const pctCode = clampText(override?.pctCode || pra.defaultPctCode, 8);
    if (!pctCode) throw new Error(`PRA PCT code is missing for item "${item.name || index + 1}".`);
    if (!/^\d{8}$/.test(pctCode)) throw new Error(`PRA PCT code for item "${item.name || index + 1}" must contain exactly 8 digits.`);
    const saleValue = round2(Number(item.lineTotal || 0) + extraShares[index]);
    const taxCharged = round2(item.taxAmount);
    const discount = discountShares[index];
    return {
      ItemCode: clampText(override?.itemCode || menuId || `ITEM-${index + 1}`, 50),
      ItemName: clampText(`${item.name || `Item ${index + 1}`}${item.variation?.name ? ` (${item.variation.name})` : ''}`, 150),
      PCTCode: pctCode,
      Quantity: Number(item.qty) || 0,
      TaxRate: Number(item.taxRate) || 0,
      SaleValue: saleValue,
      Discount: discount,
      FurtherTax: 0,
      TaxCharged: taxCharged,
      TotalAmount: round2(saleValue + taxCharged - discount),
      InvoiceType: invoiceType,
      RefUSIN: refUsin,
    };
  });

  const totalSaleValue = round2(items.reduce((sum, item) => sum + item.SaleValue, 0));
  const totalTax = round2(items.reduce((sum, item) => sum + item.TaxCharged, 0));
  const totalDiscount = round2(items.reduce((sum, item) => sum + item.Discount, 0));
  const calculatedBill = round2(items.reduce((sum, item) => sum + item.TotalAmount, 0));
  const storedBill = round2(transaction.totalAmount);
  if (Math.abs(calculatedBill - storedBill) > 0.01) {
    throw new Error(`PRA invoice total ${calculatedBill} does not match sale total ${storedBill}.`);
  }

  return {
    InvoiceNumber: '',
    POSID: posId,
    USIN: usin,
    RefUSIN: refUsin,
    DateTime: praDateTime(
      invoiceType === 3
        ? transaction.pra?.credit?.requestedAt || transaction.voidedAt || Date.now()
        : transaction.createdAt,
      timezone,
    ),
    ...buyerFields(transaction),
    TotalSaleValue: totalSaleValue,
    TotalTaxCharged: totalTax,
    Discount: totalDiscount,
    FurtherTax: 0,
    TotalBillAmount: storedBill,
    TotalQuantity: lines.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
    PaymentMode: praPaymentMode(transaction.paymentMethod),
    InvoiceType: invoiceType,
    Items: items,
  };
};

const errorFromPra = (json, fallback) => {
  const errors = Array.isArray(json?.Errors)
    ? json.Errors.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('; ')
    : json?.Errors;
  return clampText(errors || json?.Response || json?.Message || json?.message || fallback, 1_000);
};

// PRA's sample response shows InvoiceNumber as an unquoted 20-digit number.
// JSON.parse cannot preserve integers that large, so extract it from the raw
// response before parsing to keep the printed number and QR exact.
export const parsePraResponse = (raw) => {
  const source = String(raw || '');
  const match = source.match(/"InvoiceNumber"\s*:\s*(?:"([^"]+)"|([0-9A-Za-z_-]+))/i);
  let json = null;
  try { json = JSON.parse(source); } catch { /* PRA occasionally returns non-JSON error text */ }
  return {
    json,
    invoiceNumber: match?.[1] || match?.[2] || (json?.InvoiceNumber != null ? String(json.InvoiceNumber) : ''),
  };
};

const postPraPayload = async ({ payload, token, mode }) => {
  try {
    const response = await fetchWithTimeout(PRA_POST_URL[mode], {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    const { json, invoiceNumber } = parsePraResponse(raw);
    const responseCode = clampText(json?.Code || response.status, 30);
    if (response.ok && String(json?.Code) === '100' && invoiceNumber) {
      return {
        status: 'reported',
        invoiceNumber,
        responseCode,
      };
    }
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return {
      status: retryable ? 'pending' : 'failed',
      responseCode,
      error: errorFromPra(json, `PRA returned HTTP ${response.status}.`),
    };
  } catch (error) {
    return {
      status: 'pending',
      error: error.name === 'AbortError' ? 'PRA request timed out.' : error.message,
    };
  }
};

const submitToPra = async (transaction, invoiceType) => {
  const resultPath = invoiceType === 3 ? 'pra.credit' : 'pra';
  const statusPath = `${resultPath}.status`;
  const invoicePath = `${resultPath}.invoiceNumber`;
  let claimed = false;

  try {
    if (!transaction) return null;
    if (invoiceType === 1 && transaction.status !== 'completed') {
      if (transaction.pra?.status && transaction.pra.status !== 'reported') {
        await SaleTransaction.updateOne(
          { _id: transaction._id, 'pra.status': { $nin: ['reported', 'skipped'] } },
          { $set: { 'pra.status': 'skipped', 'pra.error': 'Sale was cancelled before PRA accepted the invoice.' } },
        );
        transaction.pra.status = 'skipped';
        transaction.pra.error = 'Sale was cancelled before PRA accepted the invoice.';
      }
      return transaction.pra || null;
    }
    if (invoiceType === 3 && !['void', 'refunded'].includes(transaction.status)) return null;

    const existing = invoiceType === 3 ? transaction.pra?.credit : transaction.pra;
    if (existing?.status === 'reported' && existing?.invoiceNumber) return existing;
    if (invoiceType === 3 && (transaction.pra?.status !== 'reported' || !transaction.pra?.invoiceNumber)) {
      return null;
    }

    const outlet = await Outlet.findById(transaction.outlet).select('pra timezone').lean();
    const pra = outlet?.pra || {};
    const mode = existing?.mode || transaction.pra?.mode || modeForPra(pra);
    const effectivePra = { ...pra, mode };
    const ready = isPraModeConfigured(effectivePra, mode);
    const allowed = invoiceType === 3 ? ready : Boolean(pra.enabled && ready);
    if (!allowed) {
      const error = invoiceType === 3
        ? `The original ${mode} PRA configuration is unavailable; the required credit invoice remains pending.`
        : 'PRA is disabled or the original sale environment is no longer configured; the invoice remains pending.';
      if (existing?.status && existing.status !== 'reported') {
        await SaleTransaction.updateOne(
          { _id: transaction._id, [statusPath]: { $ne: 'reported' } },
          { $set: { [statusPath]: 'pending', [`${resultPath}.mode`]: mode, [`${resultPath}.error`]: error } },
        );
        existing.status = 'pending';
        existing.mode = mode;
        existing.error = error;
      }
      return existing || null;
    }

    const token = tokenForPra(effectivePra, mode);
    const claim = await SaleTransaction.findOneAndUpdate(
      {
        _id: transaction._id,
        [statusPath]: { $nin: ['reported', 'submitting'] },
        [invoicePath]: { $exists: false },
      },
      { $set: { [statusPath]: 'submitting', [`${resultPath}.mode`]: mode, [`${resultPath}.submittedAt`]: new Date() } },
      { returnDocument: 'after' },
    );
    if (!claim) return existing || null;
    claimed = true;

    const ids = (transaction.items || []).map((item) => item.menuItem).filter(Boolean);
    const menuItems = ids.length
      ? await MenuItem.find({ _id: { $in: ids } }).select('pra').lean()
      : [];
    const menuPraById = Object.fromEntries(menuItems.map((item) => [String(item._id), item.pra || null]));

    let result;
    let payload;
    try {
      payload = buildPraInvoicePayload(transaction, effectivePra, menuPraById, {
        invoiceType,
        timezone: outlet.timezone || 'Asia/Karachi',
      });
      result = await postPraPayload({ payload, token, mode });
    } catch (error) {
      result = { status: 'failed', error: error.message };
    }

    const saved = {
      status: result.status,
      invoiceNumber: result.invoiceNumber || undefined,
      responseCode: result.responseCode || undefined,
      error: result.error || undefined,
      mode,
      usin: payload?.USIN || existing?.usin || clampText(
        invoiceType === 3 ? creditUsin(transaction.transactionNumber) : transaction.transactionNumber,
        50,
      ),
      ...(invoiceType === 3 ? {
        refUsin: payload?.RefUSIN || transaction.pra?.usin || transaction.transactionNumber,
        requestedAt: existing?.requestedAt || new Date(),
      } : {}),
      submittedAt: new Date(),
    };
    await SaleTransaction.updateOne({ _id: transaction._id }, { $set: { [resultPath]: saved } });
    if (invoiceType === 3) {
      transaction.pra.credit = saved;
    } else {
      transaction.pra = { ...(transaction.pra?.toObject?.() || transaction.pra || {}), ...saved };
    }

    logger.info(
      `[PRA] ${invoiceType === 3 ? 'credit' : 'sale'} ${transaction.transactionNumber}: `
      + `${saved.status}${saved.invoiceNumber ? ` (${saved.invoiceNumber})` : ''}`
      + `${saved.error ? ` — ${saved.error}` : ''}`,
    );
    return saved;
  } catch (error) {
    logger.error(`[PRA] submission failed for ${transaction?.transactionNumber || '?'}: ${error.message}`);
    if (claimed) {
      await SaleTransaction.updateOne(
        { _id: transaction._id, [statusPath]: 'submitting' },
        { $set: { [statusPath]: 'pending', [`${resultPath}.error`]: 'Interrupted; will retry.' } },
      ).catch(() => {});
    }
    return null;
  }
};

export const submitSaleToPra = (transaction) => submitToPra(transaction, 1);
export const submitCreditToPra = (transaction) => submitToPra(transaction, 3);

// PRA does not document a harmless read-only cloud authentication endpoint.
// This check deliberately validates local readiness without creating a fiscal
// invoice. The actual end-to-end test is a sandbox sale using a Test POS ID.
export const checkPraConfiguration = (pra) => {
  const mode = modeForPra(pra);
  const missing = [];
  if (!posIdForPra(pra, mode)) missing.push(`${mode} POS ID`);
  if (!tokenForPra(pra, mode)) missing.push(`${mode} bearer token`);
  if (!/^\d{8}$/.test(String(pra?.defaultPctCode || ''))) missing.push('default PCT code (8 digits)');
  if (mode === 'production' && !isPraStaticEgressConfigured()) missing.push('static outbound IP proxy');
  return {
    ok: missing.length === 0,
    mode,
    endpoint: PRA_POST_URL[mode],
    staticEgressConfigured: isPraStaticEgressConfigured(),
    missing,
    message: missing.length
      ? `Missing: ${missing.join(', ')}.`
      : mode === 'sandbox'
        ? 'Configuration is ready. Complete the end-to-end test by submitting a sale with the PRA Test POS ID.'
        : 'Production configuration is ready for a live sale after PRA confirms the server IP whitelist.',
  };
};
