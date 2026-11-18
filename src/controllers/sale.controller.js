import mongoose from 'mongoose';
import { assertKitchenCancellationVersion, kitchenCancellationWriteFilter } from '../utils/kdsItemCancellation.js';
import SaleTransaction from '../models/SaleTransaction.js';
import KdsOrder from '../models/KdsOrder.js';
import PrintJob from '../models/PrintJob.js';
import SaleSession from '../models/SaleSession.js';
import SaleReturn from '../models/SaleReturn.js';
import MenuItem from '../models/MenuItem.js';
import StockItem from '../models/StockItem.js';
import StockMovement from '../models/StockMovement.js';
import Product from '../models/Product.js';
import IngredientUsageLog from '../models/IngredientUsageLog.js';
import Outlet from '../models/Outlet.js';
import Table from '../models/Table.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import StaffAllowance from '../models/StaffAllowance.js';
import Employee from '../models/Employee.js';
import SalaryAdvance from '../models/SalaryAdvance.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import { postSale, postAllowanceSale, postChargeToSalary, reverseJournalEntry } from '../accounting/journalEngine.js';
import { convertQty } from '../utils/unitConversion.js';
import logger from '../utils/logger.js';
import {
  getOrCreateConfig as getLoyaltyConfig,
  computeEarnPoints,
  validateRedeem,
  recordEarn,
  recordRedeem,
  reverseSaleLoyalty,
} from '../services/loyalty.service.js';
import { logSaleAsWaste, previewSaleWaste } from '../services/saleWaste.service.js';
import { recordStockMovements } from '../services/stockLedger.js';
import { businessDateRange, getBusinessDate } from '../utils/businessDate.js';
import {
  initialPraCreditState,
  initialPraState,
  submitCreditToPra,
  submitSaleToPra,
} from '../services/pra.service.js';
import {
  ensurePraOutboxEvent,
  publishPraOutboxEventById,
} from '../queues/pra.queue.js';
import { env } from '../config/env.js';
import {
  getTaxConfig,
  effectiveTaxRate as resolveEffectiveTaxRate,
  reducedRateFractionFor,
  serviceChargeAppliesTo,
} from '../services/tax.service.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { resolveTimezone, localMonth, localDateStr, startOfLocalDayUtc, DEFAULT_TZ } from '../utils/timezone.js';
import { isFeatureEnabledForOutlet } from '../services/outletFeatures.service.js';
import RiderShift from '../models/RiderShift.js';
import RiderDevice from '../models/RiderDevice.js';
import DeliveryAssignment from '../models/DeliveryAssignment.js';
import {
  assignUserRider,
  cancelUserRiderAssignment,
  syncUserRiderAssignment,
} from '../services/deliveryAssignment.service.js';
import { coordinatesFromGeoPoint, metersBetween } from '../services/riderTracking.service.js';
import { riderTrackingHealth } from '../services/riderTrackingHealth.service.js';
import {
  authorizeEmployeeCredit,
  getEmployeeCreditSummary,
  normalizedEmployeeCreditLimits,
  withEmployeeCreditLock,
} from '../services/employeeCredit.service.js';
import { enforceManualDiscountLimit } from '../utils/posDiscountLimit.js';
import { resolveMenuUnitPrice } from '../utils/menuPricing.js';
import { calculateLineCharges, priceLines } from '../utils/chargeInclusivePricing.js';
import { saleSchema } from '../validators/sale.validator.js';
import { withQrTableLock } from '../services/qrTableLock.service.js';
import { qrOrderTimingData, stampQrKitchenTiming } from '../services/qrOrderState.service.js';
import {
  ensureKdsOrderForSale,
  isKdsEnabled,
  getSaleKdsCancellationState,
  getSalesKdsCancellationStates,
  kdsCancellationState,
  assertPosCancellationAllowed,
  relinkKdsOrderToFinalSale,
  reportKdsError,
  syncKdsCancellation,
  syncKdsRiderAssignment,
} from '../services/kds.service.js';
import {
  kitchenLineKey,
  normalizePrintedQuantityMap,
  transferPrintedQuantity,
} from '../utils/kitchenPrintedQuantity.js';
import {
  canCancelKitchenSentItems,
  findHeldItemCancellations,
  attachHeldItemCancellationDetails,
  validateHeldItemCancellations,
  cancellationOrderSnapshot,
} from '../utils/heldItemCancellation.js';
import { loadDealComponentMap, resolveDeal } from '../services/deal.service.js';

const finishPraCancellation = async (transaction, tenantSlug) => {
  // If PRA never accepted the original invoice there is nothing to credit;
  // move its pending state to skipped so an old sale job cannot report a
  // transaction after it has been cancelled locally.
  if (transaction.pra?.status && transaction.pra.status !== 'reported') {
    await submitSaleToPra(transaction);
    return;
  }
  if (transaction.pra?.credit?.status !== 'pending') return;

  await submitCreditToPra(transaction);
  if (!env.PRA_QUEUE_ENABLED || transaction.pra?.credit?.status !== 'pending') return;
  try {
    const event = await ensurePraOutboxEvent(transaction._id, 'credit');
    publishPraOutboxEventById(tenantSlug, event._id)
      .catch((error) => logger.error(`[PRA] credit queue publish error: ${error.message}`));
  } catch (error) {
    logger.error(`[PRA] could not queue credit for ${transaction._id}: ${error.message}`);
  }
};

// Cheap per-outlet loyalty check (the entitlement lives on the platform-side
// Tenant document while the sale runs inside the tenant database context).
const isMembershipRewardsEnabled = async (cashier, outletId, tenantSnapshot = null) => {
  try {
    if (!cashier?.tenantSlug || !outletId) return false;
    const tenant = tenantSnapshot?.slug === cashier.tenantSlug
      ? tenantSnapshot
      : await TenantModel().findOne({ slug: cashier.tenantSlug }).lean();
    if (!tenant) return false;
    return isFeatureEnabledForOutlet(tenant, 'membershipRewards', outletId);
  } catch {
    return false;
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const round2 = (n) => parseFloat(n.toFixed(2));
const hasPendingQrAddOn = (order) => (
  order?.source === 'qr-self-order'
  && Array.isArray(order.qrOrder?.pendingAddOn?.items)
  && order.qrOrder.pendingAddOn.items.length > 0
);
const pendingQrAddOnResponse = (res) => res.status(409).json({
  success: false,
  code: 'QR_ADD_ON_PENDING',
  message: 'This table has a new QR add-on awaiting approval. Approve or decline it first.',
});

const heldItemCancellationPermissionError = (cancellations) => Object.assign(
  new Error(
    'Cancel Kitchen-Sent Items permission is required to reduce or remove items already sent to the kitchen.',
  ),
  {
    statusCode: 403,
    code: 'HELD_ITEM_CANCEL_PERMISSION_REQUIRED',
    syncCode: 'HELD_ITEM_CANCEL_PERMISSION_REQUIRED',
    details: { cancellations },
  },
);

// A held order is the order's canonical record, not a disposable draft. Apply
// the final checkout values to that existing Mongoose document so its identity
// and transaction number survive payment. Because the document is not new, the
// SaleTransaction pre-save number generator will not run again.
export const reuseHeldTransactionForCheckout = (heldTransaction, checkoutData) => {
  if (!heldTransaction) return null;
  heldTransaction.$where = { ...heldTransaction.$where, ...kitchenCancellationWriteFilter(heldTransaction) };
  const originalTransactionNumber = heldTransaction.transactionNumber;
  heldTransaction.set(checkoutData);
  heldTransaction.transactionNumber = originalTransactionNumber;
  return heldTransaction;
};

// Resolve the outlet a POS user is authorized to operate. Cashiers have a fixed
// assignment; owners/managers choose an outlet when opening their current POS
// session. Client-supplied outlet identifiers are never trusted.
const resolvePosOutletId = async (user) => {
  if (user?.outletRef) return user.outletRef;
  if (user?.outletCode) {
    const outlet = await Outlet.findOne({ code: user.outletCode }).select('_id').lean();
    if (outlet?._id) return outlet._id;
  }
  const currentSession = await SaleSession.findOne({ cashier: user.id, status: 'open' })
    .select('outlet')
    .lean();
  return currentSession?.outlet ?? null;
};

const requireSamePosOutlet = async (user, transactionOutlet) => {
  const outletId = await resolvePosOutletId(user);
  return Boolean(outletId && transactionOutlet && outletId.toString() === transactionOutlet.toString());
};

/**
 * Resolve and validate each item in the sale payload.
 * Returns { enrichedItems, subtotal, totalTax, totalDiscount }.
 *
 * enrichedItem shape:
 *   { menuItem, name, qty, unitPrice, lineTotal, taxAmount, discountAmount,
 *     productCategory }
 */
const resolveItems = async (rawItems, orderType = 'dine-in') => {
  const menuItemIds = rawItems.map((i) => i.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds } })
    .populate('category', 'name')
    .populate('ingredients.product', 'name unit')
    .populate('variations.ingredients.product', 'name unit')
    .lean();

  const dealComponentMap = await loadDealComponentMap(menuItems);

  const byId = Object.fromEntries(menuItems.map((m) => [m._id.toString(), m]));

  let subtotal = 0;
  let totalTax = 0;
  let totalDiscount = 0;
  // Sum of line totals for taxable items only (taxRate > 0). Tax is charged on
  // this base at a rate that depends on the payment method (see createSale).
  let taxableSubtotal = 0;

  const enrichedItems = [];

  for (const raw of rawItems) {
    const menuItem = byId[raw.menuItemId];

    if (!menuItem) {
      throw Object.assign(
        new Error(`Menu item ${raw.menuItemId} not found.`),
        { statusCode: 422 }
      );
    }
    if (!menuItem.isAvailable) {
      throw Object.assign(
        new Error(`"${menuItem.name}" is currently unavailable.`),
        { statusCode: 422 }
      );
    }

    // When the item has sizes, the price AND the recipe come from the chosen
    // variation (validated against the live item — never trust a client price).
    // Tax/service rates stay item-level. A variation is REQUIRED for such items.
    const hasVariations = Array.isArray(menuItem.variations) && menuItem.variations.length > 0;
    let variation = null;
    if (hasVariations) {
      if (!raw.variationId) {
        throw Object.assign(
          new Error(`Please choose a size for "${menuItem.name}".`),
          { statusCode: 422 }
        );
      }
      variation = menuItem.variations.find((v) => v._id.toString() === raw.variationId.toString());
      if (!variation) {
        throw Object.assign(
          new Error(`Selected size is no longer available for "${menuItem.name}".`),
          { statusCode: 422 }
        );
      }
    }

    const resolvedDeal = resolveDeal(menuItem, raw.dealSelections, dealComponentMap);
    const unitPrice = round2(resolveMenuUnitPrice(menuItem, variation, orderType) + resolvedDeal.priceAdjustment);
    const recipeIngredients = variation ? (variation.ingredients ?? []) : (menuItem.ingredients ?? []);

    const lineTotal = round2(unitPrice * raw.qty);
    const taxable = (menuItem.taxRate || 0) > 0;
    const taxAmount = round2(lineTotal * ((menuItem.taxRate || 0) / 100));
    const discountAmount = round2(raw.discountAmount || 0);

    subtotal += lineTotal;
    totalTax += taxAmount;
    if (taxable) taxableSubtotal += lineTotal;
    totalDiscount += discountAmount;

    enrichedItems.push({
      menuItem: menuItem._id,
      categoryId: menuItem.category?._id ?? menuItem.category ?? undefined,
      categoryName: menuItem.category?.name ?? null,
      variation: variation ? { id: variation._id, name: variation.name } : undefined,
      name: menuItem.name,
      qty: raw.qty,
      listedUnitPrice: unitPrice,
      priceMode: menuItem.priceMode || 'exclusive',
      unitPrice,
      lineTotal,
      taxable,
      taxAmount,
      taxRate: menuItem.taxRate || 0,
      // Service charge is applied centrally (per-outlet rate) in the sale core,
      // not from the menu item — placeholders here, filled in below.
      serviceChargeAmount: 0,
      serviceChargeRate: 0,
      discountAmount,
      dealSelections: resolvedDeal.dealSelections,
      dealComponents: resolvedDeal.dealComponents.map((component) => ({
        source: component.source,
        groupId: component.groupId,
        groupName: component.groupName,
        optionId: component.optionId,
        menuItem: component.menuItem,
        categoryId: component.categoryId,
        categoryName: component.categoryName,
        variation: component.variation,
        name: component.name,
        qtyPerDeal: component.qtyPerDeal,
        priceAdjustment: component.priceAdjustment,
      })),
      // Retained for postSale categorisation — not stored in DB item sub-doc
      _trackInventory: menuItem.itemType === 'deal'
        ? resolvedDeal.dealComponents.some((component) => component._trackInventory)
        : menuItem.trackInventory,
      _menuItemFull: menuItem,
      // Recipe that actually applies to this line (variation's, or item's).
      _recipeIngredients: recipeIngredients,
      _dealComponents: resolvedDeal.dealComponents,
      // Menu category name feeds the food/bev revenue split in postSale.
      productCategory: menuItem.category?.name ?? null,
    });
  }

  return {
    enrichedItems,
    subtotal: round2(subtotal),
    totalTax: round2(totalTax),
    taxableSubtotal: round2(taxableSubtotal),
    totalDiscount: round2(totalDiscount),
  };
};

// Validate + normalise an optional card last-4 (exactly 4 digits, or null).
const normalizeCardLast4 = (raw) => {
  if (raw == null || raw === '') return null;
  const digits = String(raw).replace(/\D/g, '');
  return /^\d{4}$/.test(digits) ? digits : null;
};

/**
 * Build a flat list of recipe-ingredient requirements for the tracked items
 * in a sale. For each menu item with trackInventory=true we walk its
 * RecipeIngredient list and compute, for every underlying product, the
 * total quantity needed expressed in that product's stock unit (with
 * automatic unit conversion when the recipe unit differs from the stock
 * unit).
 *
 * Returns:
 *   [{ productId, productName, stockUnit, recipeUnit, recipeQty,
 *      qtyInStockUnit, menuItemNames[], converted }]
 *
 * `converted=false` means the unit conversion failed (incompatible units).
 * The caller should surface this to the UI instead of silently deducting a
 * raw number that might be in the wrong unit.
 */
const _buildRecipeDeductionPlan = async (enrichedItems) => {
  const trackedItems = enrichedItems.filter((i) => i._trackInventory);
  if (trackedItems.length === 0) return [];

  // productId → aggregated requirement across all tracked items in this sale.
  const byProduct = new Map();

  for (const item of trackedItems) {
    const recipeSources = item._dealComponents?.length
      ? item._dealComponents
          .filter((component) => component._trackInventory)
          .map((component) => ({
            qtySold: (Number(item.qty) || 0) * (Number(component.qtyPerDeal) || 1),
            ingList: component._recipeIngredients ?? component._menuItemFull?.ingredients ?? [],
            itemName: `${item.name} / ${component.name}`,
          }))
      : [{
          qtySold: Number(item.qty) || 0,
          ingList: item._recipeIngredients ?? item._menuItemFull?.ingredients ?? [],
          itemName: item.name,
        }];

    for (const { qtySold, ingList, itemName } of recipeSources) {
      for (const ing of ingList) {
      const product = ing.product;
      if (!product) continue;

      const recipeQty = Number(ing.qty) * qtySold;
      const stockUnit = product.unit || ing.unit;
      const { qty: qtyInStockUnit, converted } = convertQty(recipeQty, ing.unit, stockUnit);

      const pid = (product._id ?? product).toString();
      const entry = byProduct.get(pid) ?? {
        productId: product._id ?? product,
        productName: product.name ?? pid,
        stockUnit,
        recipeUnit: ing.unit,
        recipeQtyTotal: 0,
        qtyInStockUnit: 0,
        menuItemNames: new Set(),
        converted: true,
      };

      entry.recipeQtyTotal += recipeQty;
      entry.qtyInStockUnit += qtyInStockUnit;
      entry.menuItemNames.add(itemName);
      if (!converted) entry.converted = false;

      byProduct.set(pid, entry);
      }
    }
  }

  return [...byProduct.values()].map((e) => ({
    ...e,
    menuItemNames: [...e.menuItemNames],
  }));
};

/**
 * Records expected ingredient usage for the current day. Called on every
 * completed sale so the Insights dashboard has accurate "expected" numbers
 * derived directly from live sales (no manual data entry needed).
 */
const _recordExpectedUsage = async (deductions, outletId, tz = DEFAULT_TZ, occurredAt = new Date()) => {
  if (!deductions.length) return;

  // Bucket usage by the outlet-local calendar day (stored as the UTC instant of
  // local midnight), not the server's UTC day.
  const day = startOfLocalDayUtc(localDateStr(occurredAt, tz), tz);

  const operations = deductions.map((d) => ({
    updateOne: {
      filter: { product: d.productId, outlet: outletId, date: day },
      update: {
        $inc: { expectedUsage: d.qtyInStockUnit },
        $set: { unit: d.stockUnit },
        $setOnInsert: { actualUsage: 0, variance: 0, variancePct: 0, movingAvgVariance: 0 },
      },
      upsert: true,
    },
  }));

  try {
    await IngredientUsageLog.bulkWrite(operations, { ordered: false });
  } catch (err) {
    // This is a rebuildable dashboard projection, not the stock ledger. Keep
    // checkout behavior unchanged and surface enough metadata for reconciliation.
    logger.warn(
      `[SALE] Failed to update one or more expectedUsage projections ` +
      `(${deductions.length} ingredient(s)): ${err.message}`,
    );
  }
};

/**
 * Core sale processing — shared between processSale and syncOffline.
 *
 * @param {object} payload   - Validated sale body.
 * @param {object} context   - { cashier, session, outlet, existingTransaction? }
 * @param {string} [status]  - 'completed' (default) or 'held'.
 * @returns {SaleTransaction}
 */
const _processSaleCoreUnlocked = async (
  payload,
  {
    cashier,
    session,
    outlet,
    tenant = null,
    offlineMeta = null,
    existingTransaction = null,
  },
  status = 'completed',
) => {
  const occurredAt = offlineMeta?.queuedAt instanceof Date
    ? offlineMeta.queuedAt
    : new Date();
  const {
    items: rawItems,
    paymentMethod,
    cashTendered,
    cardAmount: rawCardAmount,
    discountAmount: orderDiscount = 0,
    discountMode = 'amount',
    discountPercent = 0,
    clientTransactionId,
    notes,
    cashierNotes,
    totalAmount: rawClientTotal,
    allowanceUserId,
    chargeToSalaryEmployeeId,
    orderType = 'dine-in',
    customerId,
    deliveryAddress,
    deliveryChargeAmount: rawDeliveryCharge = 0,
    tableNumber,
    foodPandaOrderNumber,
    foodPandaCustomerName,
    redeemPoints: rawRedeemPoints,
  } = payload;

  // A held order is a durable kitchen instruction, not a freely editable cart.
  // Protect checkout itself so a modified/stale client cannot bypass the POS
  // button and settle a smaller bill without recording cancelled saved items.
  assertKitchenCancellationVersion(existingTransaction, payload.kdsItemCancellationVersion);
  const heldItemCancellations = attachHeldItemCancellationDetails(
    findHeldItemCancellations(existingTransaction, rawItems),
    payload.heldItemCancellationDetails,
    payload.heldItemCancellationReasons,
  );
  const heldTotalBeforeCancellation = Number(existingTransaction?.totalAmount || 0);
  if (
    heldItemCancellations.some((entry) => entry.kitchenSent)
    && !canCancelKitchenSentItems(cashier)
  ) {
    throw heldItemCancellationPermissionError(heldItemCancellations);
  }
  validateHeldItemCancellations(heldItemCancellations);
  if (heldItemCancellations.length) {
    await assertPosCancellationAllowed(existingTransaction, tenant || cashier?.tenantSlug);
  }

  if (status === 'completed' && orderType === 'foodpanda' && paymentMethod !== 'foodpanda') {
    throw Object.assign(
      new Error('Foodpanda orders must be checked out using the Foodpanda payment method.'),
      { statusCode: 422 },
    );
  }

  // Business month/day boundaries (allowance period, usage-log day buckets)
  // follow the OUTLET's clock, not the server's. Stored timestamps stay UTC.
  const tz = outlet?.timezone || DEFAULT_TZ;

  // ── Resolve + validate items ──────────────────────────────────────────────
  const { enrichedItems: resolvedItems, totalDiscount: itemDiscounts } =
    await resolveItems(rawItems, orderType);

  // ── Payment-method-aware tax ──────────────────────────────────────────────
  // The eligible card/online portion of the taxable base is taxed at the shared
  // reduced rate; the rest at the standard rate. The server is authoritative —
  // the POS only mirrors this for display.
  const taxConfig = await getTaxConfig(outlet);
  const reducedFraction = reducedRateFractionFor(paymentMethod, payload, taxConfig);
  // Foodpanda menu prices are submitted without GST. Keep this authoritative
  // on the server so a stale terminal cannot accidentally add GST back.
  const foodPandaGstExempt = orderType === 'foodpanda' || paymentMethod === 'foodpanda';
  const effectiveTaxRate = foodPandaGstExempt ? 0 : resolveEffectiveTaxRate(taxConfig, reducedFraction);
  const cardLast4 = normalizeCardLast4(payload.cardLast4);

  // ── Service charge (central, per-outlet) ──────────────────────────────────
  // Service charge is the outlet's configured rate (Tax & PRA), applied to every
  // line — but only for the order types the outlet enabled. The per-item menu
  // value is not used. Each line carries the same rate so receipts/accounting
  // see consistent figures.
  const serviceChargeOn = serviceChargeAppliesTo(taxConfig, orderType);
  const serviceChargeRate = serviceChargeOn ? Number(taxConfig.serviceChargeRate || 0) : 0;
  const priced = priceLines(resolvedItems, { taxRate: effectiveTaxRate, serviceChargeRate });
  const enrichedItems = priced.items;
  const subtotal = priced.subtotal;
  const totalTax = priced.taxAmount;
  const effectiveServiceCharge = priced.serviceChargeAmount;

  enforceManualDiscountLimit({
    cashier,
    subtotal,
    itemDiscounts,
    orderDiscount,
    skip: orderType === 'foodpanda',
  });

  // Foodpanda orders are charged at the platform menu price. Neither line nor
  // order-level discounts apply, regardless of stale client payload values.
  const totalDiscount = foodPandaGstExempt
    ? 0
    : round2(itemDiscounts + (orderDiscount || 0));
  const subtotalAfterDiscount = round2(subtotal - totalDiscount);

  // ── Loyalty redemption (validates + computes redeemValue) ─────────────────
  // Redemption is treated as an additional discount on the total. The split
  // between cash and the rewards liability is handled in the journal entry.
  let loyaltyEnabled = false;
  let loyaltyConfig = null;
  let redeemPoints = 0;
  let redeemValue = 0;

  if (customerId && status === 'completed' && !foodPandaGstExempt) {
    loyaltyEnabled = await isMembershipRewardsEnabled(cashier, outlet?._id, tenant);
    if (loyaltyEnabled) {
      loyaltyConfig = await getLoyaltyConfig();
      if (rawRedeemPoints && Number(rawRedeemPoints) > 0) {
        const result = await validateRedeem({
          customerId,
          redeemPoints: Number(rawRedeemPoints),
          subtotal: subtotalAfterDiscount,
          config: loyaltyConfig,
        });
        redeemPoints = result.points;
        redeemValue = result.redeemValue;
        logger.info(
          `[SALE] redemption applied: ${redeemPoints} pts (Rs. ${redeemValue}) on bill Rs. ${subtotalAfterDiscount}`
        );
      } else {
        logger.info(`[SALE] no redemption requested (rawRedeemPoints=${rawRedeemPoints ?? 'undefined'})`);
      }
    }
  }

  // Delivery charge applies to delivery orders only; it's added on top of the
  // bill (and must be inside totalAmount so the sale journal entry balances).
  const deliveryCharge = orderType === 'delivery'
    ? round2(Math.max(0, Number(rawDeliveryCharge) || 0))
    : 0;

  const totalAmount = Math.max(0, round2(subtotal + totalTax + effectiveServiceCharge - totalDiscount - redeemValue + deliveryCharge));

  // Offline payments have already been collected. If menu prices or tax/service
  // settings differ from the terminal snapshot, never silently book a different
  // amount. Return the authoritative total so the terminal can guide a correction.
  const clientTotal = Number(rawClientTotal);
  if (
    offlineMeta
    && Number.isFinite(clientTotal)
    && Math.abs(round2(clientTotal) - totalAmount) > 0.01
  ) {
    const recordedTotal = round2(clientTotal);
    throw Object.assign(
      new Error(`Offline checkout total (${recordedTotal}) does not match server total (${totalAmount}).`),
      {
        statusCode: 422,
        syncCode: 'OFFLINE_TOTAL_MISMATCH',
        details: {
          clientTotal: recordedTotal,
          expectedTotal: totalAmount,
          shortfall: round2(Math.max(0, totalAmount - recordedTotal)),
          paymentMethod,
          cashTendered: round2(cashTendered || 0),
        },
      },
    );
  }

  // ── Inventory availability check (completed sales only) ──────────────────
  // Runs BEFORE any side effects (allowance updates, transaction creation)
  // so a stock shortage never partially mutates state. Requirements are
  // derived from each menu item's Recipe ingredients (trackInventory is
  // auto-toggled by the Recipe Editor when a recipe exists).
  let deductionPlan = [];
  if (status === 'completed') {
    deductionPlan = await _buildRecipeDeductionPlan(enrichedItems);

    const conversionFailures = deductionPlan.filter((d) => !d.converted);
    if (conversionFailures.length > 0) {
      const detail = conversionFailures
        .map((d) => `"${d.productName}" — recipe uses ${d.recipeUnit}, stock uses ${d.stockUnit}`)
        .join('\n');
      throw Object.assign(
        new Error(`Incompatible unit conversion for recipe ingredients:\n${detail}`),
        { statusCode: 422 }
      );
    }

    if (deductionPlan.length > 0) {
      const productIds = deductionPlan.map((d) =>
        d.productId instanceof mongoose.Types.ObjectId
          ? d.productId
          : new mongoose.Types.ObjectId(d.productId),
      );
      // Some historical StockItem documents have `outlet` stored as the code
      // string (e.g. "TSO-001") even though the schema declares ObjectId.
      // Mongoose cast-validates `$or` branches, so a normal find() would throw
      // CastError on the string branch. We use the raw collection to skip
      // schema casting and match both shapes.
      const stockItems = await StockItem.collection
        .find({
          product: { $in: productIds },
          $or: [{ outlet: outlet._id }, { outlet: outlet.code }],
        })
        .toArray();

      const stockByProduct = Object.fromEntries(
        stockItems.map((s) => [s.product.toString(), s.qtyOnHand])
      );

      // Stock availability is enforced at add-to-cart time on the POS via the
      // menu-availability endpoint. By the time we get here the cashier has
      // already taken the customer's payment, so a hard reject is the wrong
      // behavior — log under-stock and let the deduction step record negatives
      // for the inventory team to reconcile.
      for (const d of deductionPlan) {
        const onHand = stockByProduct[d.productId.toString()] ?? 0;
        if (onHand < d.qtyInStockUnit) {
          logger.warn(
            `[SALE] Stock shortfall at payment time for "${d.productName}": ` +
            `required ${d.qtyInStockUnit.toFixed(4)} ${d.stockUnit}, on-hand ${onHand} ${d.stockUnit}. ` +
            `Sale proceeding; stock will go negative.`
          );
        }
      }
    }
  }

  // ── Payment maths ─────────────────────────────────────────────────────────
  let cashAmount = 0;
  let cardAmount = 0;
  let onlineTransferAmount = 0;
  let changeGiven = 0;

  // Allowance tracking (filled only for paymentMethod === 'allowance')
  let allowanceWithinLimit = 0;
  let allowanceExcess = 0;
  let allowanceRecord = null;
  let chargeToSalaryEmployee = null;
  let chargeToSalaryRevenue = null;
  let employeeCreditDecision = null;

  if (paymentMethod === 'cash') {
    cashAmount = totalAmount;
    cardAmount = 0;
    changeGiven = round2((cashTendered || 0) - totalAmount);
    // Cash must cover the SERVER-computed total. Never validate against the
    // client-supplied total — a stale/understated client figure must not be
    // able to lower the acceptance floor and let an underpaid sale through.
    if (status !== 'held' && (cashTendered || 0) < round2(totalAmount) - 0.01) {
      throw Object.assign(
        new Error(`Cash tendered (${cashTendered}) is less than total (${totalAmount}).`),
        {
          statusCode: 422,
          syncCode: 'CASH_TENDERED_SHORT',
          details: {
            clientTotal: Number.isFinite(clientTotal) ? round2(clientTotal) : null,
            expectedTotal: totalAmount,
            shortfall: round2(totalAmount - (cashTendered || 0)),
            paymentMethod,
            cashTendered: round2(cashTendered || 0),
          },
        }
      );
    }
    if (status === 'held') changeGiven = 0;
    else changeGiven = Math.max(0, changeGiven);
  } else if (paymentMethod === 'card') {
    cashAmount = 0;
    cardAmount = totalAmount;
  } else if (paymentMethod === 'online-transfer') {
    cashAmount = 0;
    cardAmount = 0;
    onlineTransferAmount = totalAmount;
  } else if (paymentMethod === 'foodpanda') {
    // Food Panda orders are paid by the platform later — record as a receivable.
    // No cash changes hands now; tax is computed at the standard rate.
    cashAmount = 0;
    cardAmount = 0;
    changeGiven = 0;
  } else if (paymentMethod === 'charge-to-salary') {
    if (totalAmount < 1) {
      throw Object.assign(
        new Error('Charge-to-salary amount must be at least Rs. 1.'),
        { statusCode: 422 }
      );
    }
    if (!chargeToSalaryEmployeeId) {
      throw Object.assign(
        new Error('Select an employee for the charge-to-salary payment.'),
        { statusCode: 422 }
      );
    }
    chargeToSalaryEmployee = await Employee.findOne({
      _id: chargeToSalaryEmployeeId,
      isActive: true,
    }).select('name designation department salary salaryDate salaryCreditLimits outlet');
    if (!chargeToSalaryEmployee) {
      throw Object.assign(
        new Error('The selected employee is not active.'),
        { statusCode: 422 }
      );
    }
    chargeToSalaryRevenue = await ChartOfAccounts.findOne({
      code: '4006',
      isActive: { $ne: false },
    }).lean();
    if (!chargeToSalaryRevenue) {
      throw Object.assign(
        new Error('System account 4006 Charge to Salary is missing or inactive.'),
        { statusCode: 500 }
      );
    }
    employeeCreditDecision = await authorizeEmployeeCredit({
      employee: chargeToSalaryEmployee,
      amount: totalAmount,
      type: 'cts',
      actor: cashier,
      overrideRequested: payload.creditLimitOverride?.requested === true,
      overrideReason: payload.creditLimitOverride?.reason || '',
    });
    // No cash or bank movement. The full checkout total becomes an employee
    // receivable and is recovered later from payroll.
    cashAmount = 0;
    cardAmount = 0;
    changeGiven = 0;
  } else if (paymentMethod === 'allowance') {
    // ── Allowance payment ─────────────────────────────────────────────────
    // (Mutates StaffAllowance — captured for rollback below.)
    if (totalDiscount > 0) {
      throw Object.assign(
        new Error('Discounts are not allowed on allowance orders.'),
        { statusCode: 422 }
      );
    }
    if (!allowanceUserId) {
      throw Object.assign(
        new Error('An allowance subject is required for allowance payments.'),
        { statusCode: 422 }
      );
    }

    // `allowanceUserId` is the subject id (Employee or owner User — see type).
    const allowanceSubjectType = payload.allowanceSubjectType === 'user' ? 'user' : 'employee';
    const period = localMonth(occurredAt, tz); // YYYY-MM in the outlet's timezone

    allowanceRecord = await StaffAllowance.findOne({ user: allowanceUserId, period });

    if (!allowanceRecord) {
      // Auto-create from most-recent period record (carry forward limit + flags)
      const prev = await StaffAllowance.findOne({ user: allowanceUserId }).sort({ period: -1 });
      const monthlyLimit = prev?.monthlyLimit ?? 0;
      // An ENABLED allowance can be charged even at a zero limit (the whole amount
      // becomes excess → Staff Allowance Receivable). Only a missing or disabled
      // allowance is rejected.
      if (!prev || prev.enabled === false) {
        throw Object.assign(
          new Error('No active allowance is configured for this person.'),
          { statusCode: 422 }
        );
      }
      allowanceRecord = await StaffAllowance.create({
        user: allowanceUserId,
        subjectType: prev?.subjectType || allowanceSubjectType,
        subjectName: prev?.subjectName,
        enabled: true,
        period,
        monthlyLimit,
        usedAmount: 0,
        excessAmount: 0,
      });
    }

    // Block only a DISABLED allowance. A zero-limit (but enabled) allowance is
    // allowed — nothing is within-limit, so the full amount posts to Staff
    // Allowance Receivable (the staff member owes it).
    if (allowanceRecord.enabled === false) {
      throw Object.assign(
        new Error('Allowance is turned off for this person.'),
        { statusCode: 422 }
      );
    }

    const remaining = Math.max(0, allowanceRecord.monthlyLimit - allowanceRecord.usedAmount);
    allowanceWithinLimit = round2(Math.min(totalAmount, remaining));
    allowanceExcess = round2(totalAmount - allowanceWithinLimit);

    // No cash changes hands
    cashAmount = 0;
    cardAmount = 0;
    changeGiven = 0;
  } else if (paymentMethod === 'split-bill') {
    // ── Split the bill — N people pay independently ─────────────────────
    // Each part is a tile: cash, card, or covered (rolled into another tile).
    // cashAmount = sum of cash parts' shares
    // cardAmount = sum of card parts' shares
    // changeGiven = sum of cash parts' change
    // Total of part shares MUST equal totalAmount.
    const splitBill = payload.splitBill;
    if (!splitBill || !Array.isArray(splitBill.parts) || splitBill.parts.length < 2) {
      throw Object.assign(
        new Error('splitBill payload with at least 2 parts is required.'),
        { statusCode: 422 }
      );
    }

    let sumOfShares = 0;
    let sumCashShare = 0;
    let sumCardShare = 0;
    let sumChange = 0;

    for (let i = 0; i < splitBill.parts.length; i++) {
      const p = splitBill.parts[i];
      const share = round2(Number(p.share) || 0);
      sumOfShares = round2(sumOfShares + share);

      if (p.method === 'cash') {
        const tendered = round2(Number(p.tendered ?? share));
        if (status !== 'held' && tendered < share - 0.01) {
          throw Object.assign(
            new Error(`Person ${i + 1}: cash tendered (${tendered}) is less than their share (${share}).`),
            { statusCode: 422 }
          );
        }
        sumCashShare = round2(sumCashShare + share);
        sumChange = round2(sumChange + Math.max(0, round2(tendered - share)));
      } else if (p.method === 'card') {
        sumCardShare = round2(sumCardShare + share);
      } else if (p.method === 'covered') {
        // Covered tiles must have share 0 — their amount has been merged
        // into another tile's share by the cashier.
        if (share > 0.01) {
          throw Object.assign(
            new Error(`Person ${i + 1}: covered tile cannot carry a share (got ${share}).`),
            { statusCode: 422 }
          );
        }
      } else {
        throw Object.assign(
          new Error(`Person ${i + 1}: invalid payment method "${p.method}".`),
          { statusCode: 422 }
        );
      }
    }

    if (status !== 'held' && Math.abs(sumOfShares - totalAmount) > 0.01) {
      throw Object.assign(
        new Error(`Split parts total (${sumOfShares}) does not match order total (${totalAmount}).`),
        { statusCode: 422 }
      );
    }

    cashAmount = sumCashShare;
    cardAmount = sumCardShare;
    changeGiven = sumChange;
  } else {
    throw Object.assign(
      new Error(`Unknown paymentMethod "${paymentMethod}".`),
      { statusCode: 422 }
    );
  }

  // ── Build DB-safe items array (strip internal _* fields) ─────────────────
  // Taxable lines carry the effective (payment-method-aware) rate so the line
  // tax sums tie out to the transaction tax; exempt lines stay at 0.
  const dbItems = enrichedItems.map(({ menuItem, categoryId, categoryName, variation, name, qty, listedUnitPrice, priceMode, unitPrice, lineTotal, taxable, taxAmount, serviceChargeAmount, serviceChargeRate, discountAmount, dealSelections, dealComponents, _menuItemFull }) => ({
    menuItem, categoryId, categoryName, variation, name, qty, listedUnitPrice, priceMode, unitPrice, lineTotal,
    dealSelections, dealComponents,
    taxRate: taxable ? effectiveTaxRate : 0,
    taxAmount,
    serviceChargeAmount, serviceChargeRate,
    discountAmount: foodPandaGstExempt ? 0 : discountAmount,
    pra: {
      itemCode: String(_menuItemFull?.pra?.itemCode || menuItem || '').slice(0, 50),
      pctCode: String(_menuItemFull?.pra?.pctCode || outlet?.pra?.defaultPctCode || '').slice(0, 8),
    },
  }));

  // ── Create SaleTransaction ────────────────────────────────────────────────
  const txnData = {
    outlet: outlet._id,
    businessDate: getBusinessDate(
      occurredAt,
      tz,
      outlet?.businessDayStart || '00:00',
      outlet?.businessDayEnd || outlet?.businessDayStart || '00:00',
    ),
    session: session._id,
    cashier: cashier.id,
    items: dbItems,
    subtotal,
    taxAmount: totalTax,
    effectiveTaxRate,
    serviceChargeAmount: effectiveServiceCharge,
    deliveryChargeAmount: deliveryCharge,
    discountAmount: totalDiscount,
    discountMode: foodPandaGstExempt ? 'amount' : discountMode,
    discountPercent: !foodPandaGstExempt && discountMode === 'percent'
      ? Number(discountPercent || 0)
      : 0,
    totalAmount,
    paymentMethod,
    cashAmount,
    cardAmount,
    onlineTransferAmount,
    onlineTransferReference: paymentMethod === 'online-transfer'
      ? (payload.onlineTransferReference || '').trim()
      : null,
    cashTendered: cashTendered || 0,
    changeGiven,
    cardLast4,
    status,
    isRefund: false,
    syncedToManagement: true,
    syncedAt: new Date(),
  };
  const pendingPra = status === 'completed' ? initialPraState(outlet?.pra) : null;
  if (pendingPra) txnData.pra = pendingPra;
  if (offlineMeta) {
    txnData.createdAt = occurredAt;
    txnData.offlineSync = {
      queuedAt: occurredAt,
      originalSession: session._id,
      originalCashier: cashier.id,
      syncedAt: new Date(),
      clientTotal: Number.isFinite(clientTotal) ? round2(clientTotal) : undefined,
      amountAdjustment: payload.offlineAmountAdjustment || undefined,
    };
  }

  if (paymentMethod === 'allowance' && allowanceUserId) {
    txnData.allowanceUser = allowanceUserId;
    txnData.allowanceSubjectType = payload.allowanceSubjectType === 'user' ? 'user' : 'employee';
    txnData.allowanceSubjectName = allowanceRecord?.subjectName ?? null;
  }
  if (paymentMethod === 'charge-to-salary' && chargeToSalaryEmployee) {
    txnData.chargeToSalaryEmployee = chargeToSalaryEmployee._id;
    txnData.chargeToSalaryEmployeeName = chargeToSalaryEmployee.name;
  }
  if (paymentMethod === 'foodpanda') {
    txnData.foodPandaAmount = totalAmount;
    txnData.foodPandaReference = foodPandaOrderNumber || payload.foodPandaReference || '';
  }
  if (paymentMethod === 'split-bill' && payload.splitBill) {
    // Persist the per-person breakdown so the receipt + history pages can
    // show "who paid what". cashAmount/cardAmount/changeGiven above are the
    // aggregates — the parts give the line-by-line story.
    txnData.splitBill = {
      ways: payload.splitBill.ways,
      parts: payload.splitBill.parts.map((p) => ({
        share: round2(Number(p.share) || 0),
        method: p.method,
        tendered: p.method === 'cash' ? round2(Number(p.tendered ?? p.share)) : 0,
        change: p.method === 'cash' ? Math.max(0, round2(Number(p.tendered ?? p.share) - Number(p.share))) : 0,
        cardReference: p.cardReference || '',
        coveredBy: typeof p.coveredBy === 'number' ? p.coveredBy : null,
        note: p.note || '',
        paidAt: p.paidAt ? new Date(p.paidAt) : occurredAt,
      })),
    };
  }
  if (clientTransactionId) txnData.clientTransactionId = clientTransactionId;
  if (notes) txnData.notes = notes;
  if (cashierNotes) txnData.cashierNotes = cashierNotes;
  if (status === 'held') txnData.heldAt = occurredAt;
  // Persist the points snapshot on the sale doc for receipts and reporting.
  if (redeemPoints > 0) {
    txnData.pointsRedeemed = redeemPoints;
    txnData.pointsRedeemedValue = redeemValue;
  }

  // ── Customer & order type ─────────────────────────────────────────────────
  txnData.orderType = orderType;
  if (orderType === 'foodpanda') {
    txnData.foodPandaOrderNumber = String(foodPandaOrderNumber || '').trim();
    txnData.foodPandaCustomerName = String(foodPandaCustomerName || '').trim() || null;
  }
  if (customerId) txnData.customer = customerId;
  if (orderType === 'dine-in' && tableNumber) txnData.tableNumber = tableNumber;
  if (orderType === 'delivery' && deliveryAddress) {
    txnData.deliveryAddress = deliveryAddress;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SAGA: every side-effect below pushes a compensating undo onto rollback.
  // If anything throws between here and the final return, we run the undos
  // in reverse and re-throw — leaving the DB in its pre-sale state. This
  // gives atomicity without requiring a Mongo replica set.
  // ═══════════════════════════════════════════════════════════════════════
  const rollback = [];
  let transaction = null;

  try {
    // ── Allowance: persist updated usedAmount/excessAmount ─────────────────
    if (paymentMethod === 'allowance' && allowanceRecord) {
      const before = {
        usedAmount: allowanceRecord.usedAmount,
        excessAmount: allowanceRecord.excessAmount || 0,
      };
      allowanceRecord.usedAmount = round2(allowanceRecord.usedAmount + allowanceWithinLimit);
      allowanceRecord.excessAmount = round2((allowanceRecord.excessAmount || 0) + allowanceExcess);
      await allowanceRecord.save();
      rollback.push(async () => {
        const fresh = await StaffAllowance.findById(allowanceRecord._id);
        if (fresh) {
          fresh.usedAmount = before.usedAmount;
          fresh.excessAmount = before.excessAmount;
          await fresh.save();
        }
      });
    }

    // ── Create SaleTransaction ────────────────────────────────────────────
    // A punched order already has a durable SaleTransaction and TXN number.
    // Complete that same document so one customer order consumes one number.
    // New/direct sales still create a document and receive a number normally.
    transaction = reuseHeldTransactionForCheckout(existingTransaction, txnData);
    if (!transaction) {
      transaction = await SaleTransaction.create(txnData);
      rollback.push(async () => {
        try { await SaleTransaction.deleteOne({ _id: transaction._id }); } catch {}
      });
    }

    // 'held' / 'pending-approval' only park items — no stock or revenue.
    if (status !== 'completed') return transaction;

    // ── Recipe-driven inventory depletion ────────────────────────────────
    const outletId = outlet._id;
    const outletLabel = outlet.code || outlet.name || String(outletId);
    // Consumption always draws from the KITCHEN holding area.
    const appliedDeductions = []; // for rollback restoration
    for (const d of deductionPlan) {
      const productOid = d.productId instanceof mongoose.Types.ObjectId
        ? d.productId
        : new mongoose.Types.ObjectId(d.productId);
      const result = await StockItem.collection.findOneAndUpdate(
        { product: productOid, area: 'kitchen', $or: [{ outlet: outletId }, { outlet: outlet.code }] },
        { $inc: { qtyOnHand: -d.qtyInStockUnit } },
        { returnDocument: 'after' },
      );
      const updated = result?.value ?? result;

      if (!updated) {
        logger.warn(
          `[SALE] No kitchen StockItem for recipe ingredient "${d.productName}" (${d.productId}) ` +
          `at outlet "${outletLabel}" — stock not decremented.`
        );
      } else {
        appliedDeductions.push({ productOid, qty: d.qtyInStockUnit, unit: d.stockUnit });
        if (updated.qtyOnHand < 0) {
          logger.warn(
            `[SALE] Stock went negative for "${d.productName}" at outlet "${outletLabel}" ` +
            `(qtyOnHand: ${updated.qtyOnHand} ${d.stockUnit}). Sale allowed.`
          );
        }
      }
    }
    rollback.push(async () => {
      for (const d of appliedDeductions) {
        try {
          await StockItem.collection.findOneAndUpdate(
            { product: d.productOid, area: 'kitchen', $or: [{ outlet: outletId }, { outlet: outlet.code }] },
            { $inc: { qtyOnHand: d.qty } },
          );
        } catch {}
      }
    });

    // Ledger: one 'sale' row per ingredient actually deducted (kitchen, −qty).
    if (appliedDeductions.length) {
      const costMap = new Map();
      try {
        const costDocs = await Product.find({ _id: { $in: appliedDeductions.map((d) => d.productOid) } })
          .select('currentPrice').lean();
        costDocs.forEach((p) => costMap.set(p._id.toString(), p.currentPrice || 0));
      } catch { /* movement cost is best-effort */ }

      await recordStockMovements(appliedDeductions.map((d) => ({
        product:  d.productOid,
        outlet:   outletId,
        area:     'kitchen',
        qty:      -d.qty,
        unit:     d.unit,
        type:     'sale',
        unitCost: costMap.get(d.productOid.toString()) || 0,
        ref:      { kind: 'saleTransaction', id: transaction._id },
        user:     transaction.cashier,
        at:       occurredAt,
      })));
      rollback.push(async () => {
        try {
          await StockMovement.deleteMany({ 'ref.kind': 'saleTransaction', 'ref.id': transaction._id, type: 'sale' });
        } catch {}
      });
    }

    // Record expected ingredient usage for dashboards / Insights.
    await _recordExpectedUsage(deductionPlan, outletId, tz, occurredAt);
    rollback.push(async () => {
      const day = startOfLocalDayUtc(localDateStr(occurredAt, tz), tz);
      for (const d of deductionPlan) {
        try {
          const IngredientUsageLog = (await import('../models/IngredientUsageLog.js')).default;
          await IngredientUsageLog.findOneAndUpdate(
            { product: d.productId, outlet: outletId, date: day },
            { $inc: { expectedUsage: -d.qtyInStockUnit } },
          );
        } catch {}
      }
    });

    // ── Post sale journal entry ──────────────────────────────────────────
    let journalEntry;
    if (paymentMethod === 'allowance') {
      journalEntry = await postAllowanceSale(transaction, enrichedItems, {
        withinLimit: allowanceWithinLimit,
        excessAmount: allowanceExcess,
      });
    } else if (paymentMethod === 'charge-to-salary') {
      const ctsBusinessDate = transaction.businessDate || getBusinessDate(
        transaction.createdAt || new Date(),
        tz,
        outlet?.businessDayStart || '00:00',
        outlet?.businessDayEnd || outlet?.businessDayStart || '00:00',
      );
      const advance = await SalaryAdvance.create({
        employee: chargeToSalaryEmployee._id,
        type: 'cts',
        revenueAccount: chargeToSalaryRevenue._id,
        amount: totalAmount,
        businessDate: ctsBusinessDate,
        advanceDate: startOfLocalDayUtc(ctsBusinessDate, tz),
        transactionRef: transaction.transactionNumber,
        notes: `POS ${transaction.transactionNumber}`,
        saleTransaction: transaction._id,
        creditPolicySnapshot: employeeCreditDecision?.snapshot,
        createdBy: cashier.id,
      });
      rollback.push(async () => {
        try { await SalaryAdvance.deleteOne({ _id: advance._id }); } catch {}
      });
      journalEntry = await postChargeToSalary(
        advance,
        chargeToSalaryEmployee.name,
        chargeToSalaryRevenue._id,
        cashier.id,
      );
      advance.journalEntryId = journalEntry._id;
      await advance.save();
      transaction.salaryAdvance = advance._id;
    } else {
      journalEntry = await postSale(transaction, enrichedItems, { redemptionValue: redeemValue });
    }
    // A zero-value sale (e.g. fully comped) posts no journal entry.
    if (journalEntry) {
      transaction.journalEntryId = journalEntry._id;
      rollback.push(async () => {
        try { await reverseJournalEntry(journalEntry._id, cashier.id); } catch {}
      });
    }

    // ── Loyalty: redemption + earn ───────────────────────────────────────
    // Single rollback covers both redeem + earn — reverseSaleLoyalty walks
    // every earn/redeem row tied to this sale, so pushing it twice would
    // double-reverse balances.
    if (loyaltyEnabled && customerId) {
      let loyaltyTouched = false;

      if (redeemPoints > 0) {
        await recordRedeem({
          customerId,
          points: redeemPoints,
          redeemValue,
          transaction,
          cashier: cashier.id,
          outlet: outlet._id,
        });
        loyaltyTouched = true;
      }

      const earnPoints = computeEarnPoints({
        config: loyaltyConfig,
        paymentMethod,
        subtotal: subtotalAfterDiscount,
        taxAmount: totalTax,
      });
      if (earnPoints > 0) {
        const earnLt = await recordEarn({
          customerId,
          points: earnPoints,
          transaction,
          config: loyaltyConfig,
          cashier: cashier.id,
          outlet: outlet._id,
        });
        transaction.pointsEarned = earnPoints;
        if (earnLt?.journalEntryId) transaction.loyaltyEarnEntryId = earnLt.journalEntryId;
        loyaltyTouched = true;
      }

      if (loyaltyTouched) {
        rollback.push(async () => {
          try {
            await reverseSaleLoyalty({ sale: transaction, userId: cashier.id });
          } catch {}
        });
      }
    }

    // Final save — locks in all the references gathered along the way.
    await transaction.save();
    if (heldItemCancellations.length > 0) {
      await AuditLog.create({
        user: cashier.id,
        actorName: cashier.name,
        actorRole: cashier.role,
        action: 'held_order_items_cancelled_at_checkout',
        module: 'pos',
        recordId: transaction._id,
        before: {
          transactionNumber: transaction.transactionNumber,
          totalAmount: heldTotalBeforeCancellation,
        },
        after: {
          transactionNumber: transaction.transactionNumber,
          totalAmount: transaction.totalAmount,
          cancellations: heldItemCancellations,
          orderSnapshot: cancellationOrderSnapshot(transaction),
        },
      }).catch((error) => {
        logger.warn(`[SALE] Could not audit held-item cancellation for ${transaction.transactionNumber}: ${error.message}`);
      });
    }
    // Rider delivery metadata is a best-effort projection. Keep the entire
    // invocation inside the guard so neither synchronous setup errors nor an
    // asynchronous sync failure can turn a committed checkout into a 500.
    try {
      await syncUserRiderAssignment({
        sale: transaction,
        tenantSlug: tenant?.slug || cashier?.tenantSlug,
      });
    } catch (syncError) {
      logger.error(`[RIDER] Could not refresh assignment details for ${transaction.transactionNumber}: ${syncError.message}`);
    }

    if (employeeCreditDecision?.overrideUsed) {
      try {
        await AuditLog.create({
          user: cashier.id,
          actorName: cashier.name,
          actorRole: cashier.role,
          action: 'employee_credit_limit_overridden',
          module: 'pos',
          recordId: transaction._id,
          after: {
            employeeId: chargeToSalaryEmployee._id,
            employeeName: chargeToSalaryEmployee.name,
            type: 'cts',
            amount: totalAmount,
            overriddenLimits: employeeCreditDecision.overriddenLimits,
            reason: employeeCreditDecision.overrideReason,
            transactionNumber: transaction.transactionNumber,
          },
        });
      } catch (auditError) {
        logger.warn(`[SALE] Failed to write employee credit override audit: ${auditError.message}`);
      }
    }

    return transaction;
  } catch (err) {
    // Run compensations in reverse order. Each undo swallows its own errors
    // so a single failed undo doesn't mask the original error.
    logger.error(`[SALE] failed mid-flight — rolling back ${rollback.length} step(s): ${err.message}`);
    for (let i = rollback.length - 1; i >= 0; i--) {
      try { await rollback[i](); } catch (undoErr) {
        logger.error(`[SALE] rollback step ${i} failed: ${undoErr.message}`);
      }
    }
    throw err;
  }
};

// Every completed CTS checkout for the same employee is serialized around the
// authoritative recheck and advance creation. Two tills can therefore never
// both spend the same remaining allowance.
const _processSaleCore = async (payload, context, status = 'completed') => {
  if (
    status !== 'completed'
    || payload?.paymentMethod !== 'charge-to-salary'
    || !mongoose.isValidObjectId(payload?.chargeToSalaryEmployeeId)
  ) {
    return _processSaleCoreUnlocked(payload, context, status);
  }
  return withEmployeeCreditLock(
    payload.chargeToSalaryEmployeeId,
    () => _processSaleCoreUnlocked(payload, context, status)
  );
};

const offlineSyncLocks = new Map();

const withOfflineSyncLock = async (clientTransactionId, work) => {
  const previous = offlineSyncLocks.get(clientTransactionId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  offlineSyncLocks.set(clientTransactionId, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (offlineSyncLocks.get(clientTransactionId) === queued) {
      offlineSyncLocks.delete(clientTransactionId);
    }
  }
};

const offlineTransactionResult = (transaction) => ({
  clientTransactionId: transaction.clientTransactionId,
  transactionId: transaction._id,
  transactionNumber: transaction.transactionNumber,
  status: transaction.status,
});

const findResumableHeldTransaction = async ({ payload, outlet }) => {
  // A server-issued hold id is canonical. Never OR it with the local hold id:
  // a crafted request containing two different references could otherwise be
  // checked against one hold and later finalize/delete the other.
  if (payload?.resumedFromHoldId && mongoose.isValidObjectId(payload.resumedFromHoldId)) {
    return SaleTransaction.findOne({
      _id: payload.resumedFromHoldId,
      outlet: outlet._id,
      status: 'held',
    });
  }
  if (payload?.localHoldClientTransactionId) {
    return SaleTransaction.findOne({
      clientTransactionId: payload.localHoldClientTransactionId,
      outlet: outlet._id,
      status: 'held',
    });
  }
  return null;
};

const finalizeResumedHoldAfterSale = async ({
  resumedFromHoldId,
  outlet,
  transaction,
  tenantSlug,
}) => {
  if (!resumedFromHoldId || !mongoose.Types.ObjectId.isValid(resumedFromHoldId)) return;

  const completedInPlace = String(transaction?._id || '') === String(resumedFromHoldId);

  const heldDoc = completedInPlace
    ? transaction
    : await SaleTransaction.findOne({
      _id: resumedFromHoldId,
      outlet: outlet._id,
      status: 'held',
    }).select('source qrOrder staffOrder transactionNumber outlet kitchenPrintQueuedAt kitchenPrintedAt kitchenPrintedQtyMap assignedRider assignedRiderAt assignedRiderBy kdsOrder').lean();

  // A tablet order is first a held sale because the cashier still owns payment.
  // Legacy checkouts may still have separate held/final rows during a rolling
  // deployment. Preserve their metadata before removing that old held row.
  // New checkouts complete the held document itself, so no copy is needed.
  if (!completedInPlace && heldDoc?.source === 'staff-tablet') {
    try {
      await Promise.all([
        SaleTransaction.updateOne(
          { _id: transaction._id },
          {
            $set: {
              source: 'staff-tablet',
              staffOrder: heldDoc.staffOrder,
              kitchenPrintQueuedAt: heldDoc.kitchenPrintQueuedAt || null,
              kitchenPrintedAt: heldDoc.kitchenPrintedAt || null,
              kitchenPrintedQtyMap: heldDoc.kitchenPrintedQtyMap || {},
            },
          },
        ),
        PrintJob.updateMany(
          { order: heldDoc._id },
          { $set: { order: transaction._id } },
        ),
      ]);
    } catch (metadataError) {
      // Financial posting has already succeeded. Never turn a metadata-copy
      // issue into a retry that could make the cashier think payment failed.
      logger.error(`[SALE] Could not retain staff-tablet metadata for ${transaction._id}: ${metadataError.message}`);
    }
  }

  if (heldDoc) {
    try {
      await relinkKdsOrderToFinalSale({
        held: heldDoc,
        transaction,
        actor: { id: transaction.cashier, name: '' },
        tenantSlug,
      });
    } catch (kdsError) {
      reportKdsError(`Could not relink held order ${heldDoc._id} to paid sale ${transaction._id}`, kdsError);
    }
  }

  if (completedInPlace) {
    logger.info(`Held order completed in place: ${transaction.transactionNumber}`);
  } else {
    const removed = await SaleTransaction.deleteOne({
      _id: resumedFromHoldId,
      outlet: outlet._id,
      status: 'held',
    });
    if (!removed.deletedCount) return;

    logger.info(
      `Legacy held record removed after payment: ${resumedFromHoldId} ` +
      `(paid as ${transaction.transactionNumber})`
    );
  }

  if (heldDoc?.source !== 'qr-self-order') return;
  try {
    const { getIo } = await import('../utils/socket.js');
    const io = getIo();
    if (!io || !tenantSlug) return;

    io.to(`qr:order:${tenantSlug}:${heldDoc.transactionNumber}`).emit('qr-order:status', {
      orderNumber: heldDoc.transactionNumber,
      status: 'completed',
      settledAs: transaction.transactionNumber,
    });
    if (heldDoc.qrOrder?.tableCode) {
      io.to(`qr:table:${tenantSlug}:${String(heldDoc.outlet)}:${heldDoc.qrOrder.tableCode}`)
        .emit('qr-table:freed', { orderNumber: heldDoc.transactionNumber });
    }
    io.to(`qr:cashier:${tenantSlug}:${String(heldDoc.outlet)}`).emit('qr-order:updated', {
      orderNumber: heldDoc.transactionNumber,
      status: 'completed',
    });
  } catch (sockErr) {
    logger.warn(`[SALE] QR socket emit failed: ${sockErr.message}`);
  }
};

const removeSupersededLocalHoldAfterSale = async ({
  localHoldClientTransactionId,
  outlet,
  cashierId,
  transaction,
}) => {
  if (!localHoldClientTransactionId) return;
  const removed = await SaleTransaction.deleteOne({
    clientTransactionId: localHoldClientTransactionId,
    outlet: outlet._id,
    cashier: cashierId,
    status: 'held',
  });
  if (removed.deletedCount) {
    logger.info(
      `Offline hold ${localHoldClientTransactionId} removed after payment ` +
      `(paid as ${transaction.transactionNumber})`
    );
  }
};

export const refreshClosedSessionTotals = async (sessionId) => {
  const closedSession = await SaleSession.findOne({ _id: sessionId, status: 'closed' }).lean();
  if (!closedSession) return;

  const [transactions, returns] = await Promise.all([
    SaleTransaction.find({ session: sessionId })
    .select(
      'status isRefund paymentMethod cashAmount cardAmount onlineTransferAmount ' +
      'foodPandaAmount totalAmount pointsRedeemed pointsRedeemedValue pointsEarned storeCreditRedeemed'
    )
    .lean(),
    SaleReturn.find({ session: sessionId }).select('refundAmount refundMethod').lean(),
  ]);

  const totals = {
    cashSales: 0,
    cardSales: 0,
    onlineTransferSales: 0,
    storeCreditSales: 0,
    foodPandaSales: 0,
    allowanceSales: 0,
    allowanceOrders: 0,
    chargeToSalarySales: 0,
    chargeToSalaryOrders: 0,
    splitBillOrders: 0,
    totalSales: 0,
    totalTransactions: 0,
    totalRefunds: 0,
    netCash: 0,
    pointsRedeemed: 0,
    pointsRedeemedValue: 0,
    pointsEarned: 0,
    rewardsTransactions: 0,
    grossSales: 0,
    paidOut: closedSession.totals?.paidOut || 0,
    paidIn: closedSession.totals?.paidIn || 0,
  };

  let refundedCash = 0;
  for (const transaction of transactions) {
    if (transaction.isRefund) {
      totals.totalRefunds += transaction.totalAmount || 0;
      refundedCash += transaction.cashAmount || 0;
      continue;
    }
    if (transaction.status !== 'completed') continue;

    totals.cashSales += transaction.cashAmount || 0;
    totals.cardSales += transaction.cardAmount || 0;
    totals.onlineTransferSales += transaction.onlineTransferAmount || 0;
    totals.storeCreditSales += transaction.storeCreditRedeemed || 0;
    totals.foodPandaSales += transaction.foodPandaAmount || 0;
    totals.totalSales += transaction.totalAmount || 0;
    totals.totalTransactions += 1;
    totals.pointsRedeemed += transaction.pointsRedeemed || 0;
    totals.pointsRedeemedValue += transaction.pointsRedeemedValue || 0;
    totals.pointsEarned += transaction.pointsEarned || 0;
    if ((transaction.pointsRedeemed || 0) > 0 || (transaction.pointsEarned || 0) > 0) {
      totals.rewardsTransactions += 1;
    }
    if (transaction.paymentMethod === 'allowance') {
      totals.allowanceSales += transaction.totalAmount || 0;
      totals.allowanceOrders += 1;
    }
    if (transaction.paymentMethod === 'charge-to-salary') {
      totals.chargeToSalarySales += transaction.totalAmount || 0;
      totals.chargeToSalaryOrders += 1;
    }
    if (['split', 'split-bill'].includes(transaction.paymentMethod)) {
      totals.splitBillOrders += 1;
    }
  }

  for (const saleReturn of returns) {
    totals.totalRefunds += Number(saleReturn.refundAmount || 0);
    if (saleReturn.refundMethod === 'cash') refundedCash += Number(saleReturn.refundAmount || 0);
  }

  totals.netCash = totals.cashSales - refundedCash;
  totals.grossSales = totals.totalSales + totals.pointsRedeemedValue;
  for (const key of Object.keys(totals)) {
    if (typeof totals[key] === 'number') totals[key] = round2(totals[key]);
  }

  await SaleSession.updateOne({ _id: sessionId, status: 'closed' }, { $set: { totals } });
};

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTED CONTROLLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── processSale ────────────────────────────────────────────────────────────────
// POST /api/pos/sale
// Auth: cashier JWT

const processSaleUnlocked = async (req, res) => {
  // ── Active session check ──────────────────────────────────────────────────
  const session = await SaleSession.findOne({
    cashier: req.user.id,
    status: 'open',
  }).lean();

  if (!session) {
    return res.status(409).json({
      success: false,
      message: 'No open session found. Open a session before processing sales.',
    });
  }

  const outlet = await Outlet.findById(session.outlet).lean();
  const resumedTransaction = await findResumableHeldTransaction({
    payload: req.body,
    outlet,
  });

  // A QR add-on must be accepted into the same held transaction before the
  // table can be settled. This prevents a cashier who already resumed the
  // original cart from accidentally paying/printing a stale bill.
  if (hasPendingQrAddOn(resumedTransaction)) {
    return pendingQrAddOnResponse(res);
  }

  // ── Offline dedup check ───────────────────────────────────────────────────
  if (req.body.clientTransactionId) {
    const existing = await SaleTransaction.findOne({
      clientTransactionId: req.body.clientTransactionId,
      cashier: req.user.id,
      status: { $ne: 'held' },
    }).lean();

    if (existing) {
      await finalizeResumedHoldAfterSale({
        resumedFromHoldId: req.body.resumedFromHoldId,
        outlet,
        transaction: existing,
        tenantSlug: req.user?.tenantSlug,
      });
      await removeSupersededLocalHoldAfterSale({
        localHoldClientTransactionId: req.body.localHoldClientTransactionId,
        outlet,
        cashierId: req.user.id,
        transaction: existing,
      });
      return res.json({
        success: true,
        message: 'Duplicate clientTransactionId — returning existing record.',
        transaction: existing,
      });
    }
  }

  // A server-issued held id must still resolve to that held order. Silently
  // creating a new completed transaction here would consume another TXN and
  // could charge the same order twice after a stale/double checkout request.
  if (req.body.resumedFromHoldId && !resumedTransaction) {
    return res.status(409).json({
      success: false,
      code: 'HELD_ORDER_NOT_AVAILABLE',
      message: 'This held order is no longer available for checkout. Refresh the held-order list.',
    });
  }

  const transaction = await _processSaleCore(
    req.body,
    {
      cashier: req.user,
      session,
      outlet,
      tenant: req.tenant,
      existingTransaction: resumedTransaction,
    },
    'completed'
  );

  // PRA's returned fiscal number and verification QR belong on the customer's
  // first receipt. Attempt the bounded cloud call before responding; checkout
  // remains successful if PRA is unavailable and the durable retry path takes
  // over from the persisted pending state.
  if (transaction.pra?.status === 'pending') {
    await submitSaleToPra(transaction);
  }

  let praOutboxEvent = null;
  if (env.PRA_QUEUE_ENABLED && transaction.pra?.status === 'pending') {
    try {
      praOutboxEvent = await ensurePraOutboxEvent(transaction._id, 'sale');
    } catch (err) {
      // The sale itself carries durable pra.status=pending, so the retry sweep
      // remains a recovery path even when creating the accelerator event fails.
      logger.error(`[PRA] could not create outbox event for ${transaction._id}: ${err.message}`);
    }
  }

  await finalizeResumedHoldAfterSale({
    resumedFromHoldId: req.body.resumedFromHoldId,
    outlet,
    transaction,
    tenantSlug: req.user?.tenantSlug,
  });
  await removeSupersededLocalHoldAfterSale({
    localHoldClientTransactionId: req.body.localHoldClientTransactionId,
    outlet,
    cashierId: req.user.id,
    transaction,
  });

  logger.info(
    `POS sale: ${transaction.transactionNumber} | ` +
    `outlet=${outlet.code} | total=${transaction.totalAmount} | by ${req.user.email}`
  );

  // If a customer was attached, fetch their post-sale points balance for the receipt.
  let pointsBalanceAfter = null;
  if (transaction.customer) {
    const Customer = (await import('../models/Customer.js')).default;
    const c = await Customer.findById(transaction.customer).select('pointsBalance').lean();
    pointsBalanceAfter = c?.pointsBalance ?? null;
  }

  const receiptData = {
    transactionNumber: transaction.transactionNumber,
    sessionNumber: session.sessionNumber,
    outletName: outlet.name,
    praInvoiceNumber: transaction.pra?.invoiceNumber || null,
    praStatus: transaction.pra?.status || null,
    timezone: outlet.timezone || null,
    cashierName: req.user.name,
    items: transaction.items,
    subtotal: transaction.subtotal,
    taxAmount: transaction.taxAmount,
    effectiveTaxRate: transaction.effectiveTaxRate,
    discountAmount: transaction.discountAmount,
    discountMode: transaction.discountMode,
    discountPercent: transaction.discountPercent,
    totalAmount: transaction.totalAmount,
    paymentMethod: transaction.paymentMethod,
    cardLast4: transaction.cardLast4 || null,
    onlineTransferAmount: transaction.onlineTransferAmount || 0,
    onlineTransferReference: transaction.onlineTransferReference || null,
    chargeToSalaryEmployee: transaction.chargeToSalaryEmployeeName
      ? { _id: transaction.chargeToSalaryEmployee, name: transaction.chargeToSalaryEmployeeName }
      : null,
    cashTendered: transaction.cashTendered,
    changeGiven: transaction.changeGiven,
    pointsEarned: transaction.pointsEarned || 0,
    pointsRedeemed: transaction.pointsRedeemed || 0,
    pointsRedeemedValue: transaction.pointsRedeemedValue || 0,
    pointsBalanceAfter,
    splitBill: transaction.splitBill || null,
    serviceChargeAmount: transaction.serviceChargeAmount || 0,
    deliveryChargeAmount: transaction.deliveryChargeAmount || 0,
    orderType: transaction.orderType,
    tableNumber: transaction.tableNumber || '',
    deliveryAddress: transaction.deliveryAddress || null,
    foodPandaOrderNumber: transaction.foodPandaOrderNumber || null,
    foodPandaCustomerName: transaction.foodPandaCustomerName || null,
    foodPandaReference: transaction.foodPandaReference || null,
    timestamp: transaction.createdAt,
  };

  res.status(201).json({ success: true, transaction, receiptData });

  if (praOutboxEvent) {
    publishPraOutboxEventById(req.user.tenantSlug, praOutboxEvent._id)
      .catch((e) => logger.error(`[PRA] queue publish error: ${e?.message}`));
  }
  return;
};

export const processSale = async (req, res) => {
  const heldId = req.body.resumedFromHoldId;
  if (!heldId || !mongoose.isValidObjectId(heldId)) {
    return processSaleUnlocked(req, res);
  }

  const held = await SaleTransaction.findById(heldId)
    .select('source outlet qrOrder.tableCode')
    .lean();
  if (held?.source !== 'qr-self-order' || !held.qrOrder?.tableCode) {
    return processSaleUnlocked(req, res);
  }

  const table = await Table.findOne({ outlet: held.outlet, code: held.qrOrder.tableCode })
    .select('_id')
    .lean();
  if (!table) return processSaleUnlocked(req, res);

  return withQrTableLock(table._id, () => processSaleUnlocked(req, res));
};

// GET /api/pos/deliveries/riders — tracked rider accounts plus active outlet employees.
export const getDeliveryRiders = async (req, res) => {
  const outletId = await resolvePosOutletId(req.user);
  if (!outletId) return res.status(422).json({ success: false, message: 'Open a POS session or assign an outlet first.' });
  const riderTrackingEnabled = isFeatureEnabledForOutlet(req.tenant, 'riderTracking', outletId);
  if (riderTrackingEnabled) {
    if (!req.user.hasPermission?.('riderTracking.assign')) {
      return res.status(403).json({ success: false, message: 'You do not have permission to assign tracked riders.' });
    }
    const [riders, outlet, employees] = await Promise.all([
      User.find({ outletRef: outletId, role: 'rider', isActive: true })
        .select('name email role outlet outletRef')
        .sort({ name: 1 })
        .lean(),
      Outlet.findById(outletId).select('riderTracking').lean(),
      Employee.find({ outlet: outletId, isActive: true })
        .select('name phone designation department')
        .sort({ name: 1 })
        .lean(),
    ]);
    const riderIds = riders.map((rider) => rider._id);
    const [shifts, assignments, devices] = await Promise.all([
      RiderShift.find({ rider: { $in: riderIds }, status: 'active' }).select('rider lastLocation lastLocationReceivedAt inOutletGeofence').lean(),
      DeliveryAssignment.find({ rider: { $in: riderIds }, active: true })
        .select('rider saleTransaction orderNumber status assignedAt deliveryRunId pickupState routeSequence')
        .lean(),
      RiderDevice.find({ rider: { $in: riderIds }, isActive: true }).sort({ lastSeenAt: -1 }).lean(),
    ]);
    const shiftMap = new Map(shifts.map((shift) => [String(shift.rider), shift]));
    const assignmentsByRider = new Map();
    for (const assignment of assignments) {
      const riderId = String(assignment.rider);
      if (!assignmentsByRider.has(riderId)) assignmentsByRider.set(riderId, []);
      assignmentsByRider.get(riderId).push(assignment);
    }
    const deviceMap = new Map();
    for (const device of devices) if (!deviceMap.has(String(device.rider))) deviceMap.set(String(device.rider), device);
    const outletCoordinates = coordinatesFromGeoPoint(outlet?.riderTracking?.location);
    const staleAfterSeconds = Number(outlet?.riderTracking?.staleAfterSeconds || 120);
    return res.json({
      success: true,
      mode: 'riderTracking',
      data: [...riders.map((rider) => {
        const shift = shiftMap.get(String(rider._id));
        const activeAssignments = (assignmentsByRider.get(String(rider._id)) || [])
          .sort((a, b) => new Date(b.assignedAt || 0) - new Date(a.assignedAt || 0));
        const assignment = activeAssignments[0] || null;
        const device = deviceMap.get(String(rider._id));
        const riderCoordinates = coordinatesFromGeoPoint(shift?.lastLocation?.location);
        const health = riderTrackingHealth({ shift, device, staleAfterSeconds });
        return {
          ...rider,
          assignmentType: 'user',
          appTracking: true,
          onDuty: Boolean(shift),
          available: Boolean(shift && health.trackingOnline && health.locationUsable && riderCoordinates),
          currentAssignment: assignment || null,
          activeAssignments,
          activeAssignmentCount: activeAssignments.length,
          lastLocation: shift?.lastLocation || null,
          ...health,
          distanceFromOutletMeters: outletCoordinates && riderCoordinates
            ? metersBetween(outletCoordinates, riderCoordinates)
            : null,
          inOutletGeofence: shift?.inOutletGeofence ?? null,
        };
      }), ...employees.map((employee) => ({
        ...employee,
        assignmentType: 'employee',
        appTracking: false,
        available: true,
      }))],
    });
  }
  const employees = await Employee.find({ outlet: outletId, isActive: true })
    .select('name phone designation department')
    .sort({ name: 1 })
    .lean();
  return res.json({
    success: true,
    data: employees.map((employee) => ({ ...employee, assignmentType: 'employee', appTracking: false })),
  });
};

// GET /api/pos/charge-to-salary/employees?q=
// Cashier-safe employee picker: active staff in the current tenant, matching
// the existing Allowance picker.
// It intentionally does not expose salary amounts, CNICs, or face data.
export const getChargeToSalaryEmployees = async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = { isActive: true };
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { designation: { $regex: safe, $options: 'i' } },
      { department: { $regex: safe, $options: 'i' } },
    ];
  }
  const employees = await Employee.find(filter)
    .select('name designation department salaryCreditLimits')
    .sort({ name: 1 })
    .limit(30)
    .lean();
  return res.json({
    success: true,
    data: employees.map((employee) => ({
      _id: employee._id,
      name: employee.name,
      designation: employee.designation,
      department: employee.department,
      chargeToSalaryEnabled: normalizedEmployeeCreditLimits(employee).chargeToSalaryEnabled,
      cashAdvanceEnabled: normalizedEmployeeCreditLimits(employee).cashAdvanceEnabled,
    })),
  });
};

// GET /api/pos/charge-to-salary/employees/:employeeId/credit-summary
// Returns limit amounts and usage, but never exposes the employee's salary.
export const getChargeToSalaryEmployeeCreditSummary = async (req, res) => {
  const employee = await Employee.findOne({
    _id: req.params.employeeId,
    isActive: true,
  });
  if (!employee) {
    return res.status(404).json({ success: false, message: 'Active employee not found.' });
  }
  const summary = await getEmployeeCreditSummary(employee);
  return res.json({
    success: true,
    data: {
      ...summary,
      canOverride: req.user.role === 'owner'
        || req.user.hasPermission?.('salaries.overrideCreditLimits') === true,
    },
  });
};

// PATCH /api/pos/deliveries/:id/rider — assign an outlet employee to an active delivery.
export const assignDeliveryRider = async (req, res) => {
  const { id } = req.params;
  const requestedRiderId = req.body?.riderId || req.body?.employeeId;
  const requestedRiderType = req.body?.riderType === 'employee' ? 'employee' : 'user';
  if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(requestedRiderId)) {
    return res.status(400).json({ success: false, message: 'A valid delivery and rider are required.' });
  }
  const outletId = await resolvePosOutletId(req.user);
  if (!outletId) return res.status(422).json({ success: false, message: 'Open a POS session or assign an outlet first.' });

  const riderTrackingEnabled = isFeatureEnabledForOutlet(req.tenant, 'riderTracking', outletId);
  if (riderTrackingEnabled && !req.user.hasPermission?.('riderTracking.assign')) {
    return res.status(403).json({ success: false, message: 'You do not have permission to assign riders.' });
  }
  if (riderTrackingEnabled && requestedRiderType === 'user') {
    const [order, rider] = await Promise.all([
      SaleTransaction.findOne({ _id: id, outlet: outletId, orderType: 'delivery', status: 'held' }),
      User.findOne({ _id: requestedRiderId, outletRef: outletId, role: 'rider', isActive: true })
        .select('name email role outlet outletRef'),
    ]);
    if (!order) return res.status(404).json({ success: false, message: 'Active delivery order not found for this outlet.' });
    if (!rider) return res.status(404).json({ success: false, message: 'Active rider account not found for this outlet.' });
    const [shift, outlet, device] = await Promise.all([
      RiderShift.findOne({ rider: rider._id, status: 'active' }).select('_id lastLocation lastLocationReceivedAt').lean(),
      Outlet.findById(outletId).select('riderTracking.staleAfterSeconds').lean(),
      RiderDevice.findOne({ rider: rider._id, isActive: true }).sort({ lastSeenAt: -1 }).lean(),
    ]);
    if (!shift) return res.status(409).json({ success: false, code: 'RIDER_OFF_DUTY', message: `${rider.name} is not currently on duty.` });
    const health = riderTrackingHealth({ shift, device, staleAfterSeconds: outlet?.riderTracking?.staleAfterSeconds });
    if (!health.trackingOnline || !shift.lastLocation?.location) {
      return res.status(409).json({ success: false, code: 'RIDER_TRACKING_OFFLINE', message: `${rider.name}'s tracking service is offline. Ask the rider to open Cenciss Delivery and repair tracking.` });
    }
    if (!health.locationUsable) {
      return res.status(409).json({ success: false, code: 'RIDER_LOCATION_DELAYED', message: `${rider.name}'s latest GPS position is too old for nearest-rider assignment. Ask the rider to open Cenciss Delivery and repair tracking.` });
    }
    try {
      await assignUserRider({ sale: order, rider, actor: req.user, tenantSlug: req.tenantSlug });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({ success: false, code: 'ORDER_ALREADY_ASSIGNED', message: 'This delivery was assigned by another cashier. Refresh Rider Dispatch.' });
      }
      throw error;
    }
    const populated = await SaleTransaction.findById(order._id)
      .populate('cashier', 'name email')
      .populate('customer', 'name phone email')
      .populate('assignedRiderUser', 'name email role')
      .lean();
    logger.info(`Rider user ${rider.name} assigned to delivery ${order.transactionNumber} by ${req.user.email}`);
    return res.json({ success: true, mode: 'riderTracking', data: populated });
  }

  const [order, employee] = await Promise.all([
    SaleTransaction.findOne({
      _id: id,
      outlet: outletId,
      orderType: 'delivery',
      status: 'held',
    }),
    Employee.findOne({ _id: requestedRiderId, outlet: outletId, isActive: true }).select('name phone designation'),
  ]);
  if (!order) return res.status(404).json({ success: false, message: 'Active delivery order not found for this outlet.' });
  if (!employee) return res.status(404).json({ success: false, message: 'Active employee not found for this outlet.' });

  if (riderTrackingEnabled) {
    await cancelUserRiderAssignment({
      saleId: order._id,
      actor: req.user,
      tenantSlug: req.tenantSlug,
      reason: `Reassigned to employee ${employee.name}`,
      status: 'reassigned',
    });
  }
  order.assignedRider = employee._id;
  order.assignedRiderUser = null;
  order.riderDeliveryStatus = undefined;
  order.assignedRiderAt = new Date();
  order.assignedRiderBy = req.user.id;
  await order.save();
  try {
    await syncKdsRiderAssignment({
      sale: order,
      employee,
      actor: req.user,
      tenantSlug: req.user?.tenantSlug,
    });
  } catch (kdsError) {
    reportKdsError(`Could not record rider assignment for ${order.transactionNumber}`, kdsError);
  }
  const populated = await SaleTransaction.findById(order._id)
    .populate('cashier', 'name email')
    .populate('customer', 'name phone email')
    .populate('assignedRider', 'name phone designation')
    .populate('assignedRiderUser', 'name email role')
    .lean();
  logger.info(`Rider ${employee.name} assigned to delivery ${order.transactionNumber} by ${req.user.email}`);
  return res.json({ success: true, mode: riderTrackingEnabled ? 'employee' : undefined, data: populated });
};

// ── holdOrder ─────────────────────────────────────────────────────────────────
// POST /api/pos/sale/:id/hold  (id param unused in v1 — hold creates a new record)
// Auth: cashier JWT

export const holdOrder = async (req, res) => {
  if (req.body.clientTransactionId) {
    const existing = await SaleTransaction.findOne({
      clientTransactionId: req.body.clientTransactionId,
      cashier: req.user.id,
    }).lean();
    if (existing) {
      return res.json({ success: true, duplicate: true, data: existing });
    }
  }

  const isOfflineHold = Boolean(req.body.queuedAt);
  if (
    isOfflineHold
    && (
      !req.body.clientTransactionId
      || !req.body.sessionId
      || !req.body.cashierId
      || String(req.body.cashierId) !== String(req.user.id)
    )
  ) {
    return res.status(422).json({
      success: false,
      message: 'Offline holds require their original transaction, cashier, and session identifiers.',
    });
  }

  const session = isOfflineHold
    ? await SaleSession.findOne({ _id: req.body.sessionId, cashier: req.user.id }).lean()
    : await SaleSession.findOne({ cashier: req.user.id, status: 'open' }).lean();

  if (!session) {
    return res.status(409).json({
      success: false,
      message: isOfflineHold
        ? 'The original session for this offline hold was not found.'
        : 'No open session. Open a session first.',
    });
  }

  const outlet = await Outlet.findById(session.outlet).lean();
  if (!outlet) {
    return res.status(422).json({ success: false, message: 'The original outlet was not found.' });
  }
  if (isOfflineHold && req.body.outletCode && req.body.outletCode !== outlet.code) {
    return res.status(422).json({
      success: false,
      message: 'The offline hold outlet does not match its original session.',
    });
  }
  const occurredAt = isOfflineHold ? new Date(req.body.queuedAt) : new Date();

  // Resolve items and compute totals (no payment fields needed for holds)
  const { enrichedItems: resolvedHeldItems, totalDiscount } = await resolveItems(
    req.body.items,
    req.body.orderType || 'dine-in',
  );
  // Service charge mirrors the paid-sale path: the outlet's central rate applied
  // to every line, only for the enabled order types.
  const heldTaxConfig = await getTaxConfig(outlet?._id);

  // Payment-method-aware tax. MenuItem.taxRate is only a "taxable" flag — the real
  // percentage comes from the outlet/global tax config — so resolveItems' raw
  // per-item taxRate/taxAmount must be overridden here, exactly as _processSaleCore
  // does. A held order has no payment method yet, so use a reduced fraction of 0 (the
  // whole taxable base at the standard rate); the effective rate is re-applied when
  // the order is resumed and actually paid.
  const isFoodPandaHold = req.body.orderType === 'foodpanda';
  const heldEffectiveTaxRate = isFoodPandaHold ? 0 : resolveEffectiveTaxRate(heldTaxConfig, 0);

  const heldServiceChargeOn = serviceChargeAppliesTo(heldTaxConfig, req.body.orderType || 'dine-in');
  const heldServiceChargeRate = heldServiceChargeOn ? Number(heldTaxConfig.serviceChargeRate || 0) : 0;
  const pricedHeld = priceLines(resolvedHeldItems, {
    taxRate: heldEffectiveTaxRate,
    serviceChargeRate: heldServiceChargeRate,
  });
  const enrichedItems = pricedHeld.items;
  const subtotal = pricedHeld.subtotal;
  const totalTaxHeld = pricedHeld.taxAmount;
  const totalServiceChargeHeld = pricedHeld.serviceChargeAmount;
  const orderDiscount = round2(req.body.discountAmount || 0);
  enforceManualDiscountLimit({
    cashier: req.user,
    subtotal,
    itemDiscounts: totalDiscount,
    orderDiscount,
    skip: isFoodPandaHold,
  });
  const totalDiscount2 = isFoodPandaHold ? 0 : round2(totalDiscount + orderDiscount);
  const heldDeliveryCharge = (req.body.orderType || 'dine-in') === 'delivery'
    ? round2(Math.max(0, Number(req.body.deliveryChargeAmount) || 0))
    : 0;
  const totalAmount = round2(subtotal + totalTaxHeld + totalServiceChargeHeld - totalDiscount2 + heldDeliveryCharge);

  const dbItems = enrichedItems.map(({ menuItem, categoryId, categoryName, variation, name, qty, listedUnitPrice, priceMode, unitPrice, lineTotal, taxAmount, taxRate, serviceChargeAmount, serviceChargeRate, discountAmount, dealSelections, dealComponents, _menuItemFull }) => ({
    menuItem, categoryId, categoryName, variation, name, qty, listedUnitPrice, priceMode, unitPrice, lineTotal, taxAmount, taxRate, serviceChargeAmount, serviceChargeRate,
    dealSelections, dealComponents,
    discountAmount: isFoodPandaHold ? 0 : discountAmount,
    pra: {
      itemCode: String(_menuItemFull?.pra?.itemCode || menuItem || '').slice(0, 50),
      pctCode: String(_menuItemFull?.pra?.pctCode || outlet?.pra?.defaultPctCode || '').slice(0, 8),
    },
  }));

  const txnData = {
    outlet: outlet._id,
    businessDate: getBusinessDate(
      occurredAt,
      outlet?.timezone || DEFAULT_TZ,
      outlet?.businessDayStart || '00:00',
      outlet?.businessDayEnd || outlet?.businessDayStart || '00:00',
    ),
    session: session._id,
    cashier: req.user.id,
    items: dbItems,
    subtotal,
    taxAmount: totalTaxHeld,
    effectiveTaxRate: heldEffectiveTaxRate,
    serviceChargeAmount: totalServiceChargeHeld,
    deliveryChargeAmount: heldDeliveryCharge,
    discountAmount: totalDiscount2,
    discountMode: isFoodPandaHold ? 'amount' : (req.body.discountMode || 'amount'),
    discountPercent: isFoodPandaHold ? 0 : (req.body.discountPercent || 0),
    totalAmount,
    paymentMethod: 'cash', // placeholder — not used for held orders
    cashAmount: 0,
    cardAmount: 0,
    status: 'held',
    heldAt: occurredAt,
    syncedToManagement: false,
    isRefund: false,
  };
  if (isOfflineHold) {
    txnData.createdAt = occurredAt;
    txnData.offlineSync = {
      queuedAt: occurredAt,
      originalSession: session._id,
      originalCashier: req.user.id,
      syncedAt: new Date(),
    };
    const offlinePrintedBaseline = normalizePrintedQuantityMap(
      dbItems,
      req.body.kitchenPrintedQtyMap,
    );
    const hasConfirmedOfflinePrint = Boolean(req.body.kitchenPrintedAt)
      && Object.values(offlinePrintedBaseline).some((value) => Number(value) > 0);
    if (hasConfirmedOfflinePrint) {
      const requestedPrintedAt = new Date(req.body.kitchenPrintedAt || occurredAt);
      txnData.kitchenPrintedAt = Number.isNaN(requestedPrintedAt.getTime())
        ? occurredAt
        : new Date(Math.min(requestedPrintedAt.getTime(), Date.now()));
      txnData.kitchenPrintedQtyMap = offlinePrintedBaseline;
    }
  }

  if (req.body.clientTransactionId) txnData.clientTransactionId = req.body.clientTransactionId;
  if (req.body.notes) txnData.notes = req.body.notes;
  if (req.body.cashierNotes) txnData.cashierNotes = req.body.cashierNotes;
  if (req.body.orderType) txnData.orderType = req.body.orderType;
  if (req.body.orderType === 'foodpanda') {
    txnData.foodPandaOrderNumber = req.body.foodPandaOrderNumber;
    txnData.foodPandaCustomerName = String(req.body.foodPandaCustomerName || '').trim() || null;
  }
  if (req.body.customerId) txnData.customer = req.body.customerId;
  // Stash the cashier's redemption intent on the held doc so resume can
  // rehydrate it. We do NOT touch the customer's points balance here —
  // redemption only commits when the resumed sale is actually paid.
  if (!isFoodPandaHold && req.body.customerId && req.body.redeemPoints > 0) {
    txnData.pointsRedeemed = req.body.redeemPoints;
  }
  if (req.body.orderType === 'dine-in' && req.body.tableNumber) {
    txnData.tableNumber = req.body.tableNumber;
  }
  if (req.body.orderType === 'delivery' && req.body.deliveryAddress) {
    txnData.deliveryAddress = req.body.deliveryAddress;
  }

  let held;
  try {
    held = await SaleTransaction.create(txnData);
  } catch (err) {
    if (err?.code !== 11000 || !req.body.clientTransactionId) throw err;
    held = await SaleTransaction.findOne({
      clientTransactionId: req.body.clientTransactionId,
      cashier: req.user.id,
    });
    if (!held) throw err;
    return res.json({ success: true, duplicate: true, data: held });
  }

  logger.info(`Order held: ${held.transactionNumber} by ${req.user.email}`);

  return res.status(201).json({ success: true, data: held });
};

// PATCH /api/pos/held-orders/:id — replace a resumed hold with the current cart.
// Prices/rates are always recalculated from authoritative menu + outlet config.
export const updateHeldOrder = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid held order ID.' });
  }
  const held = await SaleTransaction.findById(req.params.id);
  if (!held) return res.status(404).json({ success: false, message: 'Held order not found.' });
  if (held.status !== 'held') return res.status(409).json({ success: false, message: 'Transaction is no longer held.' });
  if (!(await requireSamePosOutlet(req.user, held.outlet))) {
    return res.status(403).json({ success: false, message: 'This held order belongs to another outlet.' });
  }
  if (hasPendingQrAddOn(held)) return pendingQrAddOnResponse(res);

  assertKitchenCancellationVersion(held, req.body.kdsItemCancellationVersion);
  held.$where = { ...held.$where, ...kitchenCancellationWriteFilter(held) };
  const heldItemCancellations = attachHeldItemCancellationDetails(
    findHeldItemCancellations(held, req.body.items),
    req.body.heldItemCancellationDetails,
    req.body.heldItemCancellationReasons,
  );
  if (
    heldItemCancellations.some((entry) => entry.kitchenSent)
    && !canCancelKitchenSentItems(req.user)
  ) {
    return res.status(403).json({
      success: false,
      code: 'HELD_ITEM_CANCEL_PERMISSION_REQUIRED',
      message: 'Cancel Kitchen-Sent Items permission is required to reduce or remove items already sent to the kitchen.',
      details: { cancellations: heldItemCancellations },
    });
  }
  validateHeldItemCancellations(heldItemCancellations);
  if (heldItemCancellations.length) {
    await assertPosCancellationAllowed(held, req.tenant || req.user?.tenantSlug);
  }
  const totalBeforeCancellation = Number(held.totalAmount || 0);

  const orderType = req.body.orderType || 'dine-in';
  // Materialize the old baseline before replacing the lines. Legacy orders can
  // have only a print/queue timestamp; for those, all currently stored lines
  // are the baseline. Normalizing again after replacement drops removed keys
  // and clamps reduced quantities without marking additions as printed.
  const printedBaselineBeforeUpdate = normalizePrintedQuantityMap(
    held.items,
    held.kitchenPrintedQtyMap,
    { assumeAllPrinted: Boolean(held.kitchenPrintedAt || held.kitchenPrintQueuedAt) },
  );
  const { enrichedItems: resolvedHeldItems, totalDiscount } = await resolveItems(req.body.items, orderType);
  const cfg = await getTaxConfig(held.outlet);
  const effectiveRate = orderType === 'foodpanda' ? 0 : resolveEffectiveTaxRate(cfg, 0);
  const serviceRate = serviceChargeAppliesTo(cfg, orderType) ? Number(cfg.serviceChargeRate || 0) : 0;
  const pricedHeld = priceLines(resolvedHeldItems, { taxRate: effectiveRate, serviceChargeRate: serviceRate });
  const subtotal = pricedHeld.subtotal;
  const taxAmount = pricedHeld.taxAmount;
  const serviceChargeAmount = pricedHeld.serviceChargeAmount;
  const items = pricedHeld.items.map((it) => ({
      menuItem: it.menuItem, categoryId: it.categoryId, categoryName: it.categoryName,
      variation: it.variation, name: it.name, qty: it.qty, listedUnitPrice: it.listedUnitPrice,
      dealSelections: it.dealSelections, dealComponents: it.dealComponents,
      priceMode: it.priceMode, unitPrice: it.unitPrice,
      lineTotal: it.lineTotal, taxRate: it.taxable ? effectiveRate : 0,
      taxAmount: it.taxAmount,
      serviceChargeRate: serviceRate, serviceChargeAmount: it.serviceChargeAmount,
      discountAmount: orderType === 'foodpanda' ? 0 : it.discountAmount,
    }));
  const discountAmount = orderType === 'foodpanda'
    ? 0
    : round2(totalDiscount + Number(req.body.discountAmount || 0));
  enforceManualDiscountLimit({
    cashier: req.user,
    subtotal,
    itemDiscounts: totalDiscount,
    orderDiscount: Number(req.body.discountAmount || 0),
    skip: orderType === 'foodpanda',
  });
  const deliveryChargeAmount = orderType === 'delivery' ? round2(Number(req.body.deliveryChargeAmount || 0)) : 0;

  held.items = items;
  held.subtotal = subtotal;
  held.taxAmount = taxAmount;
  held.effectiveTaxRate = effectiveRate;
  held.serviceChargeAmount = serviceChargeAmount;
  held.deliveryChargeAmount = deliveryChargeAmount;
  held.discountAmount = discountAmount;
  held.discountMode = orderType === 'foodpanda' ? 'amount' : (req.body.discountMode || 'amount');
  held.discountPercent = orderType === 'foodpanda' ? 0 : Number(req.body.discountPercent || 0);
  held.totalAmount = round2(subtotal + taxAmount + serviceChargeAmount + deliveryChargeAmount - discountAmount);
  held.notes = req.body.notes || '';
  held.cashierNotes = req.body.cashierNotes || '';
  held.orderType = orderType;
  held.foodPandaOrderNumber = orderType === 'foodpanda' ? req.body.foodPandaOrderNumber : null;
  held.foodPandaCustomerName = orderType === 'foodpanda'
    ? (String(req.body.foodPandaCustomerName || '').trim() || null)
    : null;
  held.customer = req.body.customerId || null;
  held.pointsRedeemed = orderType !== 'foodpanda' && req.body.customerId
    ? Number(req.body.redeemPoints || 0)
    : 0;
  held.tableNumber = orderType === 'dine-in' ? (req.body.tableNumber || null) : null;
  held.deliveryAddress = orderType === 'delivery' ? (req.body.deliveryAddress || null) : null;
  held.kitchenPrintedQtyMap = normalizePrintedQuantityMap(items, printedBaselineBeforeUpdate);
  await held.save();
  if (heldItemCancellations.length > 0) {
    await AuditLog.create({
      user: req.user.id,
      actorName: req.user.name,
      actorRole: req.user.role,
      action: 'held_order_items_cancelled',
      module: 'pos',
      recordId: held._id,
      before: {
        transactionNumber: held.transactionNumber,
        totalAmount: totalBeforeCancellation,
      },
      after: {
        transactionNumber: held.transactionNumber,
        totalAmount: held.totalAmount,
        cancellations: heldItemCancellations,
        orderSnapshot: cancellationOrderSnapshot(held),
      },
      ip: req.ip,
    }).catch((error) => {
      logger.warn(`[SALE] Could not audit held-item cancellation for ${held.transactionNumber}: ${error.message}`);
    });
  }
  await syncUserRiderAssignment({ sale: held, tenantSlug: req.tenantSlug });

  logger.info(`Held order updated: ${held.transactionNumber} by ${req.user.email}`);
  return res.json({ success: true, data: {
    ...held.toObject(),
    kds: await getSaleKdsCancellationState(held, req.tenant || req.user?.tenantSlug),
  } });
};

// ── resumeHeldOrder ────────────────────────────────────────────────────────────
// POST /api/pos/held-orders/:id/resume
// ── markHeldOrderPrinted ──────────────────────────────────────────────────────
// PATCH /api/pos/held-orders/:id/printed
// Auth: cashier JWT
// Stamps the held order's kitchenPrintedAt so the resume flow knows the
// kitchen has already received it. Idempotent — repeat calls just refresh
// the timestamp.

export const markHeldOrderPrinted = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid held order ID.' });
  }

  const held = await SaleTransaction.findById(id)
    .select('outlet businessDate status source transactionNumber items qrOrder staffOrder orderType tableNumber foodPandaCustomerName customer deliveryAddress assignedRider assignedRiderUser assignedRiderAt assignedRiderBy riderDeliveryStatus cashier notes subtotal discountAmount totalAmount heldAt createdAt kitchenPrintedAt kitchenPrintedQtyMap kdsOrder');
  if (!held) return res.status(404).json({ success: false, message: 'Held order not found.' });
  if (held.status !== 'held') return res.status(409).json({ success: false, message: 'Transaction is not held.' });
  if (!(await requireSamePosOutlet(req.user, held.outlet))) {
    return res.status(403).json({ success: false, message: 'This held order belongs to another outlet.' });
  }

  held.kitchenPrintedAt = new Date();
  // Never trust arbitrary map keys/quantities from the client. Rebuild the
  // persisted baseline from lines that actually exist on this held order and
  // clamp each printed quantity to the saved quantity.
  const requestedQtyMap = req.body?.qtyMap && typeof req.body.qtyMap === 'object' ? req.body.qtyMap : {};
  const printedQtyMap = {};
  let matchedRequestedQuantity = false;
  for (const item of held.items || []) {
    const menuId = String(item.menuItem?._id || item.menuItem || '');
    const variationId = String(item.variation?.id || '');
    const key = `${menuId}::${variationId}`;
    const requested = Math.max(0, Math.floor(Number(requestedQtyMap[key] || 0)));
    if (requested > 0) {
      printedQtyMap[key] = Math.min(requested, Number(item.qty || 0));
      matchedRequestedQuantity = true;
    }
  }
  // Older POS builds marked a successful full kitchen print without sending a
  // quantity map. Treat that as "all current lines printed" so the next QR
  // add-on can never resend the original dishes.
  if (!matchedRequestedQuantity) {
    for (const item of held.items || []) {
      const menuId = String(item.menuItem?._id || item.menuItem || '');
      const variationId = String(item.variation?.id || '');
      const key = `${menuId}::${variationId}`;
      printedQtyMap[key] = (printedQtyMap[key] || 0) + Number(item.qty || 0);
    }
  }
  held.kitchenPrintedQtyMap = printedQtyMap;
  await stampQrKitchenTiming(held, held.kitchenPrintedAt);
  await held.save();
  try {
    await ensureKdsOrderForSale(held, req.user, {
      tenantSlug: req.user?.tenantSlug,
      printStatus: 'printed',
    });
  } catch (kdsError) {
    reportKdsError(`Could not create/update KDS ticket for ${held.transactionNumber}`, kdsError);
    return res.status(503).json({
      success: false,
      code: 'KDS_SYNC_FAILED',
      message: 'Kitchen printing was confirmed, but the KDS ticket could not be saved. Retry Send to Kitchen.',
    });
  }

  // A QR customer's timeline should enter "In Kitchen" only after the print
  // transfer is confirmed, not merely when the cashier approves the order.
  if (held.source === 'qr-self-order' && req.user?.tenantSlug) {
    try {
      const { getIo } = await import('../utils/socket.js');
      const io = getIo();
      io?.to(`qr:order:${req.user.tenantSlug}:${held.transactionNumber}`).emit('qr-order:status', {
        orderNumber: held.transactionNumber,
        status: 'held',
        kitchenPrintedAt: held.kitchenPrintedAt,
        ...qrOrderTimingData(held),
      });
    } catch (socketError) {
      logger.warn(`[QR] Could not emit kitchen print confirmation for ${held.transactionNumber}: ${socketError.message}`);
    }
  }
  return res.json({
    success: true,
    kitchenPrintedAt: held.kitchenPrintedAt,
    kitchenPrintedQtyMap: printedQtyMap,
    ...qrOrderTimingData(held),
  });
};

// ── cancelHeldOrder ───────────────────────────────────────────────────────────
// POST /api/pos/held-orders/:id/cancel
// Body: { prepared, voidReason, selection?, valuationMethod? }
// Cancels a held order and KEEPS the record (status → 'void') for the audit trail
// — it is never hard-deleted. Two modes:
//   • prepared = false → the kitchen never started it; nothing was consumed, so we
//     just flag it cancelled. No stock movement, no journal entry.
//   • prepared = true  → the kitchen already made it. A held order never deducted
//     stock, so we deduct the recipe once now AND log it as waste (recipe cost
//     reclassified to Waste & Spoilage), exactly like voiding a completed sale.
export const cancelHeldOrder = async (req, res) => {
  const { id } = req.params;
  if (typeof req.body.prepared !== 'boolean') {
    return res.status(422).json({ success: false, message: 'Choose whether the order was already prepared.' });
  }
  const prepared = req.body.prepared;
  const voidReason = (req.body.voidReason || '').toString().trim();
  const selection = Array.isArray(req.body.selection) ? req.body.selection : null;
  const valuationMethod = req.body.valuationMethod ?? 'ingredientCost';
  // Older POS bundles did not send a valuation method. Preserve their original
  // ingredient-cost behavior; current clients explicitly opt into strict
  // positive-value validation after showing the preview.
  const requirePositiveValue = req.body.valuationMethod != null;

  if (voidReason.length < 3) {
    return res.status(422).json({ success: false, message: 'A cancellation reason of at least 3 characters is required.' });
  }

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid held order ID.' });
  }

  // Validate first (for precise 404 / 409 / 403 messages).
  const existing = await SaleTransaction.findById(id);
  if (!existing) return res.status(404).json({ success: false, message: 'Held order not found.' });
  if (existing.status !== 'held') {
    return res.status(409).json({ success: false, message: 'Transaction is not in held status.' });
  }
  if (!(await requireSamePosOutlet(req.user, existing.outlet))) {
    return res.status(403).json({ success: false, message: 'This held order belongs to another outlet.' });
  }
  if (hasPendingQrAddOn(existing)) return pendingQrAddOnResponse(res);
  await assertPosCancellationAllowed(existing, req.tenant || req.user?.tenantSlug, { fromKitchen: req.kdsCancellation === true });
  const outletClock = await Outlet.findById(existing.outlet)
    .select('timezone businessDayStart businessDayEnd')
    .lean();
  if (!outletClock) {
    return res.status(409).json({
      success: false,
      message: 'This order’s business day could not be verified, so it cannot be cancelled.',
    });
  }
  const timezone = outletClock.timezone || DEFAULT_TZ;
  const businessDayStart = outletClock.businessDayStart || '00:00';
  const businessDayEnd = outletClock.businessDayEnd || businessDayStart;
  const voidedAt = new Date();
  const voidBusinessDate = getBusinessDate(
    voidedAt,
    timezone,
    businessDayStart,
    businessDayEnd,
  );
  if (!['owner', 'financeManager'].includes(req.user.role)) {
    const currentBusinessDate = voidBusinessDate;
    const heldBusinessDate = existing.businessDate || getBusinessDate(
      existing.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    if (heldBusinessDate !== currentBusinessDate) {
      return res.status(409).json({
        success: false,
        message: `Cashiers cannot cancel held orders from a past business day (${heldBusinessDate}). Ask an owner or finance manager.`,
      });
    }
  }

  // Validate the selected prepared items and valuation before claiming the held
  // order as void. This prevents an invalid/zero-value request from cancelling
  // the order first and only then discovering that its waste record cannot be
  // created.
  if (prepared) {
    try {
      const preview = await previewSaleWaste({ transaction: existing, selection });
      const selectedValue = valuationMethod === 'orderValue'
        ? preview.orderValue
        : preview.recipeCost;
      if (requirePositiveValue && selectedValue <= 0) {
        const error = new Error(
          valuationMethod === 'ingredientCost'
            ? 'Ingredient cost is zero. Choose Order value or record the ingredient purchase costs before logging this waste.'
            : 'Order value is zero, so this waste cannot be logged with Order value.',
        );
        error.statusCode = 400;
        throw error;
      }
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      throw err;
    }
  }

  // Atomically claim the order (held → void), scoped to the authorized outlet. Only
  // the winning request proceeds, so a double-click / two devices can't deduct
  // stock or log waste twice, and the claim itself re-enforces ownership.
  const cancellationUpdate = {
    status: 'void',
    businessDate: existing.businessDate || getBusinessDate(
      existing.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    ),
    voidedAt,
    voidedBy: req.user.id,
    voidReason,
    wasPreparedAtCancellation: prepared,
    voidBusinessDate,
  };
  // Keep the customer-facing QR audit data in sync with the canonical sale
  // void fields. Legacy QR holds may not have a cashier, so claim only those
  // rows without replacing the cashier who originally approved the order.
  if (existing.source === 'qr-self-order') {
    cancellationUpdate['qrOrder.declinedAt'] = voidedAt;
    cancellationUpdate['qrOrder.declinedBy'] = req.user.id;
    cancellationUpdate['qrOrder.declineReason'] = voidReason;
    if (!existing.cashier) cancellationUpdate.cashier = req.user.id;
  }
  const held = await SaleTransaction.findOneAndUpdate(
    { _id: id, status: 'held', outlet: existing.outlet },
    { $set: cancellationUpdate },
    { returnDocument: 'after' },
  );
  if (!held) {
    return res.status(409).json({ success: false, message: 'This held order was already cancelled or paid.' });
  }
  await cancelUserRiderAssignment({
    saleId: held._id,
    actor: req.user,
    tenantSlug: req.tenantSlug,
    reason: `Order cancelled: ${voidReason}`,
  });

  let wasteCost = 0;
  let ingredientCost = 0;
  let orderValue = 0;
  if (prepared) {
    // Deduct the recipe once + book the loss. logSaleAsWaste saves `held`
    // (isVoidedAsWaste / wasteLogId / wastedQty); status is already 'void'.
    try {
      const result = await logSaleAsWaste({
        transaction: held,
        reason: 'orderVoid',
        notes: voidReason,
        userId: req.user.id,
        deductStock: true,
        selection,
        valuationMethod,
        requirePositiveValue,
      });
      wasteCost = result?.wasteValue ?? 0;
      ingredientCost = result?.recipeCost ?? 0;
      orderValue = result?.orderValue ?? 0;
    } catch (err) {
      // The order is already claimed as void; log and surface, but never re-run.
      logger.error(`[CANCEL] Waste logging failed for ${held.transactionNumber}: ${err.message}`);
      if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
      throw err;
    }
  }

  try {
    await syncKdsCancellation({
      saleId: held._id,
      actor: req.user,
      tenantSlug: req.user?.tenantSlug,
      source: req.kdsCancellation ? 'kds' : 'pos',
      reason: voidReason,
      prepared,
      wasteValue: wasteCost,
    });
  } catch (kdsError) {
    reportKdsError(`Could not synchronize cancellation for ${held.transactionNumber}`, kdsError);
  }

  // QR self-order → free the table + notify the customer's tracking page.
  if (held.source === 'qr-self-order') {
    try {
      const { getIo } = await import('../utils/socket.js');
      const io = getIo();
      const tenantSlug = req.user?.tenantSlug;
      if (io && tenantSlug) {
        io.to(`qr:order:${tenantSlug}:${held.transactionNumber}`).emit('qr-order:status', {
          orderNumber: held.transactionNumber,
          status: 'void',
          fulfillmentStatus: 'declined',
          declineReason: voidReason,
        });
        if (held.qrOrder?.tableCode) {
          io.to(`qr:table:${tenantSlug}:${String(held.outlet)}:${held.qrOrder.tableCode}`)
            .emit('qr-table:freed', { orderNumber: held.transactionNumber });
        }
        io.to(`qr:cashier:${tenantSlug}:${String(held.outlet)}`).emit('qr-order:updated', {
          orderNumber: held.transactionNumber, status: 'void',
        });
      }
    } catch (sockErr) {
      logger.warn(`[CANCEL] QR socket emit failed: ${sockErr.message}`);
    }
  }

  await AuditLog.create({
    user: req.user.id,
    action: 'held_order_cancelled',
    module: 'pos',
    recordId: held._id,
    after: {
      transactionNumber: held.transactionNumber,
      prepared,
      voidReason,
      wasteCost,
      ingredientCost,
      orderValue,
      valuationMethod: prepared ? valuationMethod : null,
      selection: prepared ? selection : null,
    },
    ip: req.ip,
  }).catch(() => {});

  logger.info(`Held order cancelled: ${held.transactionNumber} prepared=${prepared} wasteCost=${wasteCost} valuation=${prepared ? valuationMethod : 'none'} by ${req.user.email}`);
  return res.json({
    success: true,
    data: {
      prepared,
      voidReason,
      wasteCost,
      wasteValue: wasteCost,
      ingredientCost,
      orderValue,
      valuationMethod: prepared ? valuationMethod : null,
    },
  });
};

// ── moveHeldOrderItem ───────────────────────────────────────────────────────
// PATCH /api/pos/held-orders/:sourceId/move-item
// Body: { targetHoldId, menuItemId, qty }
// Auth: cashier JWT
//
// Moves `qty` units of one line item from the source held order to the target
// held order. Both must belong to the user's current outlet.
//
// Inventory is intentionally untouched: held orders never deduct stock — they
// only *reserve* ingredients at availability-calc time (see posMenu.controller
// getPOSMenuAvailability), which re-reads the held set on every call. So after
// a move the reservation simply shifts automatically; no stock mutation needed.
//
// Totals on both orders are recomputed from their (stored) line prices so the
// quoted amounts the customer saw are preserved. If the source order ends up
// empty it is deleted.

export const moveHeldOrderItem = async (req, res) => {
  const { sourceId } = req.params;
  const { targetHoldId, menuItemId, qty, variationId, dealSelections = [] } = req.body;
  // A line is identified by its menu item AND its chosen size (null = no size),
  // so two sizes of the same item are moved independently.
  const wantVariation = variationId ?? null;
  const lineVariation = (it) => (it.variation?.id?.toString() ?? null);
  const selectionKey = (selections = []) => selections
    .map((selection) => `${String(selection.groupId)}:${(selection.optionIds || []).map(String).sort().join(',')}`)
    .sort()
    .join('|');
  const wantSelections = selectionKey(dealSelections);
  const sameDealSelections = (it) => selectionKey(it.dealSelections || []) === wantSelections;

  if (!mongoose.isValidObjectId(sourceId) || !mongoose.isValidObjectId(targetHoldId)) {
    return res.status(400).json({ success: false, message: 'Invalid held order ID.' });
  }
  if (sourceId === targetHoldId) {
    return res.status(400).json({ success: false, message: 'Source and destination orders must be different.' });
  }

  const [source, target] = await Promise.all([
    SaleTransaction.findById(sourceId),
    SaleTransaction.findById(targetHoldId),
  ]);

  for (const [doc, label] of [[source, 'Source'], [target, 'Destination']]) {
    if (!doc) return res.status(404).json({ success: false, message: `${label} held order not found.` });
    if (doc.status !== 'held') return res.status(409).json({ success: false, message: `${label} order is not in held status.` });
  }
  if (source.outlet.toString() !== target.outlet.toString()) {
    return res.status(409).json({ success: false, message: 'Both orders must belong to the same outlet.' });
  }
  if (!(await requireSamePosOutlet(req.user, source.outlet))) {
    return res.status(403).json({ success: false, message: 'These held orders belong to another outlet.' });
  }
  if (hasPendingQrAddOn(source) || hasPendingQrAddOn(target)) {
    return pendingQrAddOnResponse(res);
  }
  // Moving accepted items into an untracked hold must not remove the kitchen's
  // authority over their cancellation.
  await assertPosCancellationAllowed(source, req.tenant || req.user?.tenantSlug);

  // Locate the line on the source order (matched by item + size).
  const line = source.items.find((it) =>
    it.menuItem && it.menuItem.toString() === menuItemId
    && lineVariation(it) === wantVariation && sameDealSelections(it));
  if (!line) {
    return res.status(422).json({ success: false, message: 'That item is not on the source order.' });
  }
  if (qty > line.qty) {
    return res.status(422).json({ success: false, message: `Only ${line.qty} unit(s) of "${line.name}" are available to move.` });
  }

  // Capture both orders' authoritative kitchen baselines before any line is
  // mutated. A queued ticket is treated the same way the resume flow treats it:
  // already communicated, preventing a duplicate while the connector finishes.
  const sourcePrintedBaseline = normalizePrintedQuantityMap(
    source.items,
    source.kitchenPrintedQtyMap,
    { assumeAllPrinted: Boolean(source.kitchenPrintedAt || source.kitchenPrintQueuedAt) },
  );
  const targetPrintedBaseline = normalizePrintedQuantityMap(
    target.items,
    target.kitchenPrintedQtyMap,
    { assumeAllPrinted: Boolean(target.kitchenPrintedAt || target.kitchenPrintQueuedAt) },
  );
  const movedLineKey = kitchenLineKey(line);

  // Capture the moved line's pricing before mutating (so a merge keeps prices).
  const moved = {
    menuItem: line.menuItem,
    categoryId: line.categoryId,
    categoryName: line.categoryName,
    variation: line.variation,
    name: line.name,
    listedUnitPrice: line.listedUnitPrice ?? line.unitPrice,
    priceMode: line.priceMode || 'exclusive',
    unitPrice: line.unitPrice,
    taxRate: line.taxRate || 0,
    dealSelections: line.dealSelections,
    dealComponents: line.dealComponents,
    pra: line.pra,
    discount: round2((line.discountAmount || 0) * (qty / line.qty)),
  };

  // Order-level discount = stored combined discount minus the per-line discounts.
  const orderDiscountOf = (doc) => {
    const itemDisc = round2(doc.items.reduce((s, i) => s + (i.discountAmount || 0), 0));
    return Math.max(0, round2((doc.discountAmount || 0) - itemDisc));
  };
  const srcPrevOrderDiscount = orderDiscountOf(source);
  const tgtPrevOrderDiscount = orderDiscountOf(target);

  // Service charge is the outlet's central rate, applied to every line, only for
  // the enabled order types — recomputed per held order so the preview total
  // matches what the order will be charged when resumed and paid.
  const moveTaxConfig = await getTaxConfig(source.outlet);
  const scRateFor = (doc) =>
    serviceChargeAppliesTo(moveTaxConfig, doc.orderType || 'dine-in')
      ? Number(moveTaxConfig.serviceChargeRate || 0)
      : 0;

  // Recompute a held order's line + header totals from its stored prices.
  const recompute = (doc, prevOrderDiscount) => {
    const scRate = scRateFor(doc);
    doc.items.forEach((it) => {
      const priced = calculateLineCharges({
        listedUnitPrice: it.listedUnitPrice ?? it.unitPrice,
        qty: it.qty,
        priceMode: it.priceMode,
        taxable: doc.orderType !== 'foodpanda' && Number(it.taxRate || 0) > 0,
        taxRate: doc.orderType === 'foodpanda' ? 0 : Number(it.taxRate || 0),
        serviceChargeRate: scRate,
      });
      it.listedUnitPrice = priced.listedUnitPrice;
      it.priceMode = priced.priceMode;
      it.unitPrice = priced.unitPrice;
      it.lineTotal = priced.lineTotal;
      it.taxAmount = priced.taxAmount;
      if (doc.orderType === 'foodpanda') it.discountAmount = 0;
      it.serviceChargeRate = scRate;
      it.serviceChargeAmount = priced.serviceChargeAmount;
    });
    const subtotal = round2(doc.items.reduce((s, i) => s + i.lineTotal, 0));
    const tax = round2(doc.items.reduce((s, i) => s + i.taxAmount, 0));
    const serviceCharge = round2(doc.items.reduce((s, i) => s + (i.serviceChargeAmount || 0), 0));
    // Delivery charge is preserved as-is on the held doc; it counts toward the
    // total only for delivery orders (mirrors the server/POS elsewhere).
    const delivery = (doc.orderType === 'delivery') ? round2(doc.deliveryChargeAmount || 0) : 0;
    const itemDisc = round2(doc.items.reduce((s, i) => s + (i.discountAmount || 0), 0));
    let orderDisc;
    if (doc.orderType === 'foodpanda') {
      orderDisc = 0;
    } else if (doc.discountMode === 'percent') {
      orderDisc = round2(subtotal * ((doc.discountPercent || 0) / 100));
    } else {
      // Fixed amount: keep it, but never let total go negative.
      orderDisc = Math.max(0, Math.min(prevOrderDiscount, round2(subtotal + tax + serviceCharge + delivery - itemDisc)));
    }
    const combined = round2(itemDisc + orderDisc);
    doc.subtotal = subtotal;
    doc.taxAmount = tax;
    doc.serviceChargeAmount = serviceCharge;
    doc.discountAmount = combined;
    if (doc.orderType === 'foodpanda') {
      doc.discountMode = 'amount';
      doc.discountPercent = 0;
    }
    doc.totalAmount = round2(Math.max(0, subtotal + tax + serviceCharge + delivery - combined));
  };

  // ── Source: reduce (or remove) the moved line ──
  line.qty -= qty;
  line.discountAmount = round2((line.discountAmount || 0) - moved.discount);
  if (line.qty <= 0) {
    source.items = source.items.filter((it) =>
      !(it.menuItem && it.menuItem.toString() === menuItemId
        && lineVariation(it) === wantVariation && sameDealSelections(it)));
  }

  // ── Target: merge into a matching line (same item + size + price + tax) or add new ──
  const tLine = target.items.find((it) =>
    it.menuItem && it.menuItem.toString() === menuItemId && lineVariation(it) === wantVariation &&
    sameDealSelections(it) && it.unitPrice === moved.unitPrice && (it.taxRate || 0) === moved.taxRate);
  if (tLine) {
    tLine.qty += qty;
    tLine.discountAmount = round2((tLine.discountAmount || 0) + moved.discount);
  } else {
    target.items.push({
      menuItem: moved.menuItem,
      categoryId: moved.categoryId,
      categoryName: moved.categoryName,
      variation: moved.variation,
      name: moved.name,
      qty,
      unitPrice: moved.unitPrice,
      taxRate: moved.taxRate,
      listedUnitPrice: moved.listedUnitPrice,
      priceMode: moved.priceMode,
      dealSelections: moved.dealSelections,
      dealComponents: moved.dealComponents,
      pra: moved.pra,
      discountAmount: moved.discount,
      lineTotal: 0,
      taxAmount: 0,
      // Service charge is recomputed centrally below.
      serviceChargeAmount: 0,
      serviceChargeRate: 0,
    });
  }

  const sourceEmptied = source.items.length === 0;

  // Move the already-printed portion with the units. Any moved quantity above
  // that portion stays pending on the destination and will appear on its next
  // delta KOT. Timestamps/jobs are deliberately untouched.
  const printTransfer = transferPrintedQuantity({
    sourceBaseline: sourcePrintedBaseline,
    targetBaseline: targetPrintedBaseline,
    nextSourceItems: source.items,
    nextTargetItems: target.items,
    lineKey: movedLineKey,
    movedQuantity: qty,
  });
  source.kitchenPrintedQtyMap = printTransfer.sourcePrintedQuantityMap;
  target.kitchenPrintedQtyMap = printTransfer.targetPrintedQuantityMap;

  // Persist. An emptied source order is discarded rather than left at zero.
  if (sourceEmptied) {
    await cancelUserRiderAssignment({
      saleId: source._id,
      actor: req.user,
      tenantSlug: req.tenantSlug,
      reason: 'Order was emptied while its items were moved to another held order.',
    });
    await SaleTransaction.deleteOne({ _id: source._id });
  } else {
    recompute(source, srcPrevOrderDiscount);
    await source.save();
  }
  recompute(target, tgtPrevOrderDiscount);
  await target.save();
  await Promise.all([
    sourceEmptied ? Promise.resolve() : syncUserRiderAssignment({ sale: source, tenantSlug: req.tenantSlug }),
    syncUserRiderAssignment({ sale: target, tenantSlug: req.tenantSlug }),
  ]);

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_held_item_moved',
    module: 'pos',
    recordId: target._id,
    after: {
      menuItem: menuItemId,
      name: moved.name,
      qty,
      from: source._id,
      to: target._id,
      sourceDiscarded: sourceEmptied,
      printedQuantityTransferred: printTransfer.printedQuantityTransferred,
    },
    ip: req.ip,
  });

  logger.info(
    `Held item moved: ${qty}× "${moved.name}" from ${source.transactionNumber} → ${target.transactionNumber} by ${req.user.email}` +
    (sourceEmptied ? ' (source discarded — became empty)' : ''),
  );

  return res.json({
    success: true,
    data: {
      source: sourceEmptied ? null : source.toObject(),
      target: target.toObject(),
      sourceDiscarded: sourceEmptied,
      printedQuantityTransferred: printTransfer.printedQuantityTransferred,
    },
  });
};

// Auth: cashier JWT
// Returns items to the POS cart. The held record stays in 'held' status until
// the resumed sale is paid (processSale will delete it on success). This way
// a cashier can clear the cart by mistake and still find the order again.

export const resumeHeldOrder = async (req, res) => {
  const held = await SaleTransaction.findById(req.params.id)
    .populate('customer', 'name phone email addresses')
    .lean();

  if (!held) {
    return res.status(404).json({ success: false, message: 'Held order not found.' });
  }
  if (held.status !== 'held') {
    return res.status(409).json({ success: false, message: 'Transaction is not in held status.' });
  }
  if (!(await requireSamePosOutlet(req.user, held.outlet))) {
    return res.status(403).json({ success: false, message: 'This held order belongs to another outlet.' });
  }
  if (hasPendingQrAddOn(held)) return pendingQrAddOnResponse(res);

  logger.info(`Held order resumed (kept in queue until paid): ${held.transactionNumber} by ${req.user.email}`);
  const kds = await getSaleKdsCancellationState(held, req.tenant || req.user?.tenantSlug);

  // Return items in cart-ready format for the POS frontend.
  // `heldOrderId` lets the frontend tag the next sale so the backend can
  // remove the held record on payment.
  return res.json({
    success: true,
    message: 'Held order resumed. Items returned to cart.',
    data: { ...held, kds },
    cart: {
      heldOrderId: held._id,
      kds,
      items: held.items,
      discountAmount: held.discountAmount,
      discountMode: held.discountMode || 'amount',
      discountPercent: held.discountPercent || 0,
      notes: held.notes,
      cashierNotes: held.cashierNotes || '',
      orderType: held.orderType || 'dine-in',
      foodPandaOrderNumber: held.foodPandaOrderNumber || '',
      foodPandaCustomerName: held.foodPandaCustomerName || '',
      customer: held.customer || null,
      tableNumber: held.tableNumber || '',
      deliveryAddress: held.deliveryAddress || null,
      deliveryChargeAmount: held.deliveryChargeAmount || 0,
      kitchenPrintedAt: held.kitchenPrintedAt || null,
      kitchenPrintedQtyMap: held.kitchenPrintedQtyMap || {},
      redeemPoints: held.pointsRedeemed || 0,
    },
  });
};

// ── voidTransaction ────────────────────────────────────────────────────────────
// POST /api/pos/sale/:id/void
// Auth: owner or financeManager

const getReversibleChargeToSalaryAdvance = async (transaction) => {
  if (transaction.paymentMethod !== 'charge-to-salary' || !transaction.salaryAdvance) return null;
  const advance = await SalaryAdvance.findById(transaction.salaryAdvance);
  if (!advance || advance.status === 'voided') return advance;
  if (Number(advance.recoveredAmount || 0) > 0) {
    throw Object.assign(
      new Error(
        'This charge has already been recovered from salary. Void the related salary payment or repayment before cancelling the order.'
      ),
      { statusCode: 409 }
    );
  }
  return advance;
};

const markChargeToSalaryAdvanceVoided = async (advance, userId, reason) => {
  if (!advance || advance.status === 'voided') return;
  advance.status = 'voided';
  advance.voidedAt = new Date();
  advance.voidedBy = userId;
  advance.voidReason = reason;
  await advance.save();
};

export const voidTransaction = async (req, res) => {
  const { voidReason } = req.body;
  if (typeof req.body.prepared !== 'boolean') {
    return res.status(422).json({ success: false, message: 'Choose whether the order was already prepared.' });
  }
  const prepared = req.body.prepared;
  const selection = Array.isArray(req.body.selection) ? req.body.selection : null;
  const valuationMethod = req.body.valuationMethod ?? 'ingredientCost';

  const transaction = await SaleTransaction.findById(req.params.id);

  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }
  // Completed sales and dispatched (unpaid) delivery orders can both be voided.
  // For out-for-delivery there is no journal entry yet, so only stock is reversed.
  if (transaction.status !== 'completed' && transaction.status !== 'out-for-delivery') {
    return res.status(409).json({
      success: false,
      message: `Cannot void a transaction with status '${transaction.status}'.`,
    });
  }
  await assertPosCancellationAllowed(transaction, req.tenant || req.user?.tenantSlug, { fromKitchen: req.kdsCancellation === true });
  // Waste (full or partial) is a separate accounting + inventory adjustment that
  // void cannot cleanly unwind (its reclassification JE and any re-make stock
  // deduction live on the WasteLog, not the sale). Block the combination.
  if (transaction.isVoidedAsWaste || transaction.partiallyWasted) {
    return res.status(409).json({
      success: false,
      message: 'This order has waste logged against it and cannot be voided. Waste and void are separate adjustments.',
    });
  }

  // Validate prepared-item waste before changing sale, stock, accounting, or
  // loyalty state. A completed sale originally deducted the full recipe. The
  // void first restores it; prepared items are then deducted again and logged
  // as waste so only genuinely unprepared ingredients return to stock.
  if (prepared) {
    try {
      const preview = await previewSaleWaste({ transaction, selection });
      const selectedValue = valuationMethod === 'orderValue'
        ? preview.orderValue
        : preview.recipeCost;
      if (selectedValue <= 0) {
        const error = new Error(
          valuationMethod === 'ingredientCost'
            ? 'Ingredient cost is zero. Choose Order value before cancelling this prepared order.'
            : 'Order value is zero, so this prepared-order waste cannot be logged.',
        );
        error.statusCode = 400;
        throw error;
      }
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ success: false, message: err.message });
      }
      throw err;
    }
  }

  // Cashiers may only cancel their OWN orders. Other staff reach this action
  // only when an owner explicitly grants the dedicated Cancel Orders permission,
  // so that grant authorizes them to correct any order visible in their workflow.
  const isCashier = req.user.role === 'cashier';
  if (!req.kdsCancellation && isCashier && transaction.cashier?.toString() !== req.user.id?.toString()) {
    return res.status(403).json({ success: false, message: 'You can only cancel your own orders.' });
  }

  // A cashier may correct a mistaken order only while that order's BUSINESS
  // day is still active. Order History can query older dates, but browsing an
  // old day must never reopen its stock/accounting period for cashier edits.
  // Explicitly-authorized non-cashier staff retain historical correction authority.
  const outletClock = transaction.outlet
    ? await Outlet.findById(transaction.outlet)
      .select('timezone businessDayStart businessDayEnd pra')
      .lean()
    : null;
  if (!outletClock) {
    return res.status(409).json({
      success: false,
      message: 'This order’s business day could not be verified, so it cannot be cancelled.',
    });
  }
  const timezone = outletClock.timezone || DEFAULT_TZ;
  const businessDayStart = outletClock.businessDayStart || '00:00';
  const businessDayEnd = outletClock.businessDayEnd || businessDayStart;
  if (isCashier) {
    const currentBusinessDate = getBusinessDate(new Date(), timezone, businessDayStart, businessDayEnd);
    const transactionBusinessDate = transaction.businessDate || getBusinessDate(
      transaction.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    if (transactionBusinessDate !== currentBusinessDate) {
      return res.status(409).json({
        success: false,
        message: `Cashiers cannot cancel orders from a past business day (${transactionBusinessDate}). Ask an owner or finance manager.`,
      });
    }
  }

  const before = { status: transaction.status };
  // Validate payroll recovery before touching inventory or accounting. A
  // recovered employee receivable cannot be silently removed by a POS void.
  const chargeToSalaryAdvance = await getReversibleChargeToSalaryAdvance(transaction);

  // ── Reverse inventory depletion ───────────────────────────────────────────
  await _reverseInventory(transaction);

  // ── Reverse journal entry ─────────────────────────────────────────────────
  if (transaction.journalEntryId) {
    await reverseJournalEntry(transaction.journalEntryId, req.user.id);
  }
  await markChargeToSalaryAdvanceVoided(
    chargeToSalaryAdvance,
    req.user.id,
    `POS void: ${voidReason}`,
  );

  // ── Reverse loyalty points (earn + redeem) when configured ───────────────
  await reverseSaleLoyalty({ sale: transaction, userId: req.user.id });

  const voidedAt = new Date();
  transaction.status = 'void';
  transaction.voidReason = voidReason;
  transaction.voidedBy = req.user.id;
  transaction.voidedAt = voidedAt;
  transaction.wasPreparedAtCancellation = prepared;
  if (transaction.source === 'qr-self-order') {
    transaction.qrOrder = transaction.qrOrder || {};
    transaction.qrOrder.declinedAt = voidedAt;
    transaction.qrOrder.declinedBy = req.user.id;
    transaction.qrOrder.declineReason = voidReason;
    if (!transaction.cashier) transaction.cashier = req.user.id;
  }
  transaction.voidBusinessDate = getBusinessDate(
    voidedAt,
    timezone,
    businessDayStart,
    businessDayEnd,
  );
  const pendingPraCredit = initialPraCreditState(transaction, outletClock.pra);
  if (pendingPraCredit) transaction.pra.credit = pendingPraCredit;
  await transaction.save();

  let wasteResult = null;
  if (prepared) {
    wasteResult = await logSaleAsWaste({
      transaction,
      reason: 'orderVoid',
      notes: voidReason,
      userId: req.user.id,
      deductStock: true,
      selection,
      valuationMethod,
      requirePositiveValue: true,
    });
  }
  await cancelUserRiderAssignment({
    saleId: transaction._id,
    actor: req.user,
    tenantSlug: req.tenantSlug,
    reason: `Order voided: ${voidReason}`,
  });
  await syncKdsCancellation({
    saleId: transaction._id,
    actor: req.user,
    tenantSlug: req.user?.tenantSlug,
    source: req.kdsCancellation ? 'kds' : 'pos',
    reason: voidReason,
    prepared,
    wasteValue: wasteResult?.wasteValue ?? 0,
  });

  if (transaction.source === 'qr-self-order' && req.user?.tenantSlug) {
    try {
      const { getIo } = await import('../utils/socket.js');
      const io = getIo();
      io?.to(`qr:order:${req.user.tenantSlug}:${transaction.transactionNumber}`).emit('qr-order:status', {
        orderNumber: transaction.transactionNumber,
        status: 'void',
        fulfillmentStatus: 'declined',
        declineReason: voidReason,
      });
      io?.to(`qr:cashier:${req.user.tenantSlug}:${String(transaction.outlet)}`).emit('qr-order:updated', {
        orderNumber: transaction.transactionNumber,
        status: 'void',
      });
    } catch (socketError) {
      logger.warn(`[VOID] QR socket emit failed for ${transaction.transactionNumber}: ${socketError.message}`);
    }
  }

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_transaction_voided',
    module: 'pos',
    recordId: transaction._id,
    before,
    after: {
      status: 'void',
      voidReason,
      prepared,
      wasteValue: wasteResult?.wasteValue ?? 0,
      ingredientCost: wasteResult?.recipeCost ?? 0,
      orderValue: wasteResult?.orderValue ?? 0,
      valuationMethod: prepared ? valuationMethod : null,
      selection: prepared ? selection : null,
    },
    ip: req.ip,
  });

  logger.info(`Transaction voided: ${transaction.transactionNumber} by ${req.user.email}`);

  await finishPraCancellation(transaction, req.user?.tenantSlug);

  return res.json({ success: true, data: transaction });
};

// ── refundTransaction ──────────────────────────────────────────────────────────
// POST /api/pos/sale/:id/refund
// Auth: owner or financeManager

export const refundTransaction = async (req, res) => {
  const { refundReason } = req.body;

  const transaction = await SaleTransaction.findById(req.params.id);

  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }
  if (transaction.status !== 'completed') {
    return res.status(409).json({
      success: false,
      message: `Cannot refund a transaction with status '${transaction.status}'.`,
    });
  }
  // See voidTransaction: waste is a separate adjustment refund cannot cleanly
  // unwind (reclassification JE + any re-make stock deduction live on the WasteLog).
  if (transaction.isVoidedAsWaste || transaction.partiallyWasted) {
    return res.status(409).json({
      success: false,
      message: 'This order has waste logged against it and cannot be refunded. Waste and refund are separate adjustments.',
    });
  }

  const before = { status: transaction.status };
  const chargeToSalaryAdvance = await getReversibleChargeToSalaryAdvance(transaction);

  // ── Reverse inventory depletion ───────────────────────────────────────────
  await _reverseInventory(transaction);

  // ── Reverse journal entry ─────────────────────────────────────────────────
  if (transaction.journalEntryId) {
    await reverseJournalEntry(transaction.journalEntryId, req.user.id);
  }
  await markChargeToSalaryAdvanceVoided(
    chargeToSalaryAdvance,
    req.user.id,
    `POS refund: ${refundReason}`,
  );

  // ── Reverse loyalty points (earn + redeem) when configured ───────────────
  await reverseSaleLoyalty({ sale: transaction, userId: req.user.id });

  transaction.status = 'refunded';
  transaction.isRefund = true;
  transaction.refundReason = refundReason;
  const refundOutlet = await Outlet.findById(transaction.outlet).select('pra').lean();
  const pendingPraCredit = initialPraCreditState(transaction, refundOutlet?.pra);
  if (pendingPraCredit) transaction.pra.credit = pendingPraCredit;
  await transaction.save();
  await cancelUserRiderAssignment({
    saleId: transaction._id,
    actor: req.user,
    tenantSlug: req.tenantSlug,
    reason: `Order refunded: ${refundReason}`,
  });

  // ── Update session running totals (advisory — close recomputes from scratch) ─
  await SaleSession.findByIdAndUpdate(transaction.session, {
    $inc: {
      'totals.totalRefunds': transaction.totalAmount,
      'totals.netCash': -transaction.cashAmount,
    },
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_transaction_refunded',
    module: 'pos',
    recordId: transaction._id,
    before,
    after: { status: 'refunded', refundReason, totalAmount: transaction.totalAmount },
    ip: req.ip,
  });

  logger.info(`Transaction refunded: ${transaction.transactionNumber} by ${req.user.email}`);

  await finishPraCancellation(transaction, req.user?.tenantSlug);

  return res.json({ success: true, data: transaction });
};

// ── syncOffline ────────────────────────────────────────────────────────────────
// POST /api/pos/sync-offline
// Auth: cashier JWT
// Body: { transactions: [...salePayloads] }

export const syncOffline = async (req, res) => {
  const { transactions } = req.body;
  const synced = [];
  const skipped = [];
  const failed = [];
  const closedSessionIds = new Set();
  const contextCache = new Map();

  for (const rawPayload of transactions) {
    const rawClientTransactionId = rawPayload?.clientTransactionId || null;
    const { error: validationError, value: payload } = saleSchema.validate(rawPayload, {
      abortEarly: false,
      stripUnknown: true,
    });
    if (validationError) {
      failed.push({
        clientTransactionId: rawClientTransactionId,
        code: 'INVALID_PAYLOAD',
        retryable: false,
        error: validationError.details.map((detail) => detail.message).join('. '),
      });
      continue;
    }
    if (
      !payload.clientTransactionId
      || !payload.sessionId
      || !payload.cashierId
      || !payload.queuedAt
    ) {
      failed.push({
        clientTransactionId: payload.clientTransactionId || null,
        code: 'MISSING_ORIGIN',
        retryable: false,
        error: 'Offline sales require their original transaction, cashier, session, and queued-at identifiers.',
      });
      continue;
    }
    if (String(payload.cashierId) !== String(req.user.id)) {
      failed.push({
        clientTransactionId: payload.clientTransactionId,
        code: 'CASHIER_MISMATCH',
        retryable: false,
        error: 'This offline sale belongs to another cashier and cannot be synced from this login.',
      });
      continue;
    }
    if (payload.paymentMethod === 'charge-to-salary') {
      failed.push({
        clientTransactionId: payload.clientTransactionId,
        code: 'ONLINE_ONLY_PAYMENT',
        retryable: false,
        error: 'Charge-to-salary sales must be processed online so employee limits can be checked.',
      });
      continue;
    }

    const occurredAt = new Date(payload.queuedAt);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + (10 * 60 * 1000)) {
      failed.push({
        clientTransactionId: payload.clientTransactionId,
        code: 'INVALID_QUEUED_AT',
        retryable: false,
        error: 'The offline sale timestamp is invalid or is too far in the future.',
      });
      continue;
    }

    try {
      let context = contextCache.get(String(payload.sessionId));
      if (!context) {
        const session = await SaleSession.findOne({
          _id: payload.sessionId,
          cashier: req.user.id,
        }).lean();
        if (!session) {
          failed.push({
            clientTransactionId: payload.clientTransactionId,
            code: 'ORIGINAL_SESSION_NOT_FOUND',
            retryable: false,
            error: 'The original cashier session for this offline sale was not found.',
          });
          continue;
        }

        const outlet = await Outlet.findById(session.outlet).lean();
        if (!outlet) {
          failed.push({
            clientTransactionId: payload.clientTransactionId,
            code: 'ORIGINAL_OUTLET_NOT_FOUND',
            retryable: false,
            error: 'The original outlet for this offline sale was not found.',
          });
          continue;
        }
        context = { session, outlet };
        contextCache.set(String(payload.sessionId), context);
      }

      if (payload.outletCode && payload.outletCode !== context.outlet.code) {
        failed.push({
          clientTransactionId: payload.clientTransactionId,
          code: 'OUTLET_MISMATCH',
          retryable: false,
          error: 'The offline sale outlet does not match its original session.',
        });
        continue;
      }

      const result = await withOfflineSyncLock(payload.clientTransactionId, async () => {
        const existing = await SaleTransaction.findOne({
          clientTransactionId: payload.clientTransactionId,
          cashier: req.user.id,
          status: { $ne: 'held' },
        }).lean();
        if (existing) {
          await finalizeResumedHoldAfterSale({
            resumedFromHoldId: payload.resumedFromHoldId,
            outlet: context.outlet,
            transaction: existing,
            tenantSlug: req.user?.tenantSlug,
          });
          await removeSupersededLocalHoldAfterSale({
            localHoldClientTransactionId: payload.localHoldClientTransactionId,
            outlet: context.outlet,
            cashierId: req.user.id,
            transaction: existing,
          });
          return { kind: 'skipped', transaction: existing };
        }

        const resumedTransaction = await findResumableHeldTransaction({
          payload,
          outlet: context.outlet,
        });
        if (payload.resumedFromHoldId && !resumedTransaction) {
          throw Object.assign(
            new Error('This held order is no longer available for checkout. Refresh the held-order list.'),
            { statusCode: 409, syncCode: 'HELD_ORDER_NOT_AVAILABLE' },
          );
        }

        try {
          const transaction = await _processSaleCore(
            payload,
            {
              cashier: req.user,
              session: context.session,
              outlet: context.outlet,
              tenant: req.tenant,
              offlineMeta: { queuedAt: occurredAt },
              existingTransaction: resumedTransaction,
            },
            'completed',
          );
          await finalizeResumedHoldAfterSale({
            resumedFromHoldId: payload.resumedFromHoldId,
            outlet: context.outlet,
            transaction,
            tenantSlug: req.user?.tenantSlug,
          });
          await removeSupersededLocalHoldAfterSale({
            localHoldClientTransactionId: payload.localHoldClientTransactionId,
            outlet: context.outlet,
            cashierId: req.user.id,
            transaction,
          });
          return { kind: 'synced', transaction };
        } catch (err) {
          if (err?.code !== 11000) throw err;
          const duplicate = await SaleTransaction.findOne({
            clientTransactionId: payload.clientTransactionId,
            cashier: req.user.id,
          }).lean();
          if (!duplicate) throw err;
          await removeSupersededLocalHoldAfterSale({
            localHoldClientTransactionId: payload.localHoldClientTransactionId,
            outlet: context.outlet,
            cashierId: req.user.id,
            transaction: duplicate,
          });
          return { kind: 'skipped', transaction: duplicate };
        }
      });

      const normalized = offlineTransactionResult(result.transaction);
      if (result.kind === 'synced') {
        synced.push(normalized);
        if (env.PRA_QUEUE_ENABLED && result.transaction.pra?.status === 'pending') {
          try {
            const event = await ensurePraOutboxEvent(result.transaction._id, 'sale');
            publishPraOutboxEventById(req.user.tenantSlug, event._id)
              .then((published) => {
                if (!published) return submitSaleToPra(result.transaction);
                return null;
              })
              .catch((e) => logger.error(`[PRA] sync queue error: ${e?.message}`));
          } catch (queueError) {
            logger.error(`[PRA] sync outbox error: ${queueError.message}`);
            submitSaleToPra(result.transaction)
              .catch((e) => logger.error(`[PRA] sync submit error: ${e?.message}`));
          }
        } else {
          submitSaleToPra(result.transaction)
            .catch((e) => logger.error(`[PRA] sync submit error: ${e?.message}`));
        }
      } else {
        skipped.push(normalized);
      }
      if (context.session.status === 'closed') {
        closedSessionIds.add(String(context.session._id));
      }
    } catch (err) {
      logger.error(`[syncOffline] Failed to sync txn ${payload.clientTransactionId ?? 'unknown'}: ${err.message}`);
      failed.push({
        clientTransactionId: payload.clientTransactionId ?? null,
        code: err.code === 11000 ? 'DUPLICATE_CONFLICT' : (err.syncCode || 'SYNC_FAILED'),
        retryable: !err.statusCode || err.statusCode >= 500,
        error: err.message,
        details: err.details || null,
      });
    }
  }

  for (const sessionId of closedSessionIds) {
    try {
      await refreshClosedSessionTotals(sessionId);
    } catch (err) {
      logger.error(`[syncOffline] Failed to refresh closed session ${sessionId}: ${err.message}`);
    }
  }

  logger.info(
    `[syncOffline] by ${req.user.email}: synced=${synced.length} ` +
    `skipped=${skipped.length} failed=${failed.length}`
  );

  return res.json({
    success: true,
    data: {
      synced,
      skipped,
      failed,
      summary: {
        synced: synced.length,
        skipped: skipped.length,
        failed: failed.length,
      },
    },
  });
};

export const getOfflineSyncStatus = async (req, res) => {
  const records = await SaleTransaction.find({
    clientTransactionId: { $in: req.body.clientTransactionIds },
    cashier: req.user.id,
  })
    .select('clientTransactionId transactionNumber status createdAt offlineSync')
    .lean();

  return res.json({
    success: true,
    data: records.map((record) => ({
      clientTransactionId: record.clientTransactionId,
      transactionId: record._id,
      transactionNumber: record.transactionNumber,
      status: record.status,
      createdAt: record.createdAt,
      queuedAt: record.offlineSync?.queuedAt || null,
    })),
  });
};

// ── getHeldOrders ──────────────────────────────────────────────────────────────
// GET /api/pos/held-orders/:outletId
// Auth: cashier JWT

export const getHeldOrders = async (req, res) => {
  // Derive the outlet from the authenticated user/session. The route keeps its
  // legacy outlet parameter for compatibility, but it is never trusted for
  // authorization or query scope.
  const outletObjectId = await resolvePosOutletId(req.user);
  if (!outletObjectId) {
    return res.status(422).json({
      success: false,
      message: 'No outlet is available. Assign an outlet or open a POS session first.',
    });
  }

  const orders = await SaleTransaction.find({
    outlet: outletObjectId,
    status: 'held',
    $or: [
      { source: { $ne: 'qr-self-order' } },
      { 'qrOrder.pendingAddOn.items.0': { $exists: false } },
    ],
  })
    .populate('customer', 'name phone email addresses')
    .populate('cashier', 'name email')
    .populate('assignedRider', 'name phone designation')
    .populate('assignedRiderUser', 'name email role')
    .sort({ heldAt: -1 })
    .lean();

  const kdsEnabled = await isKdsEnabled(outletObjectId, req.tenant);
  const [outletClock, printJobs, kdsOrders] = await Promise.all([
    Outlet.findById(outletObjectId)
      .select('timezone businessDayStart businessDayEnd')
      .lean(),
    PrintJob.find({ order: { $in: orders.map((order) => order._id) } })
      .select('order status')
      .lean(),
    kdsEnabled
      ? KdsOrder.find({
        outlet: outletObjectId,
        $or: [
          { originalSaleTransaction: { $in: orders.map((order) => order._id) } },
          { currentStatus: 'dispatched', cashierAcknowledgedAt: null },
        ],
      })
        .select('saleTransaction originalSaleTransaction finalSaleTransaction finalTransactionNumber ticketNumber businessDate source orderType tableNumber customerName customerPhone deliveryAddress cashier cashierName assignedRider assignedRiderUser assignedRiderName items totalAmount punchedAt sentToKitchenAt currentStatus acceptedAt prepStartedAt kitchenDispatchedAt cashierAcknowledgedAt lifecycle.type')
        .lean()
      : Promise.resolve([]),
  ]);
  const kdsByOrder = new Map(kdsOrders.map((order) => [String(order.originalSaleTransaction), kdsCancellationState(order)]));
  const printJobsByOrder = new Map();
  for (const job of printJobs) {
    const key = String(job.order);
    if (!printJobsByOrder.has(key)) printJobsByOrder.set(key, []);
    printJobsByOrder.get(key).push(job);
  }
  const timezone = outletClock?.timezone || DEFAULT_TZ;
  const businessDayStart = outletClock?.businessDayStart || '00:00';
  const businessDayEnd = outletClock?.businessDayEnd || businessDayStart;
  const currentBusinessDate = getBusinessDate(new Date(), timezone, businessDayStart, businessDayEnd);
  const rows = orders.map((order) => {
    const orderBusinessDate = order.businessDate || getBusinessDate(
      order.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    const orderPrintJobs = printJobsByOrder.get(String(order._id)) || [];
    const kitchenPrintStatus = (!order.kitchenPrintedAt && !order.kitchenPrintQueuedAt)
      ? null
      : orderPrintJobs.length === 0
      ? null
      : orderPrintJobs.every((job) => job.status === 'printed')
        ? 'printed'
        : orderPrintJobs.some((job) => job.status === 'failed')
          ? 'failed'
          : orderPrintJobs.some((job) => job.status === 'claimed')
            ? 'sending'
            : 'queued';
    return {
      ...order,
      assignedRider: order.assignedRiderUser || order.assignedRider || null,
      kds: kdsByOrder.get(String(order._id)) || null,
      businessDate: orderBusinessDate,
      isCurrentBusinessDay: orderBusinessDate === currentBusinessDate,
      kitchenPrintStatus,
    };
  });

  // A customer can pay before the kitchen finishes. The temporary held row is
  // removed at payment, but its ready notification must remain actionable on
  // the Held tab until the cashier acknowledges it.
  const heldIds = new Set(orders.map((order) => String(order._id)));
  for (const kds of kdsOrders) {
    if (kds.currentStatus !== 'dispatched' || kds.cashierAcknowledgedAt
      || heldIds.has(String(kds.originalSaleTransaction))) continue;
    const orderBusinessDate = kds.businessDate || getBusinessDate(
      kds.punchedAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    rows.push({
      _id: `kds-ready-${kds._id}`,
      readyOnly: true,
      status: 'completed',
      source: kds.source,
      transactionNumber: kds.finalTransactionNumber || kds.ticketNumber,
      orderType: kds.orderType,
      tableNumber: kds.tableNumber,
      customer: kds.customerName || kds.customerPhone
        ? { name: kds.customerName, phone: kds.customerPhone }
        : null,
      foodPandaCustomerName: kds.customerName || '',
      cashier: kds.cashier ? { _id: kds.cashier, name: kds.cashierName } : null,
      deliveryAddress: kds.deliveryAddress,
      assignedRider: kds.assignedRider
        ? { _id: kds.assignedRider, name: kds.assignedRiderName }
        : kds.assignedRiderUser
          ? { _id: kds.assignedRiderUser, name: kds.assignedRiderName, role: 'rider' }
        : null,
      items: kds.items || [],
      totalAmount: kds.totalAmount,
      heldAt: kds.punchedAt,
      businessDate: orderBusinessDate,
      isCurrentBusinessDay: orderBusinessDate === currentBusinessDate,
      kds,
    });
  }

  return res.json({ success: true, data: rows });
};

// ── getMyTransactions ─────────────────────────────────────────────────────────
// GET /api/pos/transactions/me
// Query: page, limit, status, from, to, search, cashier, orderType,
// paymentMethod, source, praStatus, discountState, wasteState, minAmount,
// maxAmount, tableNumber, sort
// Auth: cashier JWT — strictly scoped to the requesting cashier's outlet.
//
// The outlet is resolved exclusively from the authenticated user. A caller
// cannot request another outlet by crafting query parameters.

export const getMyTransactions = async (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.page ?? 1, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.limit ?? 25, 10)));
  const skip = (pageNum - 1) * pageSize;

  let outletId = req.user.outletRef;
  if (!outletId && req.user.outletCode) {
    const outlet = await Outlet.findOne({ code: req.user.outletCode }).select('_id').lean();
    outletId = outlet?._id;
  }
  // Owners/managers do not have a permanently assigned outlet. In the POS they
  // choose one while opening a session, so use that session as the authoritative
  // fallback instead of accepting an outlet id from the client.
  if (!outletId) {
    const currentSession = await SaleSession.findOne({
      cashier: req.user.id,
      status: 'open',
    }).select('outlet').lean();
    outletId = currentSession?.outlet;
  }
  if (!outletId) {
    return res.status(422).json({
      success: false,
      message: 'No outlet is available. Assign an outlet or open a POS session first.',
    });
  }

  const outletClock = await Outlet.findById(outletId)
    .select('timezone businessDayStart businessDayEnd')
    .lean();
  const timezone = outletClock?.timezone || DEFAULT_TZ;
  const businessDayStart = outletClock?.businessDayStart || '00:00';
  const businessDayEnd = outletClock?.businessDayEnd || businessDayStart;
  const currentBusinessDate = getBusinessDate(new Date(), timezone, businessDayStart, businessDayEnd);
  const requestedFrom = req.query.from ? String(req.query.from).slice(0, 10) : '';
  const requestedTo = req.query.to ? String(req.query.to).slice(0, 10) : '';
  const effectiveFrom = requestedFrom || requestedTo || currentBusinessDate;
  const effectiveTo = requestedTo || effectiveFrom;

  const filter = { outlet: new mongoose.Types.ObjectId(outletId) };
  if (req.query.cashier) {
    if (!mongoose.Types.ObjectId.isValid(req.query.cashier)) {
      return res.status(400).json({ success: false, message: 'Invalid cashier filter.' });
    }
    filter.cashier = new mongoose.Types.ObjectId(req.query.cashier);
  }

  // Outlet history also acts as the complete live order ledger. Include held
  // drafts and dispatched/unpaid deliveries alongside terminal statuses.
  if (req.query.status) {
    filter.status = req.query.status;
  } else {
    filter.status = { $in: ['held', 'out-for-delivery', 'completed', 'refunded', 'void'] };
  }

  if (req.query.orderType) filter.orderType = req.query.orderType;
  if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
  if (req.query.source) filter.source = req.query.source;
  if (req.query.praStatus) filter['pra.status'] = req.query.praStatus;
  if (req.query.discountState === 'with-discount') filter.discountAmount = { $gt: 0 };
  if (req.query.discountState === 'without-discount') filter.discountAmount = { $lte: 0 };
  if (req.query.wasteState === 'fully-wasted') filter.isVoidedAsWaste = true;
  if (req.query.wasteState === 'partially-wasted') filter.partiallyWasted = true;
  if (req.query.wasteState === 'not-wasted') {
    filter.isVoidedAsWaste = { $ne: true };
    filter.partiallyWasted = { $ne: true };
  }

  const minimumAmount = Number(req.query.minAmount);
  const maximumAmount = Number(req.query.maxAmount);
  if (req.query.minAmount !== undefined && req.query.minAmount !== '' && Number.isFinite(minimumAmount)) {
    filter.totalAmount = { ...(filter.totalAmount || {}), $gte: minimumAmount };
  }
  if (req.query.maxAmount !== undefined && req.query.maxAmount !== '' && Number.isFinite(maximumAmount)) {
    filter.totalAmount = { ...(filter.totalAmount || {}), $lte: maximumAmount };
  }
  if (req.query.tableNumber) {
    const safeTable = String(req.query.tableNumber).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (safeTable) filter.tableNumber = { $regex: safeTable, $options: 'i' };
  }

  // A blank date filter means the outlet's current BUSINESS day, not the
  // server/browser calendar day. The createdAt fallback keeps pre-businessDate
  // transactions visible using the same local cutoff.
  const [startHour, startMinute] = businessDayStart.split(':').map(Number);
  const legacyStart = startOfLocalDayUtc(effectiveFrom, timezone);
  legacyStart.setUTCMinutes(legacyStart.getUTCMinutes() + (startHour * 60) + startMinute);
  const dayAfterTo = new Date(`${effectiveTo}T00:00:00.000Z`);
  dayAfterTo.setUTCDate(dayAfterTo.getUTCDate() + 1);
  const nextDateKey = dayAfterTo.toISOString().slice(0, 10);
  const legacyEnd = startOfLocalDayUtc(nextDateKey, timezone);
  legacyEnd.setUTCMinutes(legacyEnd.getUTCMinutes() + (startHour * 60) + startMinute);
  legacyEnd.setTime(legacyEnd.getTime() - 1);
  filter.$and = [{
    $or: [
      { businessDate: businessDateRange(effectiveFrom, effectiveTo) },
      { businessDate: { $exists: false }, createdAt: { $gte: legacyStart, $lte: legacyEnd } },
    ],
  }];

  if (req.query.search) {
    // Search by transaction number prefix or note substring (cheap, no
    // full-text index needed for this volume).
    const q = String(req.query.search).trim();
    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$and = filter.$and || [];
      filter.$and.push({ $or: [
        { transactionNumber: { $regex: safe, $options: 'i' } },
        { notes: { $regex: safe, $options: 'i' } },
      ] });
    }
  }

  const cashierListFilter = {
    outlet: filter.outlet,
    status: { $in: ['held', 'out-for-delivery', 'completed', 'refunded', 'void'] },
    cashier: { $ne: null },
  };
  const summaryBaseFilter = { ...filter };
  delete summaryBaseFilter.status;
  const completedFilter = { ...summaryBaseFilter, status: 'completed' };
  const awaitingFilter = { ...summaryBaseFilter, status: { $in: ['held', 'out-for-delivery'] } };
  const allOrderFilter = {
    ...summaryBaseFilter,
    status: { $in: ['held', 'out-for-delivery', 'completed', 'refunded', 'void'] },
  };
  const transactionSort = {
    oldest: { createdAt: 1, _id: 1 },
    amountHigh: { totalAmount: -1, createdAt: -1 },
    amountLow: { totalAmount: 1, createdAt: -1 },
  }[req.query.sort] || { createdAt: -1, _id: -1 };

  const [transactions, total, cashierIds, summaryRows, awaitingRows, totalOrders] = await Promise.all([
    SaleTransaction.find(filter)
      .sort(transactionSort)
      .skip(skip)
      .limit(pageSize)
      .populate('customer', 'name phone')
      .populate('assignedRider', 'name phone designation')
      .populate('assignedRiderUser', 'name email role')
      .populate('session', 'sessionNumber')
      .populate('cashier', 'name email')
      .populate('voidedBy', 'name email')
      .populate('chargeToSalaryEmployee', 'name designation department')
      .lean(),
    SaleTransaction.countDocuments(filter),
    SaleTransaction.distinct('cashier', cashierListFilter),
    SaleTransaction.aggregate([
      { $match: completedFilter },
      { $project: {
        total: { $ifNull: ['$totalAmount', 0] },
        subtotal: { $ifNull: ['$subtotal', 0] },
        tax: { $ifNull: ['$taxAmount', 0] },
        service: { $ifNull: ['$serviceChargeAmount', 0] },
        delivery: { $ifNull: ['$deliveryChargeAmount', 0] },
        discount: { $ifNull: ['$discountAmount', 0] },
        redemption: { $ifNull: ['$pointsRedeemedValue', 0] },
        paymentMethod: 1,
        cashAmount: { $ifNull: ['$cashAmount', 0] },
        cardAmount: { $ifNull: ['$cardAmount', 0] },
        onlineTransferAmount: { $ifNull: ['$onlineTransferAmount', 0] },
        foodPandaAmount: { $ifNull: ['$foodPandaAmount', 0] },
        itemCount: { $sum: { $map: { input: { $ifNull: ['$items', []] }, as: 'item', in: { $ifNull: ['$$item.qty', 0] } } } },
      } },
      { $addFields: {
        totalDiscount: { $add: ['$discount', '$redemption'] },
        grossSales: {
          $cond: [
            { $gt: ['$subtotal', 0] },
            '$subtotal',
            {
              $max: [0, {
                $add: [
                  { $subtract: ['$total', { $add: ['$tax', '$service', '$delivery'] }] },
                  '$discount',
                  '$redemption',
                ],
              }],
            },
          ],
        },
      } },
      { $addFields: {
        salesExcludingServiceCharges: { $max: [0, { $subtract: ['$total', '$service'] }] },
      } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        gross: { $sum: '$grossSales' },
        serviceCharge: { $sum: '$service' },
        deliveryCharge: { $sum: '$delivery' },
        net: { $sum: '$total' },
        salesExcludingServiceCharges: { $sum: '$salesExcludingServiceCharges' },
        collected: { $sum: '$total' },
        discounts: { $sum: '$totalDiscount' },
        tax: { $sum: '$tax' },
        items: { $sum: '$itemCount' },
        cash: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$total', { $cond: [{ $in: ['$paymentMethod', ['split', 'split-bill']] }, '$cashAmount', 0] }] } },
        card: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$total', { $cond: [{ $in: ['$paymentMethod', ['split', 'split-bill']] }, '$cardAmount', 0] }] } },
        online: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'online-transfer'] }, { $cond: [{ $gt: ['$onlineTransferAmount', 0] }, '$onlineTransferAmount', '$total'] }, { $cond: [{ $in: ['$paymentMethod', ['split', 'split-bill']] }, '$onlineTransferAmount', 0] }] } },
        foodPanda: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'foodpanda'] }, { $cond: [{ $gt: ['$foodPandaAmount', 0] }, '$foodPandaAmount', '$total'] }, 0] } },
        foodPandaCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'foodpanda'] }, 1, 0] } },
        chargeToSalary: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'charge-to-salary'] }, '$total', 0] } },
        chargeToSalaryCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'charge-to-salary'] }, 1, 0] } },
        other: { $sum: { $cond: [
          { $in: ['$paymentMethod', ['cash', 'card', 'online-transfer', 'foodpanda', 'charge-to-salary']] },
          0,
          { $cond: [
            { $in: ['$paymentMethod', ['split', 'split-bill']] },
            { $max: [0, { $subtract: ['$total', { $add: ['$cashAmount', '$cardAmount', '$onlineTransferAmount'] }] }] },
            '$total',
          ] },
        ] } },
      } },
    ]),
    SaleTransaction.aggregate([
      { $match: awaitingFilter },
      { $group: {
        _id: null,
        awaitingPayments: { $sum: { $ifNull: ['$totalAmount', 0] } },
        awaitingCount: { $sum: 1 },
      } },
    ]),
    SaleTransaction.countDocuments(allOrderFilter),
  ]);

  const cashiers = await User.find({ _id: { $in: cashierIds } })
    .select('name email')
    .sort({ name: 1, email: 1 })
    .lean();

  // Mark each result against the outlet's current business date so the POS can
  // explain why historical orders are read-only. Derive legacy rows from their
  // creation instant when the persisted businessDate field is absent.
  const cancellationStates = await getSalesKdsCancellationStates(transactions, outletId, req.tenant || req.user?.tenantSlug);
  const transactionRows = transactions.map((transaction) => {
    const transactionBusinessDate = transaction.businessDate || getBusinessDate(
      transaction.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    return {
      ...transaction,
      kds: cancellationStates.get(String(transaction._id)) || null,
      businessDate: transactionBusinessDate,
      isCurrentBusinessDay: transactionBusinessDate === currentBusinessDate,
    };
  });

  return res.json({
    success: true,
    data: transactionRows,
    pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
    cashiers,
    summary: {
      ...(summaryRows[0] || {
        count: 0, gross: 0, serviceCharge: 0, tax: 0, deliveryCharge: 0,
        discounts: 0, net: 0, salesExcludingServiceCharges: 0, collected: 0,
        items: 0, cash: 0, card: 0, online: 0, foodPanda: 0,
        foodPandaCount: 0, chargeToSalary: 0, chargeToSalaryCount: 0, other: 0,
      }),
      invoices: summaryRows[0]?.count || 0,
      grossSales: summaryRows[0]?.gross || 0,
      salesTax: summaryRows[0]?.tax || 0,
      discount: summaryRows[0]?.discounts || 0,
      netSales: summaryRows[0]?.net || 0,
      average: summaryRows[0]?.count ? summaryRows[0].net / summaryRows[0].count : 0,
      awaitingPayments: awaitingRows[0]?.awaitingPayments || 0,
      awaitingCount: awaitingRows[0]?.awaitingCount || 0,
      heldOrdersTotal: awaitingRows[0]?.awaitingPayments || 0,
      heldOrdersCount: awaitingRows[0]?.awaitingCount || 0,
      totalOrders,
      businessDate: currentBusinessDate,
      dateFrom: effectiveFrom,
      dateTo: effectiveTo,
    },
  });
};

// ── getPosWastePreview ───────────────────────────────────────────────────────
// GET /api/pos/transactions/:id/waste-preview
//
// Returns aggregate ingredient cost and allocated order value for every
// remaining line. Ingredient recipes themselves are never exposed to the POS;
// locked recipes therefore remain private while the cashier can still choose a
// valid waste valuation.
export const getPosWastePreview = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
  }

  const transaction = await SaleTransaction.findById(id);
  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }
  if (!['held', 'completed', 'out-for-delivery'].includes(transaction.status)) {
    return res.status(409).json({ success: false, message: 'Only held, completed or out-for-delivery orders can be previewed for waste.' });
  }
  if (!(await requireSamePosOutlet(req.user, transaction.outlet))) {
    return res.status(403).json({ success: false, message: 'This order belongs to another outlet.' });
  }
  // Paid-order waste remains cashier-owned. Held orders are outlet-shared and
  // may be cancelled by another authorised cashier at the same terminal.
  if (
    !req.kdsCancellation
    && transaction.status === 'completed'
    && transaction.cashier?.toString() !== req.user.id.toString()
  ) {
    return res.status(403).json({ success: false, message: 'You can only preview waste for your own completed orders.' });
  }
  if (transaction.isVoidedAsWaste) {
    return res.status(409).json({ success: false, message: 'This order has already been fully logged as waste.' });
  }

  let preview;
  try {
    preview = await previewSaleWaste({ transaction, selection: null });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    throw err;
  }

  const items = preview.breakdown.map((item, position) => ({
    index: preview.sourceIndexes[position],
    name: item.name,
    variation: item.variation,
    qty: item.qty,
    remainingQty: item.qty,
    unitPrice: item.unitPrice,
    ingredientCost: item.ingredientCost,
    orderValue: preview.selectedLines[position]?.orderValue ?? 0,
    usingFallback: item.usingFallback,
  }));

  return res.json({
    success: true,
    data: {
      transactionId: transaction._id,
      transactionNumber: transaction.transactionNumber,
      status: transaction.status,
      saleTotal: transaction.totalAmount,
      ingredientCost: preview.recipeCost,
      orderValue: preview.orderValue,
      items,
    },
  });
};

// ── logMyTransactionAsWaste ─────────────────────────────────────────────────────
// POST /api/pos/transactions/:id/waste
// Body: { reason?, notes?, rePrepare? }  — rePrepare re-deducts stock for a re-cook
// Auth: cashier JWT (own completed transaction only)
//
// Lets a cashier mark one of their own completed orders as waste from the POS
// order-history tab — for when they don't have management access. Uses the exact
// same shared logic as the management waste log, so the accounts impact is
// identical (reclassify recipe cost from Purchase Expense → Waste & Spoilage).

export const logMyTransactionAsWaste = async (req, res) => {
  const { id } = req.params;
  const { reason = 'orderVoid', notes } = req.body;
  const rePrepare = req.body.rePrepare === true || req.body.rePrepare === 'true';
  const selection = Array.isArray(req.body.selection) ? req.body.selection : null;
  const valuationMethod = req.body.valuationMethod ?? 'ingredientCost';
  const requirePositiveValue = req.body.valuationMethod != null;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
  }

  const transaction = await SaleTransaction.findById(id);
  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }
  // A cashier may only waste their OWN orders (order history is cashier-scoped).
  if (transaction.cashier?.toString() !== req.user.id.toString()) {
    return res.status(403).json({ success: false, message: 'You can only waste your own orders.' });
  }
  const isManager = ['owner', 'financeManager'].includes(req.user.role);
  if (!isManager) {
    const outletClock = transaction.outlet
      ? await Outlet.findById(transaction.outlet)
        .select('timezone businessDayStart businessDayEnd')
        .lean()
      : null;
    if (!outletClock) {
      return res.status(409).json({
        success: false,
        message: 'This order’s business day could not be verified, so a cashier cannot log it as waste.',
      });
    }
    const timezone = outletClock.timezone || DEFAULT_TZ;
    const businessDayStart = outletClock.businessDayStart || '00:00';
    const businessDayEnd = outletClock.businessDayEnd || businessDayStart;
    const currentBusinessDate = getBusinessDate(new Date(), timezone, businessDayStart, businessDayEnd);
    const transactionBusinessDate = transaction.businessDate || getBusinessDate(
      transaction.createdAt,
      timezone,
      businessDayStart,
      businessDayEnd,
    );
    if (transactionBusinessDate !== currentBusinessDate) {
      return res.status(409).json({
        success: false,
        message: `Cashiers cannot log waste against orders from a past business day (${transactionBusinessDate}). Ask an owner or finance manager.`,
      });
    }
  }
  if (transaction.status !== 'completed') {
    return res.status(400).json({ success: false, message: 'Only completed orders can be marked as waste.' });
  }
  if (transaction.isVoidedAsWaste) {
    return res.status(409).json({ success: false, message: 'This order has already been fully logged as waste.' });
  }

  let result;
  try {
    result = await logSaleAsWaste({
      transaction,
      reason,
      notes,
      userId: req.user.id,
      rePrepare,
      selection,
      valuationMethod,
      requirePositiveValue,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    throw err;
  }
  const { wasteLog, journalEntry } = result;

  await AuditLog.create({
    user: req.user.id,
    action: 'pos_order_wasted',
    module: 'pos',
    recordId: transaction._id,
    after: {
      transactionNumber: transaction.transactionNumber,
      wasteLog: wasteLog._id,
      totalCost: wasteLog.totalCost,
      valuationMethod: result.valuationMethod,
      ingredientCost: result.recipeCost,
      orderValue: result.orderValue,
      rePrepared: wasteLog.rePrepared,
      partial: wasteLog.partial,
    },
    ip: req.ip,
  });

  logger.info(`Order logged as waste from POS: ${transaction.transactionNumber} (${result.partial ? 'partial' : 'whole'}) by ${req.user.email}`);

  return res.status(201).json({
    success: true,
    message: rePrepare ? 'Order logged as waste and re-prepared (stock re-deducted).' : 'Order logged as waste.',
    data: {
      wasteLogId: wasteLog._id,
      journalEntryId: journalEntry?._id ?? null,
      transactionId: transaction._id,
      rePrepared: wasteLog.rePrepared,
      partial: result.partial,
      fullyWasted: result.fullyWasted,
      partiallyWasted: result.partiallyWasted,
      valuationMethod: result.valuationMethod,
      wasteValue: result.wasteValue,
      ingredientCost: result.recipeCost,
      orderValue: result.orderValue,
    },
  });
};

// ── getTransactionsBySession ───────────────────────────────────────────────────
// GET /api/pos/transactions/:sessionId
// Query: page, limit
// Auth: cashier, owner, financeManager

export const getTransactionsBySession = async (req, res) => {
  const { sessionId } = req.params;
  const pageNum = Math.max(1, parseInt(req.query.page ?? 1, 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.limit ?? 50, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {
    session: new mongoose.Types.ObjectId(sessionId),
    status: { $in: ['completed', 'refunded', 'void'] },
  };

  const [transactions, total] = await Promise.all([
    SaleTransaction.find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(pageSize)
      .populate('chargeToSalaryEmployee', 'name designation department')
      .lean(),
    SaleTransaction.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: transactions,
    pagination: { total, page: pageNum, limit: pageSize, pages: Math.ceil(total / pageSize) },
  });
};

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Reverses recipe-driven inventory depletion for all tracked items in a
 * transaction. Rebuilds the same deduction plan used at sale time (so unit
 * conversions match) and increments each StockItem back by the converted
 * quantity. Also rolls back the expectedUsage we recorded for the day.
 */
const _reverseInventory = async (transaction) => {
  if (!transaction.items?.length) return;

  const menuItemIds = transaction.items.flatMap((item) => [
    item.menuItem,
    ...(item.dealComponents || []).map((component) => component.menuItem),
  ]).filter(Boolean);
  if (!menuItemIds.length) return;

  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds } })
    .select('name trackInventory ingredients variations')
    .populate('ingredients.product', 'name unit')
    .populate('variations.ingredients.product', 'name unit')
    .lean();

  const outlet = await Outlet.findById(transaction.outlet).select('_id code').lean();
  if (!outlet?._id) return;
  const outletId = outlet._id;

  // Reconstruct the enriched-item shape that _buildRecipeDeductionPlan expects,
  // resolving the SAME recipe that was deducted at sale time — the stored
  // variation's recipe when a size was sold, otherwise the item recipe.
  const enriched = transaction.items
    .map((txnItem) => {
      const mi = menuItems.find((m) => m._id.toString() === txnItem.menuItem?.toString());
      if (txnItem.dealComponents?.length) {
        const resolvedComponents = txnItem.dealComponents.map((component) => {
          const componentItem = menuItems.find((candidate) => (
            candidate._id.toString() === component.menuItem?.toString()
          ));
          if (!componentItem?.trackInventory) return null;
          let componentIngredients = componentItem.ingredients ?? [];
          if (component.variation?.id) {
            const selectedVariation = (componentItem.variations || []).find((candidate) => (
              candidate._id.toString() === component.variation.id.toString()
            ));
            componentIngredients = selectedVariation?.ingredients ?? [];
          }
          return {
            _trackInventory: true,
            _menuItemFull: componentItem,
            _recipeIngredients: componentIngredients,
            qtyPerDeal: component.qtyPerDeal,
            name: component.name,
          };
        }).filter(Boolean);
        if (!resolvedComponents.length) return null;
        return {
          _trackInventory: true,
          _dealComponents: resolvedComponents,
          menuItem: txnItem.menuItem,
          name: txnItem.name,
          qty: txnItem.qty,
        };
      }
      if (!mi?.trackInventory) return null;
      let recipeIngredients = mi.ingredients ?? [];
      if (txnItem.variation?.id) {
        const v = (mi.variations || []).find((x) => x._id.toString() === txnItem.variation.id.toString());
        recipeIngredients = v?.ingredients ?? [];
      }
      return {
        _trackInventory: true,
        _menuItemFull: mi,
        _recipeIngredients: recipeIngredients,
        menuItem: mi._id,
        name: mi.name,
        qty: txnItem.qty,
      };
    })
    .filter(Boolean);

  if (!enriched.length) return;

  const plan = await _buildRecipeDeductionPlan(enriched);

  // Restore to the KITCHEN — mirrors the sale-time deduction's area filter.
  const restored = [];
  for (const d of plan) {
    const matched = await StockItem.findOneAndUpdate(
      { product: d.productId, outlet: outletId, area: 'kitchen' },
      { $inc: { qtyOnHand: d.qtyInStockUnit } }
    );
    if (matched) restored.push({ productId: d.productId, qty: d.qtyInStockUnit, unit: d.stockUnit });
  }

  // Ledger: compensating 'reversal' rows (kitchen, +qty) for the void/refund.
  if (restored.length) {
    const costMap = new Map();
    try {
      const costDocs = await Product.find({ _id: { $in: restored.map((r) => r.productId) } })
        .select('currentPrice').lean();
      costDocs.forEach((p) => costMap.set(p._id.toString(), p.currentPrice || 0));
    } catch { /* movement cost is best-effort */ }

    await recordStockMovements(restored.map((r) => ({
      product:  r.productId,
      outlet:   outletId,
      area:     'kitchen',
      qty:      r.qty,
      unit:     r.unit,
      type:     'reversal',
      unitCost: costMap.get(r.productId.toString()) || 0,
      ref:      { kind: 'saleTransaction', id: transaction._id },
      user:     transaction.cashier,
    })));
  }

  // Reverse the expected-usage log entry for today (best-effort only; if the
  // sale crosses a day boundary the original day's log will be slightly off,
  // but variance reports are not transactional). "Today" is the outlet-local
  // calendar day, matching how the entry was bucketed at sale time.
  const tz = await resolveTimezone(outlet?._id ?? outlet?.code);
  const day = startOfLocalDayUtc(localDateStr(new Date(), tz), tz);
  for (const d of plan) {
    try {
      await IngredientUsageLog.findOneAndUpdate(
        { product: d.productId, outlet: outletId, date: day },
        { $inc: { expectedUsage: -d.qtyInStockUnit } }
      );
    } catch (err) {
      logger.warn(`[SALE] Failed to reverse expectedUsage for product ${d.productId}: ${err.message}`);
    }
  }
};
