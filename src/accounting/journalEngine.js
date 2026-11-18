/**
 * journalEngine.js — Automatic double-entry posting engine.
 *
 * Every financial trigger calls one function here. The function looks up the
 * required system accounts by code, creates a balanced JournalEntry, and
 * returns the saved document. The caller saves the journalEntryId on the
 * source document (purchase, payment, sale, etc.).
 *
 * Account codes used (must be seeded by seedAccounts.js):
 *   1001  Cash and Bank           (Asset,   Debit normal)
 *   1200  Inventory               (Asset,   Debit normal)
 *   2001  Accounts Payable        (Liability, Credit normal)
 *   4001  Sales Revenue           (Revenue, Credit normal)
 *   4004  Delivery Charges        (Revenue, Credit normal)
 *   4005  Service Charge          (Revenue, Credit normal)
 *   4007  Discounts               (Revenue, Credit normal — contra, debited)
 *   2300  Sales Tax Payable       (Liability, Credit normal)
 *   5002  Purchase Expense        (Expense, Debit normal)
 *   5003  Waste and Spoilage      (Expense, Debit normal)
 */

import ChartOfAccounts from '../models/ChartOfAccounts.js';
import JournalEntry from '../models/JournalEntry.js';
import Outlet from '../models/Outlet.js';
import seedAccounts from './seedAccounts.js';
import logger from '../utils/logger.js';
import { getBusinessDate } from '../utils/businessDate.js';
import { paymentItemSummary } from '../utils/purchaseSummary.js';
import { salaryAccrualFields } from '../utils/salaryAccrual.js';

const saleAccountingDate = (transaction) =>
  transaction?.businessDate
    ? new Date(`${transaction.businessDate}T12:00:00.000Z`)
    : (transaction?.createdAt ?? new Date());

const drawerAccountingDate = async (movement, session) => {
  const instant = movement?.at ?? new Date();
  const outlet = session?.outlet
    ? await Outlet.findById(session.outlet).select('timezone businessDayStart businessDayEnd').lean()
    : null;
  if (!outlet) return instant;
  const businessDate = getBusinessDate(
    instant,
    outlet.timezone || 'Asia/Karachi',
    outlet.businessDayStart || '00:00',
    outlet.businessDayEnd || outlet.businessDayStart || '00:00',
  );
  return new Date(`${businessDate}T12:00:00.000Z`);
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Batch-fetch accounts by code. If any required code is missing (e.g. a tenant
 * provisioned before a new system account was added to the seed list), run
 * seedAccounts() against the current tenant connection and retry once.
 * seedAccounts is upsert-only, so a re-run is always safe.
 */
const getAccounts = async (...codes) => {
  const accounts = await ChartOfAccounts.find({ code: { $in: codes } }).lean();
  const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));

  const missing = codes.filter((c) => !byCode[c]);
  if (missing.length > 0) {
    logger.warn(`[journalEngine] Missing system account(s) ${missing.join(', ')} — running seedAccounts to backfill.`);
    await seedAccounts();
    const retry = await ChartOfAccounts.find({ code: { $in: codes } }).lean();
    const retryByCode = Object.fromEntries(retry.map((a) => [a.code, a]));
    for (const code of codes) {
      if (!retryByCode[code]) {
        throw new Error(
          `System account ${code} not found in Chart of Accounts after backfill. Check seedAccounts.js.`
        );
      }
    }
    return retryByCode;
  }

  return byCode;
};

const round2 = (n) => parseFloat(n.toFixed(2));

// ─── Unified purchase posting ────────────────────────────────────────────────
// The description is deliberately just the goods summary. Vendor, outlet,
// document number and dates are separate structured fields and screen columns.
const purchaseLineTreatment = (purchase, line) => {
  if (purchase.type === 'stock') return 'inventory';
  if (purchase.type === 'expense') return 'expense';
  return ['inventory', 'expense', 'asset'].includes(line.accountingTreatment)
    ? line.accountingTreatment
    : 'expense';
};

export const allocatePurchaseGoods = (purchase) => {
  const lines = [...(purchase.lines || [])];
  const goods = round2(
    (Number(purchase.totalAmount) || 0) - (Number(purchase.aitAmount) || 0),
  );
  const weight = lines.reduce(
    (sum, line) => sum + Math.max(0, Number(line.lineTotal) || 0),
    0,
  );
  const finalWeightedIndex = lines.reduce(
    (last, line, index) => (Number(line.lineTotal) > 0 ? index : last),
    -1,
  );
  let allocated = 0;
  return lines.map((line, index) => {
    const lineWeight = Math.max(0, Number(line.lineTotal) || 0);
    const amount = index === finalWeightedIndex
      ? round2(goods - allocated)
      : round2(weight > 0 && lineWeight > 0 ? goods * (lineWeight / weight) : 0);
    allocated = round2(allocated + amount);
    return {
      line,
      amount,
      treatment: purchaseLineTreatment(purchase, line),
    };
  });
};

export const buildPurchaseJournalFields = async (purchase) => {
  const accounts = await getAccounts('5002', '1200', '2001', '1103');
  const total = round2(Number(purchase.totalAmount) || 0);
  const ait = round2(Number(purchase.aitAmount) || 0);
  const summary = purchase.itemSummary || 'Purchase';
  const allocations = allocatePurchaseGoods(purchase);
  const assetAccountIds = allocations
    .filter((allocation) => allocation.treatment === 'asset')
    .map((allocation) => allocation.line.assetAccount?._id || allocation.line.assetAccount)
    .filter(Boolean);
  const assetAccounts = assetAccountIds.length
    ? await ChartOfAccounts.find({
      _id: { $in: assetAccountIds },
      type: 'asset',
      isActive: true,
    }).select('_id code name').lean()
    : [];
  const validAssetAccounts = new Map(
    assetAccounts.map((account) => [String(account._id), account]),
  );
  const groupedDebits = new Map();

  for (const allocation of allocations) {
    if (allocation.amount <= 0) continue;
    let account = allocation.treatment === 'inventory' ? accounts['1200'] : accounts['5002'];
    if (allocation.treatment === 'asset') {
      const assetAccountId = allocation.line.assetAccount?._id || allocation.line.assetAccount;
      account = validAssetAccounts.get(String(assetAccountId || ''));
      if (!account) {
        throw new Error('An asset purchase line has an invalid or inactive fixed-asset COA head.');
      }
    }
    const key = String(account._id);
    const current = groupedDebits.get(key) || {
      account: account._id,
      debit: 0,
      credit: 0,
      notes: allocation.treatment === 'asset'
        ? `Fixed assets — ${allocation.line.description || summary}`
        : summary,
    };
    current.debit = round2(current.debit + allocation.amount);
    groupedDebits.set(key, current);
  }
  const lines = [...groupedDebits.values()];
  if (ait > 0) {
    lines.push({
      account: accounts['1103']._id,
      debit: ait,
      credit: 0,
      notes: `AIT — ${purchase.vendorInvoiceNumber || purchase.purchaseNumber}`,
    });
  }
  lines.push({
    account: accounts['2001']._id,
    debit: 0,
    credit: total,
    notes: purchase.vendorName ? `Due to ${purchase.vendorName}` : 'Purchase payable',
  });

  return {
    date: purchase.purchaseDate || purchase.createdAt || new Date(),
    description: summary,
    itemSummary: summary,
    sourceNumber: purchase.purchaseNumber,
    sourcePath: `/purchases/${purchase._id}`,
    lines,
    sourceModule: 'purchase',
    sourceId: purchase._id,
    partyVendor: purchase.vendor || null,
    party: purchase.vendor ? null : (purchase.vendorName || null),
    outlet: purchase.outlet || null,
    status: 'posted',
  };
};

export const postPurchase = async (purchase, createdBy) => {
  const fields = await buildPurchaseJournalFields(purchase);
  return JournalEntry.create({
    ...fields,
    createdBy: createdBy || null,
  });
};

export const postPurchaseAdjustment = async (adjustment, purchase, createdBy) => {
  const amount = round2(Math.abs(Number(adjustment.financialDelta) || 0));
  if (amount <= 0) return null;
  const accounts = await getAccounts('5002', '1200', '2001', '1103');
  const increase = adjustment.financialDelta > 0;
  const summary = `Correction: ${purchase.itemSummary || 'Purchase'}`;
  const aitSigned = Number(adjustment.financialBreakdown?.ait) || 0;
  const goodsSigned = Number(adjustment.financialBreakdown?.goods)
    || (Number(adjustment.financialDelta) - aitSigned);
  const lines = [];
  const addSignedLine = (account, signed, notes) => {
    const value = round2(Math.abs(signed));
    if (value <= 0) return;
    lines.push({
      account,
      debit: signed > 0 ? value : 0,
      credit: signed < 0 ? value : 0,
      notes,
    });
  };
  const goodsAccount = purchase.type === 'stock' ? accounts['1200'] : accounts['5002'];
  addSignedLine(goodsAccount._id, goodsSigned, adjustment.reason);
  addSignedLine(accounts['1103']._id, aitSigned, `AIT correction — ${purchase.purchaseNumber}`);
  lines.push({
    account: accounts['2001']._id,
    debit: increase ? 0 : amount,
    credit: increase ? amount : 0,
    notes: `${purchase.purchaseNumber} adjustment`,
  });
  return JournalEntry.create({
    date: adjustment.createdAt || new Date(),
    description: summary,
    itemSummary: summary,
    sourceNumber: adjustment.adjustmentNumber,
    sourcePath: `/purchases/${purchase._id}`,
    lines,
    sourceModule: 'purchaseAdjustment',
    sourceId: adjustment._id,
    partyVendor: purchase.vendor || null,
    party: purchase.vendor ? undefined : (purchase.vendorName || undefined),
    outlet: purchase.outlet || null,
    status: 'posted',
    createdBy: createdBy || null,
  });
};

// ─── postPayment ──────────────────────────────────────────────────────────────
// Trigger: Payment recorded
// DR  Accounts Payable (2001)  amount
// CR  Cash and Bank    (1001)  amount

export const postPayment = async (payment, createdBy, purchase) => {
  const accounts = await getAccounts('2001', '1001');
  const amount = round2(payment.amount);

  const description = paymentItemSummary(purchase);
  const entry = await JournalEntry.create({
    date: payment.paymentDate ?? new Date(),
    description,
    itemSummary: purchase?.itemSummary,
    sourceNumber: purchase.purchaseNumber,
    sourcePath: `/purchases/${purchase._id}`,
    lines: [
      { account: accounts['2001']._id, debit: amount, credit: 0, notes: `Paid ${purchase.purchaseNumber}` },
      { account: accounts['1001']._id, debit: 0, credit: amount, notes: `${payment.method}${payment.reference ? ` — ${payment.reference}` : ''}` },
    ],
    sourceModule: 'payment',
    sourceId: payment._id,
    outlet: purchase.outlet || null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [payment]: ${entry.entryNumber} | payment ${payment._id} | amount: ${amount}`);
  return entry;
};

// ─── postWasteLog ─────────────────────────────────────────────────────────────
// Trigger: Waste logged
//
// Purchases are immediately expensed in full via postPurchase
// (DR Purchase Expense 5002 / CR AP 2001). Waste items are therefore already
// captured inside Purchase Expense — we must NOT add a second debit.
//
// Instead we *reclassify* the wasted portion out of Purchase Expense and into
// Waste and Spoilage so that:
//   • The total expense on the P&L stays equal to the original purchase cost.
//   • Waste is visible as its own line for management reporting.
//
// DR  Waste and Spoilage (5003)  totalCost   ← increase waste line
// CR  Purchase Expense   (5002)  totalCost   ← reduce purchase-expense line

export const postWasteLog = async (wasteLog, createdBy) => {
  const accounts = await getAccounts('5003', '5002');
  const amount = round2(wasteLog.totalCost);

  const entry = await JournalEntry.create({
    date: wasteLog.loggedAt ?? new Date(),
    description: `Waste logged — ${wasteLog._id}`,
    lines: [
      { account: accounts['5003']._id, debit: amount, credit: 0, notes: `Waste/Spoilage — ${wasteLog.reason}` },
      { account: accounts['5002']._id, debit: 0, credit: amount, notes: `Reclassified from Purchase Expense` },
    ],
    sourceModule: 'waste',
    sourceId: wasteLog._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [waste]: ${entry.entryNumber} | amount: ${amount}`);
  return entry;
};

// ─── postPOSSale ──────────────────────────────────────────────────────────────
// Trigger: POS sale received
// DR  Cash and Bank             (1001)  amount
// CR  Sales Revenue             (4001)  amount

export const postPOSSale = async ({ amount, revenueAccountCode = '4001', posEventId, createdBy }) => {
  const accounts = await getAccounts('1001', revenueAccountCode);
  const amt = round2(amount);

  const entry = await JournalEntry.create({
    date: new Date(),
    description: `POS sale — ${posEventId ?? 'event'}`,
    lines: [
      { account: accounts['1001']._id, debit: amt, credit: 0, notes: 'Cash/Bank received' },
      { account: accounts[revenueAccountCode]._id, debit: 0, credit: amt, notes: 'Sales Revenue' },
    ],
    sourceModule: 'pos',
    sourceId: posEventId ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [POS sale]: ${entry.entryNumber} | amount: ${amt}`);
  return entry;
};

// ─── postSale ─────────────────────────────────────────────────────────────────
// Trigger: Custom POS sale completed. Breaks the bill into its accounting heads
// instead of lumping everything into revenue:
//
// For cash/card sales:
//   DR  Cash and Bank              (1001)  totalAmount (cash + card received)
//   DR  Membership Rewards Liab.   (2200)  redemptionValue (points redeemed)
//   DR  Discounts                  (4007)  discountAmount (contra-revenue)
//   CR  Service Charge             (4005)  serviceChargeAmount
//   CR  Sales Tax Payable          (2300)  taxAmount
//   CR  Delivery Charges           (4004)  deliveryChargeAmount
//   CR  Sales Revenue              (4001)  balancing plug (= gross item sales)
//
// For Food Panda sales the platform pays later, so the debit goes to a
// receivable asset instead of Cash and Bank:
//   DR  Food Panda Receivable      (1110)  totalAmount
//   (other heads unchanged)
//
// Sales Revenue is the plug so the entry always balances to the cent regardless
// of rounding; it equals the gross item subtotal. Only non-zero heads get a line.
//
// @param {object} transaction - Saved SaleTransaction document (carries the totals).
// @param {Array}  _items      - Kept for signature compatibility; no longer used.
// @param {object} opts        - { redemptionValue }

export const postSale = async (transaction, _items = [], opts = {}) => {
  const totalAmount = round2(transaction.totalAmount);
  const redemption  = round2(opts.redemptionValue || 0);
  const tax         = round2(transaction.taxAmount || 0);
  const service     = round2(transaction.serviceChargeAmount || 0);
  const discount    = round2(transaction.discountAmount || 0);
  const delivery    = round2(transaction.deliveryChargeAmount || 0);
  const cogs        = round2(opts.costOfGoodsSold ?? transaction.costOfGoodsSold ?? 0);
  const storeCredit = round2(opts.storeCreditAmount ?? transaction.storeCreditRedeemed ?? 0);
  const isFoodPanda = transaction.paymentMethod === 'foodpanda';
  const isOnlineTransfer = transaction.paymentMethod === 'online-transfer';
  const isShopify = transaction.paymentMethod === 'shopify';

  // Sales Revenue balances the entry: total debits − the other credit heads.
  const totalDebit    = round2(totalAmount + redemption + discount);
  const salesRevenue  = round2(totalDebit - service - tax - delivery);

  const debitAccountCode = isFoodPanda ? '1110' : isShopify ? '1111' : '1001';
  const codes = [debitAccountCode, '4001'];
  if (redemption > 0) codes.push('2200');
  if (storeCredit > 0) codes.push('2201');
  if (discount > 0)   codes.push('4007');
  if (service > 0)    codes.push('4005');
  if (tax > 0)        codes.push('2300');
  if (delivery > 0)   codes.push('4004');
  if (cogs > 0) codes.push('5001', '1200');
  const accounts = await getAccounts(...codes);

  const debitLines = [];
  const creditLines = [];

  const externalTender = round2(Math.max(0, totalAmount - storeCredit));
  if (externalTender > 0) {
    const debitNotes = isFoodPanda
      ? `Food Panda Receivable — ${transaction.transactionNumber}`
      : isShopify
        ? `Shopify Clearing — ${transaction.shopifyOrderName || transaction.transactionNumber}`
        : isOnlineTransfer
        ? `Online transfer received — ${transaction.transactionNumber}${transaction.onlineTransferReference ? ` (${transaction.onlineTransferReference})` : ''}`
        : `Cash/Bank received — ${transaction.transactionNumber}`;
    debitLines.push({ account: accounts[debitAccountCode]._id, debit: externalTender, credit: 0, notes: debitNotes });
  }
  if (redemption > 0)  debitLines.push({ account: accounts['2200']._id, debit: redemption, credit: 0, notes: `Rewards points redeemed — ${transaction.transactionNumber}` });
  if (storeCredit > 0) debitLines.push({ account: accounts['2201']._id, debit: storeCredit, credit: 0, notes: `Store credit redeemed — ${transaction.storeCreditCode || transaction.transactionNumber}` });
  if (discount > 0)    debitLines.push({ account: accounts['4007']._id, debit: discount, credit: 0, notes: `Discount — ${transaction.transactionNumber}` });
  if (cogs > 0) debitLines.push({ account: accounts['5001']._id, debit: cogs, credit: 0, notes: `Cost of goods sold — ${transaction.transactionNumber}` });

  if (service > 0)  creditLines.push({ account: accounts['4005']._id, debit: 0, credit: service, notes: `Service Charge — ${transaction.transactionNumber}` });
  if (tax > 0)      creditLines.push({ account: accounts['2300']._id, debit: 0, credit: tax, notes: `Sales Tax Payable — ${transaction.transactionNumber}` });
  if (delivery > 0) creditLines.push({ account: accounts['4004']._id, debit: 0, credit: delivery, notes: `Delivery Charges — ${transaction.transactionNumber}` });
  if (cogs > 0) creditLines.push({ account: accounts['1200']._id, debit: 0, credit: cogs, notes: `Finished goods inventory — ${transaction.transactionNumber}` });

  // Plug to Sales Revenue (positive → credit; a rounding-negative → debit).
  if (salesRevenue > 0)      creditLines.push({ account: accounts['4001']._id, debit: 0, credit: salesRevenue, notes: `Sales Revenue — ${transaction.transactionNumber}` });
  else if (salesRevenue < 0) debitLines.push({ account: accounts['4001']._id, debit: -salesRevenue, credit: 0, notes: `Sales Revenue adj — ${transaction.transactionNumber}` });

  const lines = [...debitLines, ...creditLines];
  // Degenerate all-zero sale (e.g. a fully-comped Rs.0 order) — nothing to post.
  if (lines.length < 2) return null;

  const description = isShopify
    ? `Shopify online sale — ${transaction.shopifyOrderName || transaction.transactionNumber}`
    : redemption > 0
    ? `POS sale — ${transaction.transactionNumber} (${isFoodPanda ? 'Food Panda' : isOnlineTransfer ? 'online transfer' : 'cash'} Rs. ${totalAmount}, points Rs. ${redemption})`
    : `POS sale — ${transaction.transactionNumber}${isFoodPanda ? ' (Food Panda)' : isOnlineTransfer ? ' (Online Transfer)' : ''}`;

  const entry = new JournalEntry({
    date: saleAccountingDate(transaction),
    description,
    sourceNumber: transaction.transactionNumber,
    sourcePath: `/reports/sales-transactions?order=${transaction._id}`,
    lines,
    sourceModule: 'pos',
    sourceId: transaction._id,
    party: isFoodPanda ? 'Food Panda Sales' : isShopify ? 'Shopify Online Sales' : undefined,
    status: 'posted',
    createdBy: transaction.cashier ?? null,
  });
  await entry.save(opts.session ? { session: opts.session } : undefined);

  logger.info(
    `JE posted [POS sale]: ${entry.entryNumber} | ${transaction.transactionNumber} | ` +
    `total: ${totalAmount} revenue: ${salesRevenue} tax: ${tax} service: ${service} delivery: ${delivery} discount: ${discount} redemption: ${redemption}`
  );

  return entry;
};

export const postRetailRefund = async ({ sale, returnDoc, refundAmount, taxAmount = 0, costOfGoodsSold = 0, refundMethod = 'cash', createdAt = new Date(), createdBy = null, session = null }) => {
  const total = round2(refundAmount || 0);
  const tax = round2(Math.min(total, taxAmount || 0));
  const sales = round2(Math.max(0, total - tax));
  const cogs = round2(costOfGoodsSold || 0);
  if (total <= 0) return null;
  const creditAccountCode = refundMethod === 'store-credit' ? '2201' : '1001';
  const codes = [creditAccountCode];
  if (sales > 0) codes.push('4008');
  if (tax > 0) codes.push('2300');
  if (cogs > 0) codes.push('1200', '5001');
  const accounts = await getAccounts(...codes);
  const debits = [];
  const credits = [{ account: accounts[creditAccountCode]._id, debit: 0, credit: total, notes: refundMethod === 'store-credit' ? `Store credit issued — ${returnDoc.returnNumber}` : `Refund paid — ${returnDoc.returnNumber}` }];
  if (sales > 0) debits.push({ account: accounts['4008']._id, debit: sales, credit: 0, notes: `Retail sales return — ${returnDoc.returnNumber}` });
  if (tax > 0) debits.push({ account: accounts['2300']._id, debit: tax, credit: 0, notes: `Sales tax refunded — ${returnDoc.returnNumber}` });
  if (cogs > 0) {
    debits.push({ account: accounts['1200']._id, debit: cogs, credit: 0, notes: `Resalable goods returned — ${returnDoc.returnNumber}` });
    credits.push({ account: accounts['5001']._id, debit: 0, credit: cogs, notes: `Reverse cost of goods sold — ${returnDoc.returnNumber}` });
  }
  const entry = new JournalEntry({
    date: createdAt,
    description: `Retail return — ${returnDoc.returnNumber}`,
    sourceNumber: returnDoc.returnNumber,
    sourcePath: `/reports/sales-transactions?order=${sale._id}`,
    lines: [...debits, ...credits],
    sourceModule: 'pos',
    sourceId: sale._id,
    outlet: sale.outlet,
    status: 'posted',
    createdBy,
  });
  await entry.save(session ? { session } : undefined);
  return entry;
};

export const postShopifyRefund = async ({ sale, returnNumber, refundAmount, taxAmount = 0, shippingAmount = 0, costOfGoodsSold = 0, createdAt = new Date() }) => {
  const total = round2(refundAmount || 0);
  const tax = round2(Math.min(total, taxAmount || 0));
  const shipping = round2(Math.min(Math.max(0, total - tax), shippingAmount || 0));
  const sales = round2(Math.max(0, total - tax - shipping));
  const cogs = round2(costOfGoodsSold || 0);
  if (total <= 0) return null;

  const codes = ['1111'];
  if (sales > 0) codes.push('4008');
  if (tax > 0) codes.push('2300');
  if (shipping > 0) codes.push('4004');
  if (cogs > 0) codes.push('1200', '5001');
  const accounts = await getAccounts(...codes);
  const debitLines = [];
  const creditLines = [{ account: accounts['1111']._id, debit: 0, credit: total, notes: `Shopify refund clearing — ${returnNumber}` }];
  if (sales > 0) debitLines.push({ account: accounts['4008']._id, debit: sales, credit: 0, notes: `Sales return — ${returnNumber}` });
  if (tax > 0) debitLines.push({ account: accounts['2300']._id, debit: tax, credit: 0, notes: `Sales tax refunded — ${returnNumber}` });
  if (shipping > 0) debitLines.push({ account: accounts['4004']._id, debit: shipping, credit: 0, notes: `Shipping refunded — ${returnNumber}` });
  if (cogs > 0) {
    debitLines.push({ account: accounts['1200']._id, debit: cogs, credit: 0, notes: `Returned finished goods — ${returnNumber}` });
    creditLines.push({ account: accounts['5001']._id, debit: 0, credit: cogs, notes: `Reverse cost of goods sold — ${returnNumber}` });
  }
  return JournalEntry.create({
    date: createdAt,
    description: `Shopify refund — ${returnNumber}`,
    sourceNumber: returnNumber,
    sourcePath: `/reports/sales-transactions?order=${sale._id}`,
    lines: [...debitLines, ...creditLines],
    sourceModule: 'pos',
    sourceId: sale._id,
    outlet: sale.outlet,
    party: 'Shopify Online Sales',
    status: 'posted',
    createdBy: null,
  });
};

// ─── postCashDrawerPayout ─────────────────────────────────────────────────────
// Trigger: Cashier takes cash out of the POS drawer to buy supplies.
// DR  Purchase Expense (5002)   amount
// CR  Cash and Bank    (1001)   amount
export const postCashDrawerPayout = async (movement, session, createdBy) => {
  const accounts = await getAccounts('5002', '1001');
  const amount = round2(movement.amount);
  const sessRef = session?.sessionNumber || session?._id || '';
  const reasonTxt = movement.reason ? ` — ${movement.reason}` : '';
  const description = movement.reason?.trim() || 'Cash drawer payout';
  const accountingDate = await drawerAccountingDate(movement, session);

  const entry = await JournalEntry.create({
    date: accountingDate,
    description,
    lines: [
      { account: accounts['5002']._id, debit: amount, credit: 0, notes: `Supplies bought from drawer${reasonTxt}` },
      { account: accounts['1001']._id, debit: 0, credit: amount, notes: `Cash taken from drawer — ${sessRef}` },
    ],
    sourceModule: 'cashDrawer',
    sourceId: session?._id ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [cash drawer payout]: ${entry.entryNumber} | ${sessRef} | amount: ${amount}`);
  return entry;
};

// ─── postCashDrawerReturn ─────────────────────────────────────────────────────
// Trigger: Cashier returns unused cash to the POS drawer (the change left over
// from a payout). Reverses the payout posting for the returned amount.
// DR  Cash and Bank    (1001)   amount
// CR  Purchase Expense (5002)   amount
export const postCashDrawerReturn = async (movement, session, createdBy) => {
  const accounts = await getAccounts('5002', '1001');
  const amount = round2(movement.amount);
  const sessRef = session?.sessionNumber || session?._id || '';
  const reasonTxt = movement.reason ? ` — ${movement.reason}` : '';
  const description = movement.reason?.trim() || 'Cash returned to drawer';
  const accountingDate = await drawerAccountingDate(movement, session);

  const entry = await JournalEntry.create({
    date: accountingDate,
    description,
    lines: [
      { account: accounts['1001']._id, debit: amount, credit: 0, notes: `Unused cash returned to drawer — ${sessRef}` },
      { account: accounts['5002']._id, debit: 0, credit: amount, notes: `Reverses drawer payout${reasonTxt}` },
    ],
    sourceModule: 'cashDrawer',
    sourceId: session?._id ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [cash drawer return]: ${entry.entryNumber} | ${sessRef} | amount: ${amount}`);
  return entry;
};

// ─── postStockCountAdjustment ────────────────────────────────────────────────
// Trigger: Stock count submitted with shortages.
//
// Purchases are immediately expensed (DR 5002 / CR 2001) when posted, so the
// full cost is already in Purchase Expense. When a stock
// count reveals fewer units than the system shows, that missing stock is a loss
// that should be reclassified into Waste and Spoilage.
//
// For each shortage line (variance < 0):
//   DR  Waste and Spoilage (5003)  abs(variance) × unitCost
//   CR  Purchase Expense   (5002)  abs(variance) × unitCost
//
// Lines with zero variance or zero unit cost are skipped.
// A surplus (variance > 0) is the reverse — reclassify back out of Waste:
//   DR  Purchase Expense   (5002)  variance × unitCost
//   CR  Waste and Spoilage (5003)  variance × unitCost
//
// @param {object} stockCount   - Saved StockCount document (lines populated).
// @param {object} costByProduct - Map of { productId (string): unitCost (number) }.

// `shortageMode` decides how a NEGATIVE variance (shortage) is booked:
//   'waste' — reclassify the shortfall cost Purchase Expense → Waste & Spoilage
//             (genuine spoilage/loss you want tracked as waste).
//   'sold'  — leave the cost in Purchase Expense (normal day-end consumption /
//             sold stock). NO waste JE is posted, so the Waste figure isn't
//             inflated by routine end-of-day inventory reconciliation.
// SURPLUSES (positive variance) are recount corrections: they post NO accounting
// entry at all (quantity + count-adjust ledger row only, done by the caller).
export const postStockCountAdjustment = async (stockCount, costByProduct, createdBy, shortageMode = 'waste') => {
  const accounts = await getAccounts('5003', '5002');

  const journalLines = [];

  for (const line of stockCount.lines) {
    const variance = parseFloat(line.variance) || 0;
    if (variance === 0) continue;

    const unitCost = parseFloat(costByProduct[line.product?.toString()]) || 0;
    if (unitCost <= 0) continue;

    const amount = round2(Math.abs(variance) * unitCost);
    if (amount <= 0) continue;

    // Surpluses are recount corrections — no accounting entry.
    if (variance > 0) continue;
    // Shortage — only book it as WASTE when the user marked it so. A
    // 'sold'/consumed shortage posts nothing (cost stays in Purchase Expense).
    if (shortageMode !== 'waste') continue;
    // Reclassify from Purchase Expense → Waste and Spoilage.
    journalLines.push({ account: accounts['5003']._id, debit: amount, credit: 0, notes: `Stock shortage — variance ${variance}` });
    journalLines.push({ account: accounts['5002']._id, debit: 0, credit: amount, notes: `Reclassified from Purchase Expense` });
  }

  if (journalLines.length === 0) return null; // nothing to post

  const entry = await JournalEntry.create({
    date: stockCount.completedAt ?? new Date(),
    description: `Stock count adjustment — ${stockCount._id}`,
    lines: journalLines,
    sourceModule: 'stockCount',
    sourceId: stockCount._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [stock count adjustment]: ${entry.entryNumber} | stockCount ${stockCount._id} | ${journalLines.length / 2} line(s)`);
  return entry;
};

// ─── postManual ───────────────────────────────────────────────────────────────
// Trigger: Manual journal entry submitted via the accounting UI.
// Lines are pre-validated by the controller (account ObjectIds resolved,
// balance checked by JournalEntry pre-save hook).

export const postManual = async (entryData, userId) => {
  const entry = await JournalEntry.create({
    date: entryData.date ?? new Date(),
    description: entryData.description,
    lines: entryData.lines,
    sourceModule: 'manual',
    sourceId: entryData.sourceId ?? null,
    party: (entryData.party ?? '').trim() || undefined,
    partyVendor: entryData.partyVendor || undefined,
    status: 'posted',
    createdBy: userId ?? null,
  });

  logger.info(`JE posted [manual]: ${entry.entryNumber} | "${entry.description}" | by user ${userId}`);
  return entry;
};

// ─── updateManualEntry ────────────────────────────────────────────────────────
// Purchase journals can only change through a purchase correction. Payment
// postings remain amount-locked to their source document.
// Errors carry a statusCode so the API returns a clean 4xx instead of a 500.

export const updateManualEntry = async (entryId, entryData, userId) => {
  const entry = await JournalEntry.findById(entryId);
  if (entry?.salaryAdvance) {
    throw Object.assign(new Error('This order is linked to payroll. Use the salary advance or POS order workflow to correct it.'), { statusCode: 409 });
  }
  if (!entry) {
    const err = new Error(`Journal entry ${entryId} not found.`);
    err.statusCode = 404;
    throw err;
  }
  if (entry.reversedBy) {
    const err = new Error(
      `Journal entry ${entry.entryNumber} has been reversed and can no longer be edited.`
    );
    err.statusCode = 409;
    throw err;
  }
  if ([
    'purchase',
    'purchaseAdjustment',
    'assetAcquisition',
    'assetDepreciation',
    'assetAuditAdjustment',
    'assetDisposal',
  ].includes(entry.sourceModule)) {
    const err = new Error('Purchase journals are source-controlled. Correct the linked purchase instead.');
    if (entry.sourceModule.startsWith('asset')) {
      err.message = 'Asset journals are source-controlled. Use the linked asset, audit, or depreciation workflow instead.';
    }
    err.statusCode = 409;
    throw err;
  }

  const lines = entryData.lines ?? [];
  const isSourceLocked = entry.sourceModule === 'payment';
  if (isSourceLocked) {
    if (lines.length !== entry.lines.length) {
      const err = new Error('System journal line count is locked. Only the description and account heads can be changed.');
      err.statusCode = 422;
      throw err;
    }
    for (let i = 0; i < entry.lines.length; i += 1) {
      const before = entry.lines[i];
      const after = lines[i];
      if (
        Math.abs((Number(before.debit) || 0) - (Number(after.debit) || 0)) >= 0.001 ||
        Math.abs((Number(before.credit) || 0) - (Number(after.credit) || 0)) >= 0.001
      ) {
        const err = new Error('Debit and credit amounts are locked. Only the description and account heads can be changed.');
        err.statusCode = 422;
        throw err;
      }
    }
  }
  const totalDebit  = lines.reduce((s, l) => s + (Number(l.debit)  || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (Math.abs(totalDebit - totalCredit) >= 0.001) {
    const err = new Error(
      `Journal entry does not balance: debits ${totalDebit.toFixed(2)}, credits ${totalCredit.toFixed(2)}.`
    );
    err.statusCode = 400;
    throw err;
  }

  // Payment entries: the linked bill's paid balance must never drift from the
  // ledger. Two invariants are enforced (accounts on the cash/bank side and the
  // description may be corrected and permitted account heads reclassified):
  //   (1) the TOTAL is locked to the recorded payment amount, and
  //   (2) the NET movement (debit − credit) on every Accounts Payable account is
  //       preserved. AP-aging derives each bill's open/paid balance purely from
  //       AP journal lines (FIFO), NOT from purchase.amountPaid — so moving the AP
  //       debit to another account, splitting/reducing it, or flipping its
  //       direction would silently re-open a settled bill. To change the amount or
  //       which bill is settled, reverse the entry and re-record the payment.
  if (entry.sourceModule === 'payment') {
    const originalTotal = round2(entry.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
    if (Math.abs(originalTotal - round2(totalDebit)) >= 0.001) {
      const err = new Error(
        `A payment entry's amount is locked to the recorded payment (Rs. ${originalTotal.toFixed(2)}). ` +
        'Change the description or permitted account heads only — reverse the entry to change the amount.'
      );
      err.statusCode = 422;
      throw err;
    }

    // Net-by-AP-account invariant. Resolve which referenced accounts are payables.
    const accountIds = [...entry.lines, ...lines]
      .map((l) => l.account)
      .filter(Boolean)
      .map((a) => String(a?._id ?? a));
    const apAccounts = await ChartOfAccounts
      .find({ _id: { $in: accountIds }, subType: 'accountsPayable' })
      .select('_id')
      .lean();
    const apSet = new Set(apAccounts.map((a) => String(a._id)));
    const apNetByAccount = (arr) => {
      const m = new Map();
      for (const l of arr) {
        const id = String(l.account?._id ?? l.account);
        if (!apSet.has(id)) continue;
        m.set(id, round2((m.get(id) || 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0)));
      }
      return m;
    };
    const beforeAp = apNetByAccount(entry.lines);
    const afterAp  = apNetByAccount(lines);
    for (const key of new Set([...beforeAp.keys(), ...afterAp.keys()])) {
      if (Math.abs((beforeAp.get(key) || 0) - (afterAp.get(key) || 0)) >= 0.001) {
        const err = new Error(
          'A payment entry must keep its full amount applied to the same Accounts Payable account — that is what settles the bill. ' +
          'You can reclassify the cash/bank side or fix the date; reverse the entry to change the amount or which bill it settles.'
        );
        err.statusCode = 422;
        throw err;
      }
    }
  }

  if (isSourceLocked) {
    entry.description = entryData.description ?? entry.description;
    entry.lines = entry.lines.map((line, index) => ({
      account: lines[index].account,
      debit: line.debit,
      credit: line.credit,
      notes: line.notes,
    }));
  } else {
    entry.date        = entryData.date ?? entry.date;
    entry.description = entryData.description ?? entry.description;
    entry.lines       = lines;
  }
  // Party tag (AP-aging grouping) is editable on manual entries. Use null (not
  // undefined) to CLEAR reliably — assigning undefined can be a no-op on save,
  // whereas null persists the cleared value so a tag can be removed or switched.
  if (!isSourceLocked && 'party' in entryData)       entry.party       = (entryData.party ?? '').trim() || null;
  if (!isSourceLocked && 'partyVendor' in entryData) entry.partyVendor = entryData.partyVendor || null;
  await entry.save(); // re-runs the balance pre-save hook; entryNumber is preserved

  logger.info(`JE edited [${entry.sourceModule}]: ${entry.entryNumber} | "${entry.description}" | by user ${userId}`);
  return entry;
};

// ─── reverseJournalEntry ──────────────────────────────────────────────────────
// Creates a mirror entry with all debit/credit values swapped.
// Sets originalEntry.reversedBy = newEntry._id.
// Throws if the entry has already been reversed.

export const reverseJournalEntry = async (originalEntryId, userId) => {
  const original = await JournalEntry.findById(originalEntryId);
  if (!original) {
    throw new Error(`Journal entry ${originalEntryId} not found.`);
  }
  if (original.reversedBy) {
    throw new Error(`Journal entry ${original.entryNumber} has already been reversed.`);
  }
  if (String(original.sourceModule || '').startsWith('asset')) {
    const err = new Error(
      'Asset journals are source-controlled. Reverse or correct them from the linked asset workflow.',
    );
    err.statusCode = 409;
    throw err;
  }

  const reversedLines = original.lines.map((line) => ({
    account: line.account,
    debit: round2(line.credit),   // swap
    credit: round2(line.debit),    // swap
    notes: `Reversal of ${original.entryNumber}${line.notes ? ` — ${line.notes}` : ''}`,
  }));

  const reversal = await JournalEntry.create({
    date: new Date(),
    description: `Reversal of ${original.entryNumber}: ${original.description}`,
    itemSummary: original.itemSummary,
    sourceNumber: original.sourceNumber,
    sourcePath: original.sourcePath,
    lines: reversedLines,
    sourceModule: original.sourceModule,
    sourceId: original.sourceId ?? null,
    outlet: original.outlet || null,
    partyVendor: original.partyVendor || null,
    party: original.partyVendor ? undefined : original.party,
    status: 'posted',
    createdBy: userId ?? null,
  });

  // Atomically CLAIM the original — only one concurrent reverse can win, because
  // the `{ reversedBy: null }` guard (which also matches an absent field) matches
  // exactly once. If we lost the race (a double-click / retried request already
  // reversed it), delete the reversal we just created so no DUPLICATE survives.
  // This is what prevents the double-reversal the old read-check-write allowed.
  const claimed = await JournalEntry.findOneAndUpdate(
    { _id: original._id, reversedBy: null },
    { $set: { reversedBy: reversal._id } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    await JournalEntry.deleteOne({ _id: reversal._id });
    throw new Error(`Journal entry ${original.entryNumber} has already been reversed.`);
  }

  logger.info(`JE reversed: ${original.entryNumber} → ${reversal.entryNumber} | by user ${userId}`);
  return reversal;
};

// ─── deleteManualEntry ──────────────────────────────────────────────────────────
// Hard-delete a hand-keyed MANUAL journal entry. Only manual entries that are not
// source-linked, not reversed, and not themselves a reversal may be removed —
// every other entry (system-generated, or part of a reversal pair) must be
// reversed instead so the audit trail stays intact. Returns the deleted doc.
export const deleteManualEntry = async (entryId, userId) => {
  const entry = await JournalEntry.findById(entryId);
  if (!entry) {
    const err = new Error(`Journal entry ${entryId} not found.`);
    err.statusCode = 404;
    throw err;
  }
  if (entry.sourceModule !== 'manual') {
    const err = new Error('Only manual journal entries can be deleted. Reverse system-generated entries instead.');
    err.statusCode = 422;
    throw err;
  }
  // A genuine hand-keyed manual entry never carries a sourceId (e.g. legacy
  // allowance settlements do) — those are source-linked and must be reversed.
  if (entry.sourceId) {
    const err = new Error('This entry is linked to a source document and cannot be deleted. Reverse it instead.');
    err.statusCode = 422;
    throw err;
  }
  if (entry.reversedBy) {
    const err = new Error(`Journal entry ${entry.entryNumber} has been reversed and cannot be deleted.`);
    err.statusCode = 409;
    throw err;
  }
  // If any entry names THIS one as its reversal, this is a reversal entry —
  // deleting it would orphan the original's reversedBy link.
  const reversedOriginal = await JournalEntry.exists({ reversedBy: entry._id });
  if (reversedOriginal) {
    const err = new Error(`Journal entry ${entry.entryNumber} is a reversal and cannot be deleted directly.`);
    err.statusCode = 409;
    throw err;
  }

  await JournalEntry.deleteOne({ _id: entry._id });
  logger.info(`JE deleted: ${entry.entryNumber} (manual) | by user ${userId}`);
  return entry;
};

// ─── postAllowanceSale ────────────────────────────────────────────────────────
// Trigger: POS sale completed with paymentMethod = 'allowance'. Same head
// breakdown as postSale, but the DEBIT side is the allowance (expense within the
// limit, receivable for any excess) instead of cash.
//
// DR  Staff Allowance Expense    (5004)  withinLimit
// DR  Staff Allowance Receivable (1101)  excessAmount
// DR  Discounts                  (4007)  discountAmount
// CR  Service Charge             (4005)  serviceChargeAmount
// CR  Sales Tax Payable          (2300)  taxAmount
// CR  Delivery Charges           (4004)  deliveryChargeAmount
// CR  Sales Revenue              (4001)  balancing plug (= gross item sales)
//
// @param {object} transaction - Saved SaleTransaction document.
// @param {Array}  _items      - Kept for signature compatibility; no longer used.
// @param {object} opts        - { withinLimit, excessAmount }

export const postAllowanceSale = async (transaction, _items = [], { withinLimit = 0, excessAmount = 0 } = {}) => {
  const totalAmount = round2(transaction.totalAmount);
  const tax         = round2(transaction.taxAmount || 0);
  const service     = round2(transaction.serviceChargeAmount || 0);
  const discount    = round2(transaction.discountAmount || 0);
  const delivery    = round2(transaction.deliveryChargeAmount || 0);

  const safeWithin = round2(Math.min(withinLimit, totalAmount));
  const safeExcess = round2(totalAmount - safeWithin);

  const totalDebit   = round2(totalAmount + discount);
  const salesRevenue = round2(totalDebit - service - tax - delivery);

  const codes = ['5004', '1101', '4001'];
  if (discount > 0) codes.push('4007');
  if (service > 0)  codes.push('4005');
  if (tax > 0)      codes.push('2300');
  if (delivery > 0) codes.push('4004');
  const accounts = await getAccounts(...codes);

  const debitLines = [];
  const creditLines = [];

  if (safeWithin > 0) debitLines.push({ account: accounts['5004']._id, debit: safeWithin, credit: 0, notes: `Staff Allowance Expense — ${transaction.transactionNumber}` });
  if (safeExcess > 0) debitLines.push({ account: accounts['1101']._id, debit: safeExcess, credit: 0, notes: `Staff Allowance Receivable (excess) — ${transaction.transactionNumber}` });
  if (discount > 0)   debitLines.push({ account: accounts['4007']._id, debit: discount, credit: 0, notes: `Discount — ${transaction.transactionNumber}` });

  if (service > 0)  creditLines.push({ account: accounts['4005']._id, debit: 0, credit: service, notes: `Service Charge — ${transaction.transactionNumber}` });
  if (tax > 0)      creditLines.push({ account: accounts['2300']._id, debit: 0, credit: tax, notes: `Sales Tax Payable — ${transaction.transactionNumber}` });
  if (delivery > 0) creditLines.push({ account: accounts['4004']._id, debit: 0, credit: delivery, notes: `Delivery Charges — ${transaction.transactionNumber}` });

  if (salesRevenue > 0)      creditLines.push({ account: accounts['4001']._id, debit: 0, credit: salesRevenue, notes: `Sales Revenue — ${transaction.transactionNumber}` });
  else if (salesRevenue < 0) debitLines.push({ account: accounts['4001']._id, debit: -salesRevenue, credit: 0, notes: `Sales Revenue adj — ${transaction.transactionNumber}` });

  const lines = [...debitLines, ...creditLines];
  if (lines.length < 2) return null;

  const entry = await JournalEntry.create({
    date: saleAccountingDate(transaction),
    description: `Allowance sale — ${transaction.transactionNumber}`,
    lines,
    sourceModule: 'pos',
    sourceId: transaction._id,
    status: 'posted',
    createdBy: transaction.cashier ?? null,
  });

  logger.info(
    `JE posted [allowance sale]: ${entry.entryNumber} | ${transaction.transactionNumber} | ` +
    `within: ${safeWithin}, excess: ${safeExcess}, revenue: ${salesRevenue}, tax: ${tax}`
  );
  return entry;
};

// ─── postAllowanceSettlement ──────────────────────────────────────────────────
// Trigger: Excess allowance amount settled (employee pays back the restaurant).
//
// DR  Cash and Bank              (1001)  settlementAmount
// CR  Staff Allowance Receivable (1101)  settlementAmount

export const postAllowanceSettlement = async ({ allowanceId, amount, settledBy }) => {
  const accounts = await getAccounts('1001', '1101');
  const amt = round2(amount);

  const entry = await JournalEntry.create({
    date: new Date(),
    description: `Allowance excess settlement — record ${allowanceId}`,
    lines: [
      { account: accounts['1001']._id, debit: amt, credit: 0, notes: `Cash received for allowance settlement` },
      { account: accounts['1101']._id, debit: 0, credit: amt, notes: `Staff Allowance Receivable cleared` },
    ],
    sourceModule: 'allowance',
    sourceId: allowanceId ?? null,
    status: 'posted',
    createdBy: settledBy ?? null,
  });

  logger.info(`JE posted [allowance settlement]: ${entry.entryNumber} | allowance ${allowanceId} | amount: ${amt}`);
  return entry;
};

// ─── postSalaryAccrual ────────────────────────────────────────────────────────
// Trigger: Salary obligation arises at end of pay period (period close).
//
// Recognises payroll expense in the period it relates to — even if cash
// physically leaves a few days later. Pairs with postSalarySettlement which
// closes the liability when the employee is actually paid.
//
//   DR  Payroll Expense    (6003)  grossAmount
//   CR  Payroll Expense    (6003)  penaltyDeducted (when applicable)
//   CR  Accrued Expenses   (2100)  grossAmount − penaltyDeducted

export const postSalaryAccrual = async (payment, employeeName, accrualDate, createdBy) => {
  const accounts = await getAccounts('6003', '2100');
  const gross = round2(payment.grossAmount);
  const entry = await JournalEntry.create({
    ...salaryAccrualFields(payment, employeeName, accrualDate, {
      '6003': accounts['6003']._id, '2100': accounts['2100']._id,
    }),
    sourceModule: 'salary',
    sourceId: payment._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [salary accrual]: ${entry.entryNumber} | ${employeeName} | period: ${payment.period} | gross: ${gross}`);
  return entry;
};

// ─── postSalarySettlement ─────────────────────────────────────────────────────
// Trigger: Cash actually paid out for a previously-accrued salary.
//
// Settles the accrual liability and (if applicable) recovers any advance.
//
// When advance = 0:
//   DR  Accrued Expenses          (2100)  grossAmount
//   CR  Cash and Bank             (1001)  grossAmount
//
// When advance > 0:
//   DR  Accrued Expenses          (2100)  grossAmount − penaltyDeducted
//   CR  Salary Advance Receivable (1102)  advanceDeducted
//   CR  Cash and Bank             (1001)  netAmount

export const postSalarySettlement = async (payment, employeeName, createdBy) => {
  const gross = round2(payment.grossAmount);
  const advance = round2(payment.advanceDeducted || 0);
  const allowanceExcess = round2(payment.allowanceExcessDeducted || 0);
  const penalty = round2(payment.penaltyDeducted || 0);
  const accrued = round2(gross - penalty);
  const net = round2(payment.netAmount);

  const codesToFetch = ['2100', '1001'];
  if (advance > 0) codesToFetch.push('1102');
  if (allowanceExcess > 0) codesToFetch.push('1101');
  const accounts = await getAccounts(...codesToFetch);

  const creditLines = [];
  if (advance > 0) {
    creditLines.push({
      account: accounts['1102']._id,
      debit: 0,
      credit: advance,
      notes: `Advance recovered — ${employeeName}`,
    });
  }
  if (allowanceExcess > 0) {
    creditLines.push({
      account: accounts['1101']._id,
      debit: 0,
      credit: allowanceExcess,
      notes: `Allowance excess recovered — ${employeeName}`,
    });
  }
  creditLines.push({
    account: accounts['1001']._id,
    debit: 0,
    credit: net,
    notes: `Cash/Bank paid — ${employeeName}`,
  });

  const entry = await JournalEntry.create({
    date: payment.paymentDate ?? new Date(),
    description: `Salary settled — ${employeeName} (${payment.period})`,
    lines: [
      { account: accounts['2100']._id, debit: accrued, credit: 0, notes: `Accrual cleared — ${employeeName}` },
      ...creditLines,
    ],
    sourceModule: 'salary',
    sourceId: payment._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [salary settlement]: ${entry.entryNumber} | ${employeeName} | period: ${payment.period} | gross: ${gross} penalty: ${penalty} advance: ${advance} allowanceExcess: ${allowanceExcess} net: ${net}`);
  return entry;
};

// ─── postSalaryPayment ────────────────────────────────────────────────────────
// LEGACY — kept for backwards compat. New code should call postSalaryAccrual
// followed by postSalarySettlement so the expense lands in the correct period.
//
// When advanceDeducted = 0:
//   DR  Payroll Expense           (6003)  grossAmount
//   CR  Cash and Bank             (1001)  grossAmount
//
// When advanceDeducted > 0:
//   DR  Payroll Expense           (6003)  grossAmount
//   CR  Salary Advance Receivable (1102)  advanceDeducted
//   CR  Cash and Bank             (1001)  netAmount  (= gross − advance)

export const postSalaryPayment = async (payment, employeeName, createdBy) => {
  const gross = round2(payment.grossAmount);
  const advance = round2(payment.advanceDeducted || 0);
  const net = round2(payment.netAmount);

  const codesToFetch = ['6003', '1001'];
  if (advance > 0) codesToFetch.push('1102');
  const accounts = await getAccounts(...codesToFetch);

  const creditLines = [];
  if (advance > 0) {
    creditLines.push({
      account: accounts['1102']._id,
      debit: 0,
      credit: advance,
      notes: `Advance recovered — ${employeeName}`,
    });
  }
  creditLines.push({
    account: accounts['1001']._id,
    debit: 0,
    credit: net,
    notes: `Cash/Bank paid — ${employeeName}`,
  });

  const entry = await JournalEntry.create({
    date: payment.paymentDate ?? new Date(),
    description: `Salary paid — ${employeeName} (${payment.period})`,
    lines: [
      { account: accounts['6003']._id, debit: gross, credit: 0, notes: `Payroll Expense — ${employeeName}` },
      ...creditLines,
    ],
    sourceModule: 'salary',
    sourceId: payment._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [salary payment]: ${entry.entryNumber} | ${employeeName} | period: ${payment.period} | gross: ${gross}`);
  return entry;
};

// ─── postSalaryAdvance ────────────────────────────────────────────────────────
// Trigger: Advance given to employee.
//
// DR  Salary Advance Receivable (1102)  amount
// CR  Cash and Bank             (1001)  amount

export const postSalaryAdvance = async (advance, employeeName, createdBy) => {
  const accounts = await getAccounts('1102', '1001');
  const amount = round2(advance.amount);

  const entry = await JournalEntry.create({
    date: advance.advanceDate ?? new Date(),
    description: `Salary advance — ${employeeName}`,
    lines: [
      { account: accounts['1102']._id, debit: amount, credit: 0, notes: `Advance given — ${employeeName}` },
      { account: accounts['1001']._id, debit: 0, credit: amount, notes: `Cash/Bank paid — ${employeeName}` },
    ],
    sourceModule: 'salaryAdvance',
    sourceId: advance._id,
    sourcePath: `/salaries?tab=advances&advance=${advance._id}`,
    party: 'Salary Advance',
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [salary advance]: ${entry.entryNumber} | ${employeeName} | amount: ${amount}`);
  return entry;
};

// ─── postChargeToSalary ───────────────────────────────────────────────────────
// Trigger: Staff meal / item charged to salary (CTS). No cash moves — the staff
// owes the value of what they consumed, recovered from salary like an advance.
//
// DR  Salary Advance Receivable (1102)  amount
// CR  <selected revenue head>           amount

export const postChargeToSalary = async (advance, employeeName, revenueAccountId, createdBy) => {
  const accounts = await getAccounts('1102');
  const amount = round2(advance.amount);

  const revenue = await ChartOfAccounts.findById(revenueAccountId).lean();
  if (!revenue) {
    const err = new Error('Revenue account not found for charge-to-salary.');
    err.statusCode = 400;
    throw err;
  }

  const entry = await JournalEntry.create({
    date: advance.advanceDate ?? new Date(),
    description: `Charge to salary — ${employeeName}`,
    lines: [
      { account: accounts['1102']._id, debit: amount, credit: 0, notes: `Charged to salary — ${employeeName}` },
      { account: revenue._id, debit: 0, credit: amount, notes: `Sale charged to salary — ${employeeName}` },
    ],
    sourceModule: 'salaryAdvance',
    sourceId: advance._id,
    sourcePath: `/salaries?tab=advances&advance=${advance._id}`,
    party: 'Salary Advance',
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [charge to salary]: ${entry.entryNumber} | ${employeeName} | amount: ${amount} | revenue: ${revenue.code}`);
  return entry;
};

// ─── postAdvanceRepayment ─────────────────────────────────────────────────────
// Trigger: Employee repays advance directly (cash/bank, not via salary deduction).
//
// DR  Cash and Bank             (1001)  amount
// CR  Salary Advance Receivable (1102)  amount

export const postAdvanceRepayment = async ({ advanceId, amount, repaymentDate, employeeName, createdBy }) => {
  const accounts = await getAccounts('1001', '1102');
  const amt = round2(amount);

  const entry = await JournalEntry.create({
    date: repaymentDate ?? new Date(),
    description: `Advance repayment — ${employeeName}`,
    lines: [
      { account: accounts['1001']._id, debit: amt, credit: 0, notes: `Cash/Bank received — ${employeeName}` },
      { account: accounts['1102']._id, debit: 0, credit: amt, notes: `Salary Advance Receivable cleared — ${employeeName}` },
    ],
    sourceModule: 'salaryAdvance',
    sourceId: advanceId ?? null,
    sourcePath: advanceId ? `/salaries?tab=advances&advance=${advanceId}` : undefined,
    party: 'Salary Advance',
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [advance repayment]: ${entry.entryNumber} | ${employeeName} | amount: ${amt}`);
  return entry;
};

// ─── postLoyaltyEarn ──────────────────────────────────────────────────────────
// Trigger: Customer earns points on a sale.
//
// DR  Membership Rewards Expense   (5005)  pointsValue
// CR  Membership Rewards Liability (2200)  pointsValue

export const postLoyaltyEarn = async ({ pointsValue, transaction, loyaltyTxnId, createdBy }) => {
  const accounts = await getAccounts('5005', '2200');
  const amount = round2(pointsValue);
  if (amount <= 0) return null;

  const entry = await JournalEntry.create({
    date: saleAccountingDate(transaction),
    description: `Rewards points earned — ${transaction?.transactionNumber ?? loyaltyTxnId}`,
    lines: [
      { account: accounts['5005']._id, debit: amount, credit: 0, notes: 'Rewards expense recognised' },
      { account: accounts['2200']._id, debit: 0, credit: amount, notes: 'Liability for outstanding points' },
    ],
    sourceModule: 'loyalty',
    sourceId: loyaltyTxnId ?? transaction?._id ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [loyalty earn]: ${entry.entryNumber} | value: ${amount}`);
  return entry;
};

// ─── postLoyaltyExpiry ────────────────────────────────────────────────────────
// Trigger: Cron job — points past expiryMonths are written off.
//
// DR  Membership Rewards Liability (2200)        expiredValue
// CR  Membership Rewards Breakage  (4003)        expiredValue   (default)
// or  Membership Rewards Expense   (5005)        expiredValue   (if config so chooses)

export const postLoyaltyExpiry = async ({ expiredValue, breakageAccountCode = '4003', loyaltyTxnId, createdBy }) => {
  const creditCode = breakageAccountCode === '5005' ? '5005' : '4003';
  const accounts = await getAccounts('2200', creditCode);
  const amount = round2(expiredValue);
  if (amount <= 0) return null;

  const entry = await JournalEntry.create({
    date: new Date(),
    description: `Rewards points expired`,
    lines: [
      { account: accounts['2200']._id, debit: amount, credit: 0, notes: 'Liability extinguished — expiry' },
      {
        account: accounts[creditCode]._id,
        debit: 0,
        credit: amount,
        notes: creditCode === '4003' ? 'Breakage income' : 'Reversal of rewards expense',
      },
    ],
    sourceModule: 'loyalty',
    sourceId: loyaltyTxnId ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [loyalty expiry]: ${entry.entryNumber} | value: ${amount}`);
  return entry;
};

// ─── postLoyaltyAdjust ────────────────────────────────────────────────────────
// Trigger: Manager-initiated balance adjustment (gift, correction, dispute resolution).
//
// Positive points (credit to customer):
//   DR  Membership Rewards Expense   (5005)  delta
//   CR  Membership Rewards Liability (2200)  delta
//
// Negative points (debit from customer — claw-back):
//   DR  Membership Rewards Liability (2200)  abs(delta)
//   CR  Membership Rewards Expense   (5005)  abs(delta)

export const postLoyaltyAdjust = async ({ pointsValueDelta, loyaltyTxnId, note, createdBy }) => {
  const accounts = await getAccounts('5005', '2200');
  const amount = round2(Math.abs(pointsValueDelta));
  if (amount <= 0) return null;
  const isCredit = pointsValueDelta > 0;

  const entry = await JournalEntry.create({
    date: new Date(),
    description: `Rewards adjustment${note ? ` — ${note}` : ''}`,
    lines: isCredit
      ? [
          { account: accounts['5005']._id, debit: amount, credit: 0, notes: 'Adjustment — points granted' },
          { account: accounts['2200']._id, debit: 0, credit: amount, notes: 'Adjustment — liability raised' },
        ]
      : [
          { account: accounts['2200']._id, debit: amount, credit: 0, notes: 'Adjustment — liability reduced' },
          { account: accounts['5005']._id, debit: 0, credit: amount, notes: 'Adjustment — expense reversed' },
        ],
    sourceModule: 'loyalty',
    sourceId: loyaltyTxnId ?? null,
    status: 'posted',
    createdBy: createdBy ?? null,
  });

  logger.info(`JE posted [loyalty adjust]: ${entry.entryNumber} | delta: ${pointsValueDelta}`);
  return entry;
};

// ─── postSaleAsWasteLoss ──────────────────────────────────────────────────────
// Trigger: A completed POS sale transaction is marked as waste/loss.
//
// The original sale already posted:
//   DR  Cash/Bank (1001)             totalAmount
//   CR  Sales Revenue (4001)         totalAmount
//
// When the order is marked as waste (e.g. wrong order, dropped food), the
// wasted amount is reclassified as an expense — exactly like manual waste.
// We do NOT touch the revenue accounts here; the sale revenue stays on the
// books but the matching waste expense records the true cost of the loss.
//
//   DR  Waste and Spoilage (5003)  ingredientCost   ← loss recorded as expense
//   CR  Purchase Expense   (5002)  ingredientCost   ← reclassified from purchase
//
// @param {object} wasteLog          - The saved WasteLog document.
// @param {number} ingredientCost    - Ingredient cost to reclassify as loss.
// @param {string} transactionNumber - POS transaction number for traceability.
// @param {*}      createdBy         - User ID who triggered the action.

export const postSaleAsWasteLoss = async (wasteLog, ingredientCost, transactionNumber, createdBy, { session = null } = {}) => {
  const accounts = await getAccounts('5003', '5002');
  const amount = round2(ingredientCost);

  const entryData = {
    date: wasteLog.loggedAt ?? new Date(),
    description: `Sale voided as waste — ${transactionNumber ?? wasteLog.saleTransactionId}`,
    lines: [
      {
        account: accounts['5003']._id,
        debit: amount,
        credit: 0,
        notes: `Waste/Loss — order ${transactionNumber} marked as waste`,
      },
      {
        account: accounts['5002']._id,
        debit: 0,
        credit: amount,
        notes: `Reclassified from Purchase Expense — order ${transactionNumber} voided as waste`,
      },
    ],
    sourceModule: 'waste',
    sourceId: wasteLog._id,
    status: 'posted',
    createdBy: createdBy ?? null,
  };
  const entry = session
    ? (await JournalEntry.create([entryData], { session }))[0]
    : await JournalEntry.create(entryData);

  logger.info(
    `JE posted [sale-waste-loss]: ${entry.entryNumber} | tx: ${transactionNumber} | amount: ${amount}`
  );
  return entry;
};
