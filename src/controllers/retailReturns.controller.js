import crypto from 'crypto';
import mongoose from 'mongoose';
import SaleSession from '../models/SaleSession.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SaleReturn from '../models/SaleReturn.js';
import RetailVariant from '../models/RetailVariant.js';
import RetailInventoryMovement from '../models/RetailInventoryMovement.js';
import StoreCredit from '../models/StoreCredit.js';
import StoreCreditMovement from '../models/StoreCreditMovement.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { postRetailRefund } from '../accounting/journalEngine.js';

const fail = (message, statusCode = 400, code) => Object.assign(new Error(message), { statusCode, code });
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const makeReturnNumber = () => `RET-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const itemRefundUnit = (item) => round2((Number(item.lineTotal || 0) + Number(item.taxAmount || 0)) / Math.max(1, Number(item.qty || 1)));

const getSaleForReturn = async (transactionNumber) => {
  const sale = await SaleTransaction.findOne({ transactionNumber: String(transactionNumber || '').trim() })
    .populate('outlet', 'name code')
    .lean();
  if (!sale || !['completed', 'refunded'].includes(sale.status) || sale.source !== 'cashier') {
    throw fail('Completed boutique POS sale not found. Shopify online orders must be refunded in Shopify.', 404, 'SALE_NOT_FOUND');
  }
  return sale;
};

const returnedQuantities = async (saleId, session = null) => {
  const returns = await SaleReturn.find({ saleTransaction: saleId }).session(session).lean();
  const byIndex = new Map();
  let amount = 0;
  for (const ret of returns) {
    amount += Number(ret.refundAmount || 0);
    for (const line of ret.lines || []) byIndex.set(line.originalSaleItemIndex, (byIndex.get(line.originalSaleItemIndex) || 0) + Number(line.quantity || 0));
  }
  return { returns, byIndex, amount: round2(amount) };
};

export const getRetailSaleReturnable = async (req, res) => {
  const sale = await getSaleForReturn(req.query.transactionNumber);
  if (req.user.role === 'cashier') {
    const session = await SaleSession.findOne({ cashier: req.user.id, status: 'open' }).select('outlet').lean();
    if (!session || String(session.outlet) !== String(sale.outlet?._id || sale.outlet)) throw fail('This sale belongs to another outlet or there is no open shift.', 403);
  }
  const { byIndex } = await returnedQuantities(sale._id);
  const items = (sale.items || []).flatMap((item, index) => item.retailVariant ? [{
    index,
    name: item.name,
    sku: item.skuSnapshot || '',
    barcode: item.barcodeSnapshot || '',
    options: item.optionsSnapshot || [],
    soldQuantity: Number(item.qty || 0),
    returnedQuantity: byIndex.get(index) || 0,
    remainingQuantity: Math.max(0, Number(item.qty || 0) - (byIndex.get(index) || 0)),
    unitRefund: itemRefundUnit(item),
    restockUnitCost: Number(item.unitCostSnapshot || 0),
  }] : []);
  res.json({ success: true, data: { sale: {
    _id: sale._id,
    transactionNumber: sale.transactionNumber,
    outlet: sale.outlet,
    totalAmount: sale.totalAmount,
    createdAt: sale.createdAt,
    items,
  } } });
};

export const processRetailReturn = async (req, res) => {
  const clientReturnId = String(req.body?.clientReturnId || '').trim();
  if (!clientReturnId || clientReturnId.length > 120) throw fail('A return request ID is required.', 422);
  const duplicate = await SaleReturn.findOne({ clientReturnId }).populate('storeCredit').lean();
  if (duplicate) return res.json({ success: true, data: { return: duplicate, duplicate: true } });

  const saleId = String(req.body?.saleTransactionId || '').trim();
  if (!mongoose.isValidObjectId(saleId)) throw fail('Choose a valid POS sale.', 422);
  const inputLines = req.body?.lines;
  if (!Array.isArray(inputLines) || inputLines.length < 1 || inputLines.length > 50) throw fail('Choose at least one sale line to return.', 422);
  const refundMethod = String(req.body?.refundMethod || '').trim();
  if (!['cash', 'card', 'online-transfer', 'store-credit'].includes(refundMethod)) throw fail('Choose cash, card, online transfer, or store credit.', 422);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (reason.length < 3) throw fail('Enter a return reason with at least three characters.', 422);
  const normalized = inputLines.map((line) => ({
    originalSaleItemIndex: Number(line.originalSaleItemIndex),
    quantity: Number(line.quantity),
    restock: line.restock !== false,
    condition: ['resalable', 'damaged', 'altered', 'other'].includes(line.condition) ? line.condition : 'resalable',
    reason: String(line.reason || '').trim().slice(0, 300),
  }));
  if (normalized.some((line) => !Number.isInteger(line.originalSaleItemIndex) || !Number.isInteger(line.quantity) || line.quantity < 1)) {
    throw fail('Return quantities and sale lines must be whole numbers.', 422);
  }
  const actorId = req.user.id;
  const activeSession = req.user.role === 'cashier'
    ? await SaleSession.findOne({ cashier: actorId, status: 'open' }).select('outlet').lean()
    : null;
  if (req.user.role === 'cashier' && !activeSession) throw fail('Open a cashier shift before recording a return.', 409);

  const connection = getTenantConnection();
  const session = await connection.startSession();
  let savedReturn;
  try {
    await session.withTransaction(async () => {
      const sale = await SaleTransaction.findById(saleId).session(session);
      if (!sale || sale.source !== 'cashier' || !['completed', 'refunded'].includes(sale.status)) throw fail('Completed boutique POS sale not found.', 404, 'SALE_NOT_FOUND');
      if (activeSession && String(activeSession.outlet) !== String(sale.outlet)) throw fail('This sale belongs to another outlet.', 403);
      const prior = await returnedQuantities(sale._id, session);
      const lineByIndex = new Map();
      let refundAmount = 0;
      let taxAmount = 0;
      let unitCostReturned = 0;
      const savedLines = [];
      const inventoryRows = [];
      const deduped = new Map();
      for (const line of normalized) {
        const current = deduped.get(line.originalSaleItemIndex);
        if (current) {
          current.quantity += line.quantity;
          current.restock = current.restock && line.restock;
          if (current.condition !== line.condition) current.condition = 'other';
          current.reason ||= line.reason;
        } else deduped.set(line.originalSaleItemIndex, { ...line });
      }
      for (const line of deduped.values()) {
        const original = sale.items[line.originalSaleItemIndex];
        if (!original?.retailVariant) throw fail(`Sale line ${line.originalSaleItemIndex + 1} is not a retail product.`, 422);
        const alreadyReturned = prior.byIndex.get(line.originalSaleItemIndex) || 0;
        if (alreadyReturned + line.quantity > Number(original.qty || 0)) throw fail(`Return quantity exceeds the remaining quantity for ${original.name}.`, 409, 'RETURN_QTY_EXCEEDED');
        const unitRefund = itemRefundUnit(original);
        const unitTax = round2(Number(original.taxAmount || 0) / Math.max(1, Number(original.qty || 1)));
        refundAmount += unitRefund * line.quantity;
        taxAmount += unitTax * line.quantity;
        const returnableCost = line.restock && line.condition === 'resalable' ? Number(original.unitCostSnapshot || 0) * line.quantity : 0;
        unitCostReturned += returnableCost;
        savedLines.push({
          variant: original.retailVariant,
          originalSaleItemIndex: line.originalSaleItemIndex,
          quantity: line.quantity,
          unitRefund: round2(unitRefund - unitTax),
          restock: line.restock,
          condition: line.condition,
          reason: line.reason,
        });
        if (line.restock) {
          const variant = await RetailVariant.findById(original.retailVariant).session(session);
          if (!variant) throw fail(`Retail product ${original.name} no longer exists.`, 409);
          const stock = variant.inventoryByLocation.find((entry) => String(entry.outlet || '') === String(sale.outlet));
          if (!stock) throw fail(`No outlet stock record exists for ${original.name}.`, 409, 'LOCATION_NOT_MAPPED');
          if (line.condition !== 'resalable') throw fail('Damaged or altered items cannot be returned to sellable stock.', 422);
          stock.available = Number(stock.available || 0) + line.quantity;
          stock.onHand = Number(stock.onHand || 0) + line.quantity;
          stock.updatedAt = new Date();
          await variant.save({ session });
          const key = crypto.createHash('sha256').update(`${clientReturnId}:${line.originalSaleItemIndex}:${variant._id}:${stock.shopifyLocationId}`).digest('hex');
          inventoryRows.push({
            variant: variant._id,
            outlet: sale.outlet,
            shopifyLocationId: stock.shopifyLocationId,
            quantityDelta: line.quantity,
            unitCost: Number(original.unitCostSnapshot || 0),
            type: 'return',
            referenceType: 'sale-return',
            idempotencyKey: key,
            syncStatus: variant.shopifyVariantId ? 'pending' : 'not-required',
            createdBy: actorId,
            occurredAt: new Date(),
          });
        }
      }
      refundAmount = round2(refundAmount);
      taxAmount = round2(taxAmount);
      if (refundAmount <= 0) throw fail('This sale line has no refundable value.', 422);
      if (prior.amount + refundAmount > Number(sale.totalAmount) + 0.01) throw fail('Return value exceeds the amount remaining on this sale.', 409, 'RETURN_VALUE_EXCEEDED');

      const returnNumber = makeReturnNumber();
      const [created] = await SaleReturn.create([{
        returnNumber,
        saleTransaction: sale._id,
        session: activeSession?._id || null,
        outlet: sale.outlet,
        lines: savedLines,
        refundAmount: round2(refundAmount),
        refundMethod,
        reason,
        clientReturnId,
        unitCostReturned: round2(unitCostReturned),
        createdBy: actorId,
      }], { session });
      savedReturn = created;
      if (inventoryRows.length) await RetailInventoryMovement.insertMany(inventoryRows, { session, ordered: true });

      if (refundMethod === 'store-credit') {
        const code = `BC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        const [credit] = await StoreCredit.create([{
          code,
          currency: 'PKR',
          issuedAmount: savedReturn.refundAmount,
          balance: savedReturn.refundAmount,
          outlet: sale.outlet,
          issuedFromReturn: savedReturn._id,
          createdBy: actorId,
        }], { session });
        savedReturn.storeCredit = credit._id;
        await savedReturn.save({ session });
        await StoreCreditMovement.create([{
          storeCredit: credit._id,
          type: 'issue',
          amount: savedReturn.refundAmount,
          saleReturn: savedReturn._id,
          idempotencyKey: `${clientReturnId}:issue`,
          note: `Issued for ${returnNumber}`,
          createdBy: actorId,
        }], { session });
      }

      const journal = await postRetailRefund({
        sale,
        returnDoc: savedReturn,
        refundAmount: savedReturn.refundAmount,
        taxAmount,
        costOfGoodsSold: unitCostReturned,
        refundMethod,
        createdBy: actorId,
        session,
      });
      savedReturn.journalEntry = journal?._id || null;
      await savedReturn.save({ session });
      sale.retailReturnUpdatedAt = new Date();
      if (prior.amount + savedReturn.refundAmount >= Number(sale.totalAmount) - 0.01) {
        sale.retailReturnStatus = 'fully-returned';
      } else sale.retailReturnStatus = 'partial';
      await sale.save({ session });
    });
  } catch (error) {
    if (error?.code === 11000) {
      const racedDuplicate = await SaleReturn.findOne({ clientReturnId }).populate('storeCredit').lean();
      if (racedDuplicate) return res.json({ success: true, data: { return: racedDuplicate, duplicate: true } });
    }
    throw error;
  } finally {
    await session.endSession();
  }
  const data = await SaleReturn.findById(savedReturn._id).populate('storeCredit').lean();
  res.status(201).json({ success: true, data: { return: data } });
};

export const getStoreCredit = async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const credit = await StoreCredit.findOne({ code, status: 'active', balance: { $gt: 0 } })
    .select('code currency balance expiresAt outlet')
    .populate('outlet', 'name code').lean();
  if (!credit || (credit.expiresAt && credit.expiresAt <= new Date())) throw fail('Active store credit was not found.', 404);
  if (req.user.role === 'cashier' && String(credit.outlet?._id || credit.outlet) !== String(req.user.outletRef || '')) throw fail('Active store credit was not found.', 404);
  res.json({ success: true, data: credit });
};
