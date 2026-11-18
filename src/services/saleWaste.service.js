// saleWaste.service.js — shared logic for logging a completed POS sale as
// waste/loss. Used by BOTH the management waste log (inventory.controller) and
// the POS terminal order-history waste action (sale.controller) so the accounts
// impact is identical no matter where it's triggered from.
//
// Accounting: a punched order logged as waste reclassifies its recipe
// (ingredient) cost out of Purchase Expense into Waste & Spoilage:
//   DR  Waste and Spoilage (5003)  recipeCost
//   CR  Purchase Expense   (5002)  recipeCost
// The Waste Log may be valued at recipe cost or final order value for management
// reporting. Order value never changes the journal amount: retail markup, tax,
// and service charges are not inventory cost and must not be credited out of
// Purchase Expense.

import mongoose from 'mongoose';
import MenuItem from '../models/MenuItem.js';
import WasteLog from '../models/WasteLog.js';
import StockItem from '../models/StockItem.js';
import Product from '../models/Product.js';
import Outlet from '../models/Outlet.js';
import IngredientUsageLog from '../models/IngredientUsageLog.js';
import { postSaleAsWasteLoss } from '../accounting/journalEngine.js';
import { recordStockMovements } from './stockLedger.js';
import { convertQty as convertStockQty } from '../utils/unitConversion.js';
import { localDateStr, startOfLocalDayUtc, DEFAULT_TZ } from '../utils/timezone.js';
import logger from '../utils/logger.js';

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));

// ── Unit conversion (mirrors the menu/recipe costing units) ────────────────────
// Convert a quantity from one unit to another within the same family
// (weight/volume/count). Returns { qty, converted }; converted=false when the
// families differ or are unknown, in which case the original qty is returned
// 1:1 so callers can flag the mismatch instead of silently mis-deducting.
export const convertQty = (qty, fromUnit = '', toUnit = '') => (
  convertStockQty(qty, fromUnit, toUnit)
);

// Cost of (ingQty ingUnit) priced at pricePerProductUnit / productUnit.
export const ingredientCostValue = (ingQty, ingUnit, pricePerProductUnit, productUnit) => {
  const { qty: qtyInProductUnit } = convertStockQty(ingQty, ingUnit, productUnit);
  return qtyInProductUnit * pricePerProductUnit;
};

const recipeSourcesForLine = (item, menuItemMap) => {
  if (item.dealComponents?.length) {
    return item.dealComponents.flatMap((component) => {
      const componentItem = menuItemMap[component.menuItem?.toString()];
      if (!componentItem) return [];
      let ingredients = componentItem.ingredients || [];
      if (component.variation?.id) {
        const variation = (componentItem.variations || []).find((candidate) => (
          candidate._id.toString() === component.variation.id.toString()
        ));
        ingredients = variation?.ingredients || [];
      }
      return [{
        ingredients,
        qty: (Number(item.qty) || 0) * (Number(component.qtyPerDeal) || 1),
      }];
    });
  }

  if (!item.menuItem) return [];
  const menuItem = menuItemMap[item.menuItem.toString()];
  if (!menuItem) return [];
  let ingredients = menuItem.ingredients || [];
  if (item.variation?.id) {
    const variation = (menuItem.variations || []).find((candidate) => (
      candidate._id.toString() === item.variation.id.toString()
    ));
    ingredients = variation?.ingredients || [];
  }
  return [{ ingredients, qty: Number(item.qty) || 0 }];
};

// ── computeRecipeCost ──────────────────────────────────────────────────────────
// Per-item ingredient cost breakdown + overall recipeCost. Only an attached
// recipe contributes ingredient cost. A menu item without a recipe costs zero;
// its retail selling price must never be treated as inventory cost.
export const computeRecipeCost = (transactionItems, menuItemMap) => {
  let recipeCost = 0;

  const breakdown = transactionItems.map((item) => {
    const entry = {
      name: item.name,
      variation: item.variation,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      ingredientCost: 0,
      ingredients: [],
      usingFallback: false,
    };

    const sources = recipeSourcesForLine(item, menuItemMap);
    let itemCost = 0;
    for (const source of sources) {
      for (const ing of source.ingredients) {
      const product = ing.product;
      if (!product) continue;
      // currentPrice is the canonical weighted-average cost; vendor/default are fallbacks.
      const unitCost = product.currentPrice || product.vendors?.[0]?.currentPrice || product.defaultPrice || 0;
      const totalIngQty = ing.qty * source.qty;
      const ingCost = ingredientCostValue(totalIngQty, ing.unit, unitCost, product.unit);
      itemCost += ingCost;
      entry.ingredients.push({
        name: product.name,
        qty: parseFloat(totalIngQty.toFixed(4)),
        unit: ing.unit,
        unitCost,
        productUnit: product.unit,
        cost: parseFloat(ingCost.toFixed(2)),
      });
      }
    }

    entry.ingredientCost = parseFloat(itemCost.toFixed(2));
    recipeCost += itemCost;
    return entry;
  });

  return { breakdown, recipeCost: parseFloat(recipeCost.toFixed(2)) };
};

// Allocate the transaction's final billed total across its item lines. The
// allocation uses each line's sale value as its weight, which proportionally
// carries order-level tax, service charges, and discounts into partial-waste
// selections. The final line absorbs rounding so a whole order always adds up
// exactly to totalAmount.
export const allocateOrderValues = (transactionItems = [], totalAmount = 0) => {
  const rawValues = transactionItems.map((item) => Math.max(
    0,
    Number(item?.lineTotal ?? (Number(item?.unitPrice) || 0) * (Number(item?.qty) || 0)) || 0,
  ));
  let weightTotal = rawValues.reduce((sum, value) => sum + value, 0);
  let weights = rawValues;

  // Legacy/free lines can have no stored line value. Fall back to quantity so
  // a non-zero final order total can still be allocated deterministically.
  if (weightTotal <= 0) {
    weights = transactionItems.map((item) => Math.max(0, Number(item?.qty) || 0));
    weightTotal = weights.reduce((sum, value) => sum + value, 0);
  }

  const finalTotal = Math.max(0, Number(totalAmount) || weightTotal || 0);
  if (weightTotal <= 0 || finalTotal <= 0) return transactionItems.map(() => 0);

  let allocated = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return round2(finalTotal - allocated);
    const value = round2(finalTotal * (weight / weightTotal));
    allocated = round2(allocated + value);
    return value;
  });
};

export const computeOrderValueForSelection = (transactionItems = [], totalAmount = 0, perIndex = new Map()) => {
  const allocatedLines = allocateOrderValues(transactionItems, totalAmount);
  const selectedLines = [];
  let orderValue = 0;

  for (const [index, selectedQty] of perIndex) {
    const originalQty = Number(transactionItems[index]?.qty) || 0;
    const lineOrderValue = originalQty > 0
      ? round2((allocatedLines[index] || 0) * (Number(selectedQty) || 0) / originalQty)
      : 0;
    selectedLines.push({ index, orderValue: lineOrderValue });
    orderValue += lineOrderValue;
  }

  return { allocatedLines, selectedLines, orderValue: round2(orderValue) };
};

// Build the authoritative costing preview for the remaining units selected from
// an order. This is intentionally shared by the POS preview endpoint and the
// write path so the amount a cashier approves is calculated by the same rules as
// the WasteLog that is ultimately created.
export const previewSaleWaste = async ({ transaction, selection = null }) => {
  const { perIndex } = resolveWasteSelection(transaction, selection);

  const menuItemIds = transaction.items.flatMap((item) => [
    item.menuItem,
    ...(item.dealComponents || []).map((component) => component.menuItem),
  ]).filter(Boolean);
  const menuItems = menuItemIds.length
    ? await MenuItem.find({ _id: { $in: menuItemIds } })
        .populate('ingredients.product', 'name vendors defaultPrice currentPrice unit')
        .populate('variations.ingredients.product', 'name vendors defaultPrice currentPrice unit')
        .lean()
    : [];
  const menuItemMap = Object.fromEntries(menuItems.map((item) => [item._id.toString(), item]));

  // Scope every line to the quantity being previewed. This matters for partially
  // wasted paid orders and for held-order cancellations where only some prepared
  // items are being discarded.
  const subsetItems = [];
  const sourceIndexes = [];
  for (const [index, qty] of perIndex) {
    const item = transaction.items[index];
    const raw = typeof item.toObject === 'function' ? item.toObject() : { ...item };
    sourceIndexes.push(index);
    subsetItems.push({
      ...raw,
      qty,
      lineTotal: round2((Number(raw.unitPrice) || 0) * qty),
    });
  }

  const { breakdown, recipeCost } = computeRecipeCost(subsetItems, menuItemMap);
  const { selectedLines, orderValue } = computeOrderValueForSelection(
    transaction.items,
    transaction.totalAmount,
    perIndex,
  );

  return {
    perIndex,
    sourceIndexes,
    subsetItems,
    menuItemMap,
    breakdown,
    recipeCost,
    selectedLines,
    orderValue,
  };
};

// ── Re-preparation stock deduction ───────────────────────────────────────────
// When a wasted order is re-cooked for the customer, the kitchen physically
// consumes the recipe a SECOND time. The original sale deducted stock only once,
// so we deduct it again here to keep the on-hand count exact. This is purely an
// inventory movement — NO extra journal entry is posted: ingredient cost is
// expensed at purchase time, the wasted batch is the only true loss (already
// reclassified to Waste & Spoilage), and the re-made batch is the legitimate cost
// of the food the customer received (it stays in Purchase Expense).

// Build a per-product stock-deduction plan from the stored sale items, resolving
// each line's recipe variation-aware (mirrors _buildRecipeDeductionPlan in the
// sale controller so the re-deduction matches the original sale exactly).
const buildSnapshotDeductionPlan = (transactionItems, menuItemMap) => {
  const byProduct = new Map();

  for (const item of transactionItems) {
    const sources = recipeSourcesForLine(item, menuItemMap);
    for (const source of sources) {
      for (const ing of source.ingredients) {
      const product = ing.product;
      if (!product) continue;

      const recipeQty = Number(ing.qty) * source.qty;
      const stockUnit = product.unit || ing.unit;
      const { qty: qtyInStockUnit, converted } = convertStockQty(recipeQty, ing.unit, stockUnit);

      const pid = (product._id ?? product).toString();
      const entry = byProduct.get(pid) ?? {
        productId: product._id ?? product,
        productName: product.name ?? pid,
        stockUnit,
        qtyInStockUnit: 0,
        converted: true,
      };
      entry.qtyInStockUnit += qtyInStockUnit;
      if (!converted) entry.converted = false;
      byProduct.set(pid, entry);
      }
    }
  }

  return [...byProduct.values()];
};

// Apply the second recipe deduction to StockItem.qtyOnHand and bump expected
// usage for the day. Best-effort and non-blocking — a stock hiccup must not stop
// the order being recorded as waste. Negatives are allowed (and warned), exactly
// like the sale path.
const applyRemakeDeduction = async (plan, transaction, movementType = 'reprepare', session = null) => {
  if (!plan.length) return;

  // Match StockItems by outlet _id OR code string, mirroring the sale path
  // (legacy StockItems may store outlet as the code).
  const outlet = await Outlet.findById(transaction.outlet).select('code timezone').lean();
  const outletId = transaction.outlet;
  const outletMatch = outlet?.code ? [{ outlet: outletId }, { outlet: outlet.code }] : [{ outlet: outletId }];

  // Re-make re-consumes from the KITCHEN, exactly like the original sale.
  const applied = [];
  for (const d of plan) {
    if (!d.converted) {
      logger.warn(`[REMAKE] Unit conversion uncertain for "${d.productName}" — deducting raw qty ${d.qtyInStockUnit} ${d.stockUnit}.`);
    }
    const productOid = d.productId instanceof mongoose.Types.ObjectId
      ? d.productId
      : new mongoose.Types.ObjectId(d.productId);
    try {
      const result = await StockItem.collection.findOneAndUpdate(
        { product: productOid, area: 'kitchen', $or: outletMatch },
        { $inc: { qtyOnHand: -d.qtyInStockUnit } },
        { returnDocument: 'after', ...(session ? { session } : {}) },
      );
      const updated = result?.value ?? result;
      if (!updated) {
        logger.warn(`[REMAKE] No kitchen StockItem for "${d.productName}" (${d.productId}) at outlet ${outletId} — re-make stock not decremented.`);
      } else {
        applied.push({ productOid, qty: d.qtyInStockUnit, unit: d.stockUnit });
        if (updated.qtyOnHand < 0) {
          logger.warn(`[REMAKE] Stock went negative for "${d.productName}" (qtyOnHand: ${updated.qtyOnHand} ${d.stockUnit}) on re-make. Allowed.`);
        }
      }
    } catch (err) {
      if (session) throw err;
      logger.error(`[REMAKE] Failed to deduct stock for "${d.productName}": ${err.message}`);
    }
  }

  // Ledger: one 'reprepare' row per ingredient re-deducted (kitchen, −qty).
  if (applied.length) {
    const costMap = new Map();
    try {
      const costDocs = await Product.find({ _id: { $in: applied.map((a) => a.productOid) } })
        .select('currentPrice').lean();
      costDocs.forEach((p) => costMap.set(p._id.toString(), p.currentPrice || 0));
    } catch { /* movement cost is best-effort */ }

    await recordStockMovements(applied.map((a) => ({
      product:  a.productOid,
      outlet:   outletId,
      area:     'kitchen',
      qty:      -a.qty,
      unit:     a.unit,
      type:     movementType,
      unitCost: costMap.get(a.productOid.toString()) || 0,
      ref:      { kind: 'saleTransaction', id: transaction._id },
      user:     transaction.cashier,
    })), { session });
  }

  // Mirror the sale's expected-usage tracking so dashboards stay aligned with
  // the second physical consumption.
  try {
    const tz = outlet?.timezone || DEFAULT_TZ;
    const day = startOfLocalDayUtc(localDateStr(new Date(), tz), tz);
    for (const d of plan) {
      await IngredientUsageLog.findOneAndUpdate(
        { product: d.productId, outlet: outletId, date: day },
        {
          $inc: { expectedUsage: d.qtyInStockUnit },
          $set: { unit: d.stockUnit },
          $setOnInsert: { actualUsage: 0, variance: 0, variancePct: 0, movingAvgVariance: 0 },
        },
        { upsert: true, ...(session ? { session } : {}) },
      );
    }
  } catch (err) {
    if (session) throw err;
    logger.warn(`[REMAKE] Failed to record expected usage: ${err.message}`);
  }
};

// ── resolveWasteSelection ─────────────────────────────────────────────────────
// Turn a caller's selection into a validated per-line wasted-quantity map.
//   selection === null/undefined → waste ALL remaining units of every line.
//   selection = [{ index, qty }]  → waste `qty` units of transaction.items[index].
// Throws an Error with a .statusCode (400/409) on an invalid/over selection so
// the controller can map it to the right HTTP status.
const resolveWasteSelection = (transaction, selection) => {
  const items = transaction.items;
  const remaining = items.map((it) => (Number(it.qty) || 0) - (Number(it.wastedQty) || 0));
  const totalRemaining = remaining.reduce((s, r) => s + Math.max(0, r), 0);

  if (totalRemaining <= 0) {
    const e = new Error('This order has no remaining items left to waste.');
    e.statusCode = 409;
    throw e;
  }

  const perIndex = new Map(); // index → qty to waste in this event

  if (selection == null) {
    remaining.forEach((r, i) => { if (r > 0) perIndex.set(i, r); });
    return { perIndex, remaining };
  }

  if (!Array.isArray(selection) || selection.length === 0) {
    const e = new Error('Select at least one item to waste.');
    e.statusCode = 400;
    throw e;
  }

  for (const sel of selection) {
    const idx = Number(sel?.index);
    const qty = Number(sel?.qty);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
      const e = new Error('Invalid item selection.');
      e.statusCode = 400;
      throw e;
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      const e = new Error('Waste quantity must be a whole number greater than zero.');
      e.statusCode = 400;
      throw e;
    }
    perIndex.set(idx, (perIndex.get(idx) || 0) + qty);
  }

  for (const [idx, qty] of perIndex) {
    if (qty > remaining[idx] + 1e-9) {
      const e = new Error(`Cannot waste more than the remaining quantity for "${items[idx]?.name ?? 'item'}".`);
      e.statusCode = 400;
      throw e;
    }
  }

  return { perIndex, remaining };
};

// ── logSaleAsWaste ───────────────────────────────────────────────────────────
// Core action: compute recipe cost for the wasted selection, create the WasteLog
// (source 'saleOrder'), post the reclassification journal entry, bump per-line
// wastedQty, and update the order's waste state. The caller validates the
// transaction (exists / completed / not already FULLY wasted / ownership) first.
//
// `selection` chooses what to waste (see resolveWasteSelection): null = the whole
// remaining order; an array = a subset of items/quantities (partial waste).
//
// When `rePrepare` is true the wasted selection is being re-cooked for the
// customer, so we additionally deduct its recipe from stock a second time.
//
// `deductStock` is for a cancellation marked ALREADY PREPARED. A held order never
// deducted stock, while a paid order void restores its original deduction first;
// either way the prepared selection must be deducted once here and recorded as a
// plain 'waste' movement. rePrepare and deductStock are mutually exclusive in
// practice; either one triggers the physical deduction.
//
// `transaction` is a Mongoose document unless persistTransaction is false.
// Item cancellation uses a detached snapshot and commits all writes in session.
export const logSaleAsWaste = async ({
  transaction,
  reason = 'orderVoid',
  notes = '',
  userId = null,
  rePrepare = false,
  deductStock = false,
  selection = null,
  valuationMethod = 'ingredientCost',
  requirePositiveValue = false,
  session = null,
  persistTransaction = true,
}) => {
  if (!['ingredientCost', 'orderValue'].includes(valuationMethod)) {
    const error = new Error('Waste valuation must be ingredient cost or order value.');
    error.statusCode = 400;
    throw error;
  }

  // Resolve, validate, and calculate the selection BEFORE any write.
  const {
    perIndex,
    subsetItems,
    menuItemMap,
    breakdown,
    recipeCost,
    selectedLines,
    orderValue,
  } = await previewSaleWaste({ transaction, selection });
  const wasteValue = valuationMethod === 'orderValue' ? orderValue : recipeCost;

  if (requirePositiveValue && wasteValue <= 0) {
    const error = new Error(
      valuationMethod === 'ingredientCost'
        ? 'Ingredient cost is zero. Choose Order value or record the ingredient purchase costs before logging this waste.'
        : 'Order value is zero, so this waste cannot be logged with Order value.',
    );
    error.statusCode = 400;
    throw error;
  }

  const originalTotalUnits = transaction.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
  const unitsThisEvent = [...perIndex.values()].reduce((s, q) => s + q, 0);
  const partial = unitsThisEvent < originalTotalUnits - 1e-9;

  logger.info(
    `Sale waste recipe cost: tx ${transaction.transactionNumber} | ` +
    `${partial ? 'PARTIAL' : 'whole'} | units: ${unitsThisEvent}/${originalTotalUnits} | ` +
    `valuation: ${valuationMethod} | wasteValue: ${wasteValue} | recipeCost: ${recipeCost}`
  );

  const saleOrderSnapshot = {
    transactionNumber: transaction.transactionNumber,
    saleTotal: transaction.totalAmount,
    items: breakdown.map(({ name, variation, qty, unitPrice, lineTotal, ingredientCost, usingFallback }, index) => ({
      name,
      variation,
      qty,
      unitPrice,
      lineTotal,
      ingredientCost,
      orderValue: selectedLines[index]?.orderValue || 0,
      usingFallback,
    })),
    recipeCost,
    orderValue,
  };

  const wasteData = {
    source: 'saleOrder',
    saleTransactionId: transaction._id,
    saleOrderSnapshot,
    reason,
    notes: notes ?? '',
    totalCost: wasteValue,
    valuationMethod,
    rePrepared: !!rePrepare,
    reMakeCost: rePrepare ? recipeCost : 0,
    partial,
    outlet: transaction.outlet,
    // Who logged the waste. Fall back to the order's cashier when no explicit
    // user is supplied, so a punched-order waste always attributes to someone.
    loggedBy: userId ?? transaction.cashier ?? null,
    loggedAt: new Date(),
  };
  const wasteLog = session
    ? (await WasteLog.create([wasteData], { session }))[0]
    : await WasteLog.create(wasteData);

  // Accounting always reclassifies ingredient cost. A management choice to
  // value the waste at retail order value must not move markup/tax/service
  // charges out of Purchase Expense.
  let journalEntry = null;
  if (recipeCost > 0) {
    try {
      journalEntry = await postSaleAsWasteLoss(
        wasteLog,
        recipeCost,
        transaction.transactionNumber,
        userId ?? null,
        { session },
      );
      wasteLog.journalEntryId = journalEntry._id;
      await wasteLog.save(session ? { session } : {});
    } catch (err) {
      if (session) throw err;
      logger.error(`Journal entry failed for sale waste ${wasteLog._id}: ${err.message}`);
      // Non-blocking — the waste is logged even if the JE fails.
    }
  }

  // Physical stock deduction. Two triggers:
  //   • rePrepare  — a completed sale's wasted items are re-cooked (2nd deduction).
  //   • deductStock — an already-prepared order is being cancelled; its prepared
  //                   recipe selection must remain consumed once after the void.
  // Purely an inventory movement — no extra journal entry (the waste JE above
  // already records the cost). Movement type distinguishes the two in the ledger.
  if (rePrepare || deductStock) {
    const plan = buildSnapshotDeductionPlan(subsetItems, menuItemMap);
    await applyRemakeDeduction(plan, transaction, rePrepare ? 'reprepare' : 'waste', session);
    logger.info(`${rePrepare ? 'Re-prepared' : 'Cancelled-prepared'} order ${transaction.transactionNumber}: stock deducted for ${plan.length} product(s).`);
  }

  // Bump per-line wasted quantities and recompute the order's waste state.
  for (const [idx, qty] of perIndex) {
    const it = transaction.items[idx];
    it.wastedQty = (Number(it.wastedQty) || 0) + qty;
  }
  if (persistTransaction) transaction.markModified('items');

  const fullyWasted = transaction.items.every((it) => (Number(it.wastedQty) || 0) >= (Number(it.qty) || 0) - 1e-9);
  const someWasted = transaction.items.some((it) => (Number(it.wastedQty) || 0) > 0);
  transaction.isVoidedAsWaste = fullyWasted;
  transaction.partiallyWasted = someWasted && !fullyWasted;
  transaction.rePrepared = !!transaction.rePrepared || !!rePrepare;
  transaction.wasteLogId = wasteLog._id;
  if (persistTransaction) await transaction.save(session ? { session } : {});

  return {
    wasteLog,
    journalEntry,
    recipeCost,
    orderValue,
    wasteValue,
    valuationMethod,
    rePrepared: !!rePrepare,
    partial,
    fullyWasted,
    partiallyWasted: transaction.partiallyWasted,
  };
};
