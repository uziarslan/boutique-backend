import crypto from 'crypto';
import mongoose from 'mongoose';
import SaleSession from '../models/SaleSession.js';
import SaleTransaction from '../models/SaleTransaction.js';
import RetailVariant from '../models/RetailVariant.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import Outlet from '../models/Outlet.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { getBusinessDate } from '../utils/businessDate.js';
import generateTransactionNumber from '../utils/transactionNumber.js';
import { postSale } from '../accounting/journalEngine.js';
import { enforceManualDiscountLimit } from '../utils/posDiscountLimit.js';
import { refreshClosedSessionTotals } from './sale.controller.js';

const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, code });
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const idText = (value) => String(value || '').trim();

const saleResult = (transaction) => ({
  _id: transaction._id,
  transactionNumber: transaction.transactionNumber,
  clientTransactionId: transaction.clientTransactionId,
  status: transaction.status,
  totalAmount: transaction.totalAmount,
  createdAt: transaction.createdAt,
  offlineSync: transaction.offlineSync,
});

const normalizeTender = (payload, total) => {
  const paymentMethod = String(payload.paymentMethod || 'cash');
  if (!['cash', 'card', 'online-transfer', 'split'].includes(paymentMethod)) throw fail('Choose cash, card, online transfer, or split payment.');
  let cashAmount = 0;
  let cardAmount = 0;
  let onlineTransferAmount = 0;
  let cashTendered = 0;
  let changeGiven = 0;
  if (paymentMethod === 'cash') {
    cashAmount = total;
    cashTendered = Number(payload.cashTendered ?? total);
    if (!Number.isFinite(cashTendered) || cashTendered < total) throw fail('Cash tendered is less than the sale total.', 422);
    changeGiven = round2(cashTendered - total);
  } else if (paymentMethod === 'card') {
    cardAmount = total;
  } else if (paymentMethod === 'online-transfer') {
    onlineTransferAmount = total;
  } else {
    cashAmount = round2(Number(payload.cashAmount || 0));
    cardAmount = round2(Number(payload.cardAmount || 0));
    if (cashAmount < 0 || cardAmount < 0 || round2(cashAmount + cardAmount) !== total) {
      throw fail('Split payment amounts must add up to the sale total.', 422);
    }
    cashTendered = Number(payload.cashTendered ?? cashAmount);
    if (cashTendered < cashAmount) throw fail('Cash tendered is less than the cash portion.', 422);
    changeGiven = round2(cashTendered - cashAmount);
  }
  return { paymentMethod, cashAmount, cardAmount, onlineTransferAmount, cashTendered, changeGiven };
};

const processSale = async ({ payload, actor, offline = false }) => {
  const clientTransactionId = idText(payload.clientTransactionId);
  if (!clientTransactionId || clientTransactionId.length > 120) throw fail('A valid client transaction ID is required.', 422);
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) throw fail('A sale must contain between 1 and 100 product lines.', 422);
  if (offline && idText(payload.cashierId) !== String(actor.id)) throw fail('This offline sale belongs to another cashier.', 403, 'CASHIER_MISMATCH');

  const queuedAt = offline ? new Date(payload.queuedAt) : new Date();
  if (offline && (Number.isNaN(queuedAt.getTime()) || queuedAt.getTime() > Date.now() + 10 * 60_000)) {
    throw fail('The offline sale timestamp is invalid or too far in the future.', 422, 'INVALID_QUEUED_AT');
  }
  const existing = await SaleTransaction.findOne({ clientTransactionId });
  if (existing) {
    if (String(existing.cashier || '') !== String(actor.id)) throw fail('This transaction ID is already used by a different cashier.', 409, 'DUPLICATE_TRANSACTION');
    return { kind: 'skipped', transaction: existing };
  }

  const sessionId = idText(payload.sessionId);
  if (!mongoose.isValidObjectId(sessionId)) throw fail('An open cashier session is required.', 422);
  const cashierSession = await SaleSession.findOne({ _id: sessionId, cashier: actor.id });
  if (!cashierSession) throw fail('The original cashier session was not found.', 404, 'SESSION_NOT_FOUND');
  if (!offline && cashierSession.status !== 'open') throw fail('Open a cashier session before recording a sale.', 409);
  const outlet = await Outlet.findById(cashierSession.outlet).lean();
  if (!outlet || outlet.isActive === false) throw fail('The cashier session outlet is not active.', 409);
  if (payload.outletCode && String(payload.outletCode) !== String(outlet.code)) throw fail('The offline sale outlet does not match its cashier session.', 409, 'OUTLET_MISMATCH');

  const requested = payload.items.map((item) => ({
    variantId: idText(item.variantId || item.id),
    shopifyLocationId: idText(item.shopifyLocationId),
    quantity: Number(item.quantity ?? item.qty),
    unitPriceSnapshot: item.unitPriceSnapshot == null ? null : Number(item.unitPriceSnapshot),
  }));
  if (requested.some((item) => !mongoose.isValidObjectId(item.variantId)
    || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000
    || (offline && (!Number.isFinite(item.unitPriceSnapshot) || item.unitPriceSnapshot < 0)))) {
    throw fail('One or more product lines have an invalid variant, quantity, or offline price snapshot.', 422);
  }
  const merged = new Map();
  for (const item of requested) {
    const key = `${item.variantId}:${item.shopifyLocationId}`;
    const current = merged.get(key);
    if (current) current.quantity += item.quantity;
    else merged.set(key, { ...item });
  }

  const variants = await RetailVariant.find({ _id: { $in: [...new Set([...merged.values()].map((line) => line.variantId))] } })
    .populate('product', 'title')
    .lean();
  const variantsById = new Map(variants.map((variant) => [String(variant._id), variant]));
  const prepared = [];
  for (const line of merged.values()) {
    const variant = variantsById.get(line.variantId);
    if (!variant) throw fail(`Retail variant ${line.variantId} is not in the local catalog. Refresh the POS catalog and retry.`, 409, 'VARIANT_NOT_FOUND');
    if (variant.deletedAt) throw fail(`${variant.product?.title || variant.title} was deleted from Shopify and is no longer available.`, 409, 'VARIANT_DELETED');
    if (!offline && !variant.isActive) throw fail(`${variant.product?.title || variant.title} is no longer active.`, 409, 'VARIANT_INACTIVE');
    const location = (variant.inventoryByLocation || []).find((stock) => String(stock.outlet || '') === String(outlet._id)
      && (!line.shopifyLocationId || stock.shopifyLocationId === line.shopifyLocationId));
    if (variant.tracked && !location) throw fail(`${variant.product?.title || variant.title} has no stock record for this outlet.`, 409, 'LOCATION_NOT_MAPPED');
    if (variant.tracked && !offline && Number(location.available || 0) < line.quantity) {
      throw fail(`Not enough stock for ${variant.product?.title || variant.title} ${variant.title === 'Default Title' ? '' : variant.title}.`, 409, 'INSUFFICIENT_STOCK');
    }
    const currentPrice = round2(variant.price);
    const unitPrice = offline ? round2(line.unitPriceSnapshot) : currentPrice;
    const priceMismatch = offline && Math.abs(unitPrice - currentPrice) >= 0.01;
    prepared.push({
      variant,
      location,
      quantity: line.quantity,
      unitPrice,
      currentPrice,
      priceMismatch,
      availableBefore: Number(location?.available || 0),
      title: [variant.product?.title, variant.title !== 'Default Title' ? variant.title : ''].filter(Boolean).join(' · ') || 'Retail product',
    });
  }
  const subtotal = round2(prepared.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0));
  const discountMode = payload.discountMode === 'percent' ? 'percent' : 'amount';
  const rawDiscount = Number(discountMode === 'percent' ? (payload.discountPercent ?? payload.discountValue ?? 0) : (payload.discountAmount || 0));
  if (!Number.isFinite(rawDiscount) || rawDiscount < 0 || (discountMode === 'percent' && rawDiscount > 100)) {
    throw fail('Enter a valid discount percentage or amount.', 422);
  }
  const discountPercent = discountMode === 'percent' ? rawDiscount : 0;
  const discountAmount = round2(discountMode === 'percent' ? subtotal * discountPercent / 100 : rawDiscount);
  if (!Number.isFinite(discountAmount) || discountAmount < 0 || discountAmount > subtotal) throw fail('Discount must be between zero and the sale subtotal.', 422);
  enforceManualDiscountLimit({ cashier: actor, subtotal, orderDiscount: discountAmount });
  const totalAmount = round2(subtotal - discountAmount);
  if (totalAmount <= 0) throw fail('The sale total must be greater than zero.', 422);
  const tender = normalizeTender(payload, totalAmount);
  const allocatedDiscount = prepared.map((line) => round2(discountAmount * (line.unitPrice * line.quantity) / subtotal));
  if (allocatedDiscount.length) allocatedDiscount[allocatedDiscount.length - 1] = round2(discountAmount - allocatedDiscount.slice(0, -1).reduce((sum, value) => sum + value, 0));

  const businessDate = getBusinessDate(queuedAt, outlet.timezone || 'Asia/Karachi', outlet.businessDayStart || '00:00', outlet.businessDayEnd || outlet.businessDayStart || '00:00');
  const transactionNumber = await generateTransactionNumber(businessDate);
  const saleItems = prepared.map((line, index) => {
    const listedTotal = round2(line.unitPrice * line.quantity);
    const lineDiscount = allocatedDiscount[index];
    const lineTotal = round2(listedTotal - lineDiscount);
    return {
      retailVariant: line.variant._id,
      externalItemId: line.variant.shopifyVariantId,
      skuSnapshot: line.variant.sku,
      barcodeSnapshot: line.variant.barcode,
      optionsSnapshot: line.variant.options,
      unitCostSnapshot: Number(line.variant.unitCost || 0),
      unitCostStatusSnapshot: line.variant.unitCostStatus || 'review',
      offlinePriceMismatch: line.priceMismatch,
      name: line.title,
      qty: line.quantity,
      listedUnitPrice: line.unitPrice,
      unitPrice: lineTotal / line.quantity,
      lineTotal,
      taxAmount: 0,
      taxRate: 0,
      serviceChargeAmount: 0,
      serviceChargeRate: 0,
      discountAmount: lineDiscount,
    };
  });
  const costOfGoodsSold = round2(prepared.reduce((sum, line) => sum + Number(line.variant.unitCost || 0) * line.quantity, 0));
  const rawCardLast4 = payload.cardLast4 == null || payload.cardLast4 === '' ? '' : String(payload.cardLast4).replace(/\D/g, '');
  if (rawCardLast4 && rawCardLast4.length !== 4) throw fail('Card last four digits must contain exactly four digits.', 422);
  const cashLast4 = rawCardLast4 || null;

  const mongoSession = await getTenantConnection().startSession();
  let transaction;
  try {
    await mongoSession.withTransaction(async () => {
      const [created] = await SaleTransaction.create([{
        transactionNumber,
        outlet: outlet._id,
        businessDate,
        session: cashierSession._id,
        cashier: actor.id,
        items: saleItems,
        subtotal,
        taxAmount: 0,
        effectiveTaxRate: 0,
        serviceChargeAmount: 0,
        deliveryChargeAmount: 0,
        discountAmount,
        discountMode,
        discountPercent,
        totalAmount,
        paymentMethod: tender.paymentMethod,
        cashAmount: tender.cashAmount,
        cardAmount: tender.cardAmount,
        onlineTransferAmount: tender.onlineTransferAmount,
        cashTendered: tender.cashTendered,
        changeGiven: tender.changeGiven,
        cardLast4: cashLast4,
        status: 'completed',
        source: 'cashier',
        clientTransactionId,
        punchedAt: queuedAt,
        offlineSync: offline ? {
          queuedAt,
          originalSession: cashierSession._id,
          originalCashier: actor.id,
          syncedAt: new Date(),
          clientTotal: Number(payload.totalAmount || totalAmount),
        } : undefined,
        notes: String(payload.notes || '').slice(0, 500),
      }], { session: mongoSession });
      transaction = created;

      for (const [index, line] of prepared.entries()) {
        if (!line.variant.tracked || !line.location) continue;
        const currentVariant = await RetailVariant.findById(line.variant._id).session(mongoSession);
        const stockIndex = currentVariant.inventoryByLocation.findIndex((stock) => String(stock.outlet || '') === String(outlet._id)
          && stock.shopifyLocationId === line.location.shopifyLocationId);
        if (stockIndex < 0) throw fail('The outlet stock record changed during checkout. Refresh the POS catalog.', 409, 'LOCATION_CHANGED');
        const currentAvailable = Number(currentVariant.inventoryByLocation[stockIndex].available || 0);
        if (!offline && currentAvailable < line.quantity) throw fail('Another sale used this stock while checkout was open. Refresh the POS catalog.', 409, 'INSUFFICIENT_STOCK');
        const hasShopifyVariant = Boolean(currentVariant.shopifyVariantId);
        const syncConflict = hasShopifyVariant && offline && currentAvailable < line.quantity;
        currentVariant.inventoryByLocation[stockIndex].available = currentAvailable - line.quantity;
        currentVariant.inventoryByLocation[stockIndex].onHand = Number(currentVariant.inventoryByLocation[stockIndex].onHand || currentAvailable) - line.quantity;
        currentVariant.inventoryByLocation[stockIndex].updatedAt = new Date();
        await currentVariant.save({ session: mongoSession });
        const key = `${clientTransactionId}:${line.variant._id}:${line.location.shopifyLocationId}`;
        await RetailInventoryMovement.create([{
          variant: line.variant._id,
          outlet: outlet._id,
          shopifyLocationId: line.location.shopifyLocationId,
          quantityDelta: -line.quantity,
          unitCost: Number(line.variant.unitCost || 0),
          type: 'pos-sale',
          referenceType: 'sale-transaction',
          referenceId: String(transaction._id),
          idempotencyKey: crypto.createHash('sha256').update(key).digest('hex'),
          syncStatus: !hasShopifyVariant ? 'not-required' : syncConflict ? 'conflict' : 'pending',
          syncError: syncConflict ? 'Offline sale exceeded the last server stock snapshot; review before sending the adjustment to Shopify.' : '',
          createdBy: actor.id,
          occurredAt: queuedAt,
        }], { session: mongoSession });
      }
      transaction.journalEntryId = (await postSale(transaction, [], { costOfGoodsSold, session: mongoSession }))?._id || null;
      transaction.costOfGoodsSold = costOfGoodsSold;
      transaction.costingStatus = prepared.some((line) => line.variant.unitCost == null || line.variant.unitCostStatus !== 'complete') ? 'review' : 'complete';
      await transaction.save({ session: mongoSession });
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await SaleTransaction.findOne({ clientTransactionId });
      if (duplicate && String(duplicate.cashier || '') === String(actor.id)) return { kind: 'skipped', transaction: duplicate };
    }
    throw error;
  } finally {
    await mongoSession.endSession();
  }
  return { kind: 'synced', transaction };
};

export const processRetailSale = async (req, res) => {
  const result = await processSale({ payload: req.body, actor: req.user });
  res.status(result.kind === 'skipped' ? 200 : 201).json({ success: true, data: { transaction: saleResult(result.transaction), duplicate: result.kind === 'skipped' } });
};

export const syncRetailOfflineSales = async (req, res) => {
  if (!Array.isArray(req.body?.transactions) || req.body.transactions.length > 50) throw fail('Provide up to 50 offline retail sales per sync.');
  const synced = [];
  const skipped = [];
  const failed = [];
  const affectedClosedSessions = new Set();
  for (const payload of req.body.transactions) {
    try {
      const result = await processSale({ payload, actor: req.user, offline: true });
      (result.kind === 'skipped' ? skipped : synced).push(saleResult(result.transaction));
      if (result.transaction?.session) affectedClosedSessions.add(String(result.transaction.session));
    } catch (error) {
      failed.push({
        clientTransactionId: payload?.clientTransactionId || null,
        code: error.code || (error.statusCode === 409 ? 'RETAIL_CONFLICT' : 'RETAIL_SYNC_FAILED'),
        retryable: !error.code || !['CASHIER_MISMATCH', 'SESSION_NOT_FOUND', 'OUTLET_MISMATCH'].includes(error.code),
        error: error.message || 'Offline retail sale could not be synced.',
      });
    }
  }
  for (const sessionId of affectedClosedSessions) await refreshClosedSessionTotals(sessionId);
  res.json({ success: true, data: { synced, skipped, failed } });
};
