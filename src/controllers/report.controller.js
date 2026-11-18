/**
 * report.controller.js
 *
 * All aggregations use MongoDB pipeline stages only.
 * No full arrays are pulled into memory.
 */
import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import Purchase from '../models/Purchase.js';
import Payment from '../models/Payment.js';
import StockItem from '../models/StockItem.js';
import Product from '../models/Product.js';
import WasteLog from '../models/WasteLog.js';
import SaleTransaction from '../models/SaleTransaction.js';
import AuditLog from '../models/AuditLog.js';
import MenuItem from '../models/MenuItem.js';
import User from '../models/User.js';
import Customer from '../models/Customer.js';
import Employee from '../models/Employee.js';
import { convertQty, ingredientCostValue } from '../services/saleWaste.service.js';
import { hasValidUnlock } from '../utils/recipeLock.js';
import {
  resolveOutletClock,
  resolveTimezone,
  localDateRange,
} from '../utils/timezone.js';
import { businessDateRange, getBusinessDate } from '../utils/businessDate.js';
import { cancellationReportDateMatch, itemCancellationAuditToReportRow, withOrderPreparationDetails } from '../utils/itemCancellationReport.js';

// ─── Date-range helpers ───────────────────────────────────────────────────────
// Date bucketing follows the OUTLET's timezone (see ../utils/timezone.js).
// Timestamps remain stored in UTC; only interpretation/bucketing is localised.

const r2 = (n) => parseFloat((n ?? 0).toFixed(2));

const applySalesDateFilter = (match, from, to, legacyDateRange, clock) => {
  const tz = typeof clock === 'string' ? clock : clock.timezone;
  const today = !from && !to
    ? getBusinessDate(
      new Date(),
      tz,
      typeof clock === 'string' ? '00:00' : clock.businessDayStart,
      typeof clock === 'string' ? '00:00' : clock.businessDayEnd,
    )
    : null;
  const range = businessDateRange(from || today, to || today);
  match.$or = [
    { businessDate: range },
    { businessDate: { $exists: false }, createdAt: legacyDateRange },
  ];
};

const escapeSearchRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const flexibleOrderSearchRegex = (value) => {
  const tokens = String(value || '').trim().slice(0, 120).split(/[\s_-]+/).filter(Boolean);
  return new RegExp(tokens.map(escapeSearchRegex).join('[\\s_-]*'), 'i');
};

const orderSearchConditions = async (search) => {
  const text = String(search || '').trim();
  if (!text) return [];
  const regex = flexibleOrderSearchRegex(text);
  const [cashiers, customers, employees] = await Promise.all([
    User.find({ $or: [{ name: regex }, { email: regex }] }).select('_id').lean(),
    Customer.find({
      $or: [
        { name: regex }, { phone: regex }, { email: regex },
        { membershipCardNumber: regex }, { 'addresses.label': regex },
        { 'addresses.street': regex }, { 'addresses.area': regex }, { 'addresses.city': regex },
      ],
    }).select('_id').lean(),
    Employee.find({ $or: [{ name: regex }, { cnic: regex }, { designation: regex }] }).select('_id').lean(),
  ]);
  const numeric = Number(text.replaceAll(',', ''));
  const conditions = [
    { transactionNumber: regex }, { businessDate: regex }, { status: regex },
    { orderType: regex }, { paymentMethod: regex }, { source: regex },
    { tableNumber: regex }, { notes: regex }, { refundReason: regex }, { voidReason: regex },
    { cardLast4: regex }, { onlineTransferReference: regex },
    { foodPandaOrderNumber: regex }, { foodPandaReference: regex }, { foodPandaCustomerName: regex },
    { allowanceSubjectName: regex }, { chargeToSalaryEmployeeName: regex },
    { 'ctsCorrection.reason': regex },
    { 'items.name': regex }, { 'items.variation.name': regex },
    { 'qrOrder.tableCode': regex }, { 'qrOrder.tableLabel': regex },
    { 'qrOrder.customerName': regex }, { 'qrOrder.customerPhone': regex },
    { 'deliveryAddress.label': regex }, { 'deliveryAddress.street': regex },
    { 'deliveryAddress.area': regex }, { 'deliveryAddress.city': regex },
    { 'pra.invoiceNumber': regex }, { 'pra.status': regex },
    { 'splitBill.parts.cardReference': regex }, { 'splitBill.parts.note': regex },
    { cashier: { $in: cashiers.map((item) => item._id) } },
    { customer: { $in: customers.map((item) => item._id) } },
    { assignedRider: { $in: employees.map((item) => item._id) } },
    { chargeToSalaryEmployee: { $in: employees.map((item) => item._id) } },
  ];
  if (Number.isFinite(numeric)) {
    conditions.push(
      { subtotal: numeric }, { taxAmount: numeric }, { serviceChargeAmount: numeric },
      { deliveryChargeAmount: numeric }, { discountAmount: numeric }, { totalAmount: numeric },
      { cashAmount: numeric }, { cardAmount: numeric }, { onlineTransferAmount: numeric },
      { cashTendered: numeric }, { changeGiven: numeric }, { pointsEarned: numeric },
      { pointsRedeemed: numeric }, { 'items.qty': numeric }, { 'items.unitPrice': numeric },
      { 'items.lineTotal': numeric }, { 'items.discountAmount': numeric },
      { 'ctsCorrection.originalAmount': numeric }, { 'ctsCorrection.correctedAmount': numeric },
    );
  }
  return conditions;
};

const applyOrderSearch = async (match, search) => {
  const conditions = await orderSearchConditions(search);
  if (!conditions.length) return;
  // applySalesDateFilter uses $or for persisted businessDate vs legacy rows.
  // Preserve that date condition and AND it with the broad order search.
  if (match.$or) {
    const dateConditions = match.$or;
    delete match.$or;
    match.$and = [...(match.$and || []), { $or: dateConditions }, { $or: conditions }];
  } else {
    match.$or = conditions;
  }
};

const reportingDateExpression = (tz) => ({
  $dateFromString: {
    dateString: {
      $ifNull: ['$businessDate', { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }],
    },
  },
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/reports/dashboard — enriched stats for the premium dashboard.
// Accessible to any authenticated user (no finance-only restriction).
// The response includes permission-gated sections so the frontend can render
// only what the current user is allowed to see.
export const getDashboardStats = async (req, res) => {
  if (req.user && typeof req.user.hasPermission === 'function') {
    const allowed = req.user.hasPermission('dashboard.view');
    if (!allowed) return res.status(403).json({ success: false, message: 'Forbidden.' });
  }

  // Use the selected outlet's operating clock (or the tenant's primary outlet).
  // Sales already persist `businessDate`; matching that value prevents midnight
  // from splitting an outlet's still-open operating day.
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dashboardOutlet = req.query.outlet && mongoose.isValidObjectId(req.query.outlet)
    ? new mongoose.Types.ObjectId(req.query.outlet)
    : null;
  const todayStr = getBusinessDate(
    new Date(),
    tz,
    clock.businessDayStart,
    clock.businessDayEnd,
  );

  // Legacy rows without businessDate fall back to this calendar-day range.
  const todayRange = localDateRange(todayStr, todayStr, tz);
  const todayStart = todayRange.$gte;
  const todayEnd = todayRange.$lte;

  // Month range — first day of the current local month through end of its last
  // local day, all in the outlet timezone.
  const monthStr = todayStr.slice(0, 7); // 'YYYY-MM'
  const monthStartRange = localDateRange(`${monthStr}-01`, undefined, tz);
  const monthStart = monthStartRange.$gte;
  // Last local day of the month: jump to the 28th+ and let the date math land on
  // the final calendar day in tz, then take its end-of-day.
  const [my, mm] = monthStr.split('-').map(Number);
  const lastDay = new Date(Date.UTC(my, mm, 0)).getUTCDate(); // mm is 1-based → day 0 of next = last day
  const monthEndStr = `${monthStr}-${String(lastDay).padStart(2, '0')}`;
  const monthEnd = localDateRange(undefined, monthEndStr, tz).$lte;

  // 7-day window for sales trend (last 6 local days through end of local today).
  const sevenDaysAgoStr = (() => {
    const [y, m, d] = todayStr.split('-').map(Number);
    const back = new Date(Date.UTC(y, m - 1, d) - 6 * 24 * 60 * 60 * 1000);
    return back.toISOString().slice(0, 10);
  })();
  const sevenDaysAgo = localDateRange(sevenDaysAgoStr, undefined, tz).$gte;
  const todaySalesMatch = {
    status: 'completed',
    isRefund: false,
    ...(dashboardOutlet ? { outlet: dashboardOutlet } : {}),
  };
  applySalesDateFilter(todaySalesMatch, todayStr, todayStr, todayRange, clock);
  const trendSalesMatch = {
    status: 'completed',
    isRefund: false,
    ...(dashboardOutlet ? { outlet: dashboardOutlet } : {}),
  };
  applySalesDateFilter(
    trendSalesMatch,
    sevenDaysAgoStr,
    todayStr,
    { $gte: sevenDaysAgo, $lte: todayEnd },
    clock,
  );

  const belowParPipeline = (area, limit = null) => [
    { $match: { area } },
    { $group: { _id: '$product', totalQtyOnHand: { $sum: { $ifNull: ['$qtyOnHand', 0] } }, unitSamples: { $first: '$unit' } } },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'pd' } },
    { $unwind: '$pd' },
    { $addFields: {
      parLevel: { $ifNull: ['$pd.parLevel', 0] },
      belowPar: { $and: [
        { $gt: [{ $ifNull: ['$pd.parLevel', 0] }, 0] },
        { $lt: ['$totalQtyOnHand', { $ifNull: ['$pd.parLevel', 0] }] },
      ] },
    } },
    { $match: { belowPar: true } },
    { $project: { name: '$pd.name', qtyOnHand: '$totalQtyOnHand', parLevel: '$pd.parLevel', unit: { $ifNull: ['$unitSamples', '$pd.unit'] } } },
    { $sort: { qtyOnHand: 1 } },
    ...(limit ? [{ $limit: limit }] : []),
  ];

  const [
    openPOs,
    openPOsAmount,
    pendingInvoices,
    overdueInvoices,
    itemsBelowParRows,
    belowParItems,
    storeItemsBelowParRows,
    storeBelowParItems,
    todaySalesAgg,
    salesTrendAgg,
    monthlyWasteAgg,
    pendingInvoicesAmountAgg,
    overdueInvoicesAmountAgg,
    recentPaymentsAgg,
    totalOutstandingAgg,
  ] = await Promise.all([
    // PO counts — "open" = approved and not yet fully received (or cancelled):
    // approved (awaiting dispatch), sent (with vendor), partialReceived (some
    // goods still pending). received/cancelled are closed and excluded.
    Purchase.countDocuments({ deletedAt: null, status: { $in: ['draft', 'pendingApproval'] } }),
    Purchase.aggregate([
      { $match: { deletedAt: null, status: { $in: ['draft', 'pendingApproval'] } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),

    // Unified purchase/bill counts
    Purchase.countDocuments({ deletedAt: null, status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] } }),
    Purchase.countDocuments({
      deletedAt: null,
      status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] },
      dueDate: { $lt: todayStart },
    }),

    // Items below par count
    // Items below par count — aggregate qty across outlets per product
    StockItem.aggregate([
      { $match: { area: 'kitchen' } },
      {
        $group: {
          _id: '$product',
          totalQtyOnHand: { $sum: { $ifNull: ['$qtyOnHand', 0] } },
        },
      },
      {
        $lookup: {
          from: 'products', localField: '_id', foreignField: '_id', as: 'pd'
        },
      },
      { $unwind: '$pd' },
      {
        $addFields: {
          parLevel: { $ifNull: ['$pd.parLevel', 0] },
          belowPar: {
            $cond: {
              if: { $gt: [{ $ifNull: ['$pd.parLevel', 0] }, 0] },
              then: { $lt: ['$totalQtyOnHand', { $ifNull: ['$pd.parLevel', 0] }] },
              else: false,
            },
          },
        },
      },
      { $match: { belowPar: true } },
      { $count: 'total' },
    ]),

    // Top 5 below-par items (for dashboard widget)
    // Top 5 below-par items — aggregate qty across outlets per product
    StockItem.aggregate([
      { $match: { area: 'kitchen' } },
      {
        $group: {
          _id: '$product',
          totalQtyOnHand: { $sum: { $ifNull: ['$qtyOnHand', 0] } },
          unitSamples: { $first: '$unit' },
        },
      },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'pd' } },
      { $unwind: '$pd' },
      {
        $addFields: {
          parLevel: { $ifNull: ['$pd.parLevel', 0] },
          belowPar: {
            $cond: {
              if: { $gt: [{ $ifNull: ['$pd.parLevel', 0] }, 0] },
              then: { $lt: ['$totalQtyOnHand', { $ifNull: ['$pd.parLevel', 0] }] },
              else: false,
            },
          },
        },
      },
      { $match: { belowPar: true } },
      { $project: { name: '$pd.name', qtyOnHand: '$totalQtyOnHand', parLevel: '$pd.parLevel', unit: { $ifNull: ['$unitSamples', '$pd.unit'] } } },
      { $sort: { qtyOnHand: 1 } },
      { $limit: 5 },
    ]),

    StockItem.aggregate([...belowParPipeline('store'), { $count: 'total' }]),
    StockItem.aggregate(belowParPipeline('store', 5)),

    // Today's sales — only completed, non-refund sales (excludes held,
    // pending-approval, void, and unpaid out-for-delivery orders).
    SaleTransaction.aggregate([
      { $match: todaySalesMatch },
      { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]),

    // 7-day sales trend (only completed, non-refund sales)
    SaleTransaction.aggregate([
      { $match: trendSalesMatch },
      {
        $group: {
          _id: {
            $ifNull: [
              '$businessDate',
              { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
            ],
          },
          total: { $sum: '$totalAmount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // Monthly waste cost
    WasteLog.aggregate([
      { $match: { loggedAt: { $gte: monthStart, $lte: monthEnd } } },
      { $group: { _id: null, totalCost: { $sum: '$totalCost' }, count: { $sum: 1 } } },
    ]),

    // Pending invoices total amount (outstanding balance only)
    Purchase.aggregate([
      { $match: { deletedAt: null, status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: [{ $ifNull: ['$totalAmount', 0] }, { $ifNull: ['$amountPaid', 0] }] } } } },
    ]),

    // Overdue invoices total amount (outstanding balance only)
    Purchase.aggregate([
      { $match: {
        deletedAt: null,
        status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] },
        dueDate: { $lt: todayStart },
      } },
      { $group: { _id: null, total: { $sum: { $subtract: [{ $ifNull: ['$totalAmount', 0] }, { $ifNull: ['$amountPaid', 0] }] } } } },
    ]),

    // Recent payments this month (count + amount)
    Payment.aggregate([
      { $match: { paymentDate: { $gte: monthStart, $lte: monthEnd }, status: { $ne: 'reversed' } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    // Total outstanding (all unpaid invoices) — sum of (totalAmount - amountPaid)
    Purchase.aggregate([
      { $match: { deletedAt: null, status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: [{ $ifNull: ['$totalAmount', 0] }, { $ifNull: ['$amountPaid', 0] }] } } } },
    ]),
  ]);

  // (removed temporary debug checks)

  // Build the 7-day trend array (fill in missing days with 0). Day keys are the
  // outlet-local 'YYYY-MM-DD' buckets (matching the $dateToString timezone above).
  const trendByDate = Object.fromEntries(salesTrendAgg.map((r) => [r._id, { total: r.total, count: r.count }]));
  const salesTrend = [];
  const [ty, tm, td] = todayStr.split('-').map(Number);
  for (let i = 6; i >= 0; i--) {
    // Use UTC noon of the calendar date so the label never drifts across days.
    const dayUtc = new Date(Date.UTC(ty, tm - 1, td) - i * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
    const key = dayUtc.toISOString().slice(0, 10);
    const label = dayUtc.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
    salesTrend.push({ date: key, label, total: r2(trendByDate[key]?.total ?? 0), count: trendByDate[key]?.count ?? 0 });
  }

  return res.json({
    success: true,
    data: {
      businessDate: todayStr,
      businessTimezone: tz,
      businessDayStart: clock.businessDayStart,
      businessDayEnd: clock.businessDayEnd,

      // Purchase Orders
      openPOs: openPOs ?? 0,
      openPOsAmount: r2(openPOsAmount[0]?.total ?? 0),

      // Invoices
      pendingInvoices: pendingInvoices ?? 0,
      pendingInvoicesAmount: r2(pendingInvoicesAmountAgg[0]?.total ?? 0),
      overdueInvoices: overdueInvoices ?? 0,
      overdueInvoicesAmount: r2(overdueInvoicesAmountAgg[0]?.total ?? 0),
      totalOutstanding: r2(totalOutstandingAgg[0]?.total ?? 0),

      // Inventory
      itemsBelowPar: itemsBelowParRows[0]?.total ?? 0,
      belowParItems: belowParItems ?? [],
      storeItemsBelowPar: storeItemsBelowParRows[0]?.total ?? 0,
      storeBelowParItems: storeBelowParItems ?? [],

      // Sales
      todaySales: r2(todaySalesAgg[0]?.total ?? 0),
      todaySalesCount: todaySalesAgg[0]?.count ?? 0,
      salesTrend,

      // Waste
      monthlyWasteCost: r2(monthlyWasteAgg[0]?.totalCost ?? 0),
      monthlyWasteCount: monthlyWasteAgg[0]?.count ?? 0,

      // Payments
      monthlyPaymentsAmount: r2(recentPaymentsAgg[0]?.total ?? 0),
      monthlyPaymentsCount: recentPaymentsAgg[0]?.count ?? 0,
    },
  });

  // end getDashboardStats
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/cogs?from=&to=&outlet=
// ═══════════════════════════════════════════════════════════════════════════════

export const getCOGSReport = async (req, res) => {
  const { from, to, outlet } = req.query;
  const tz = await resolveTimezone(req.query.outlet);
  const dateRange = localDateRange(from, to, tz);
  const outletId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  // ── 1. Posted stock purchases → unwind lines → lookup product category ──────

  const purchaseDateMatch = {
    type: 'stock',
    status: { $in: ['open', 'partiallyPaid', 'paid', 'corrected', 'migrationReview'] },
    purchaseDate: dateRange,
  };
  if (outletId) purchaseDateMatch.outlet = outletId;

  const purchasePipeline = [
    { $match: purchaseDateMatch },
    { $unwind: '$lines' },
    { $lookup: { from: 'products', localField: 'lines.product', foreignField: '_id', as: 'productData' } },
    { $unwind: { path: '$productData', preserveNullAndEmptyArrays: false } },
    { $group: { _id: '$productData.category', amount: { $sum: '$lines.lineTotal' } } },
    { $sort: { amount: -1 } },
  ];

  // ── 2. Waste: WasteLog in same period ────────────────────────────────────────
  // saleOrder waste logs may have no product — group those under 'Sale Voids'.

  const wasteMatch = {};
  wasteMatch.loggedAt = dateRange;
  if (outletId) wasteMatch.outlet = outletId;

  // Grouped pipeline — used only for the per-category breakdown table.
  const wastePipeline = [
    { $match: wasteMatch },
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'productData' } },
    {
      $group: {
        _id: {
          $cond: {
            if: { $gt: [{ $size: '$productData' }, 0] },
            then: { $arrayElemAt: ['$productData.category', 0] },
            else: 'Sale Voids',
          },
        },
        amount: { $sum: '$totalCost' },
      },
    },
    { $sort: { amount: -1 } },
  ];

  // Direct-sum pipeline — authoritative source for totalWaste and wasteCount.
  // Runs the identical $match but sums without grouping, so no category
  // resolution can accidentally drop or split records.
  const wasteDirectPipeline = [
    { $match: wasteMatch },
    { $group: { _id: null, total: { $sum: '$totalCost' }, count: { $sum: 1 } } },
  ];

  const [purchaseRows, wasteRows, wasteDirectResult] = await Promise.all([
    Purchase.aggregate(purchasePipeline),
    WasteLog.aggregate(wastePipeline),
    WasteLog.aggregate(wasteDirectPipeline),
  ]);

  // ── 4. Build per-category purchases and waste maps ────────────────────────────

  const purchaseCatMap = new Map();
  const wasteCatMap = new Map();

  for (const row of purchaseRows) {
    const cat = row._id ?? 'Uncategorised';
    purchaseCatMap.set(cat, (purchaseCatMap.get(cat) ?? 0) + row.amount);
  }
  for (const row of wasteRows) {
    const cat = row._id ?? 'Uncategorised';
    wasteCatMap.set(cat, (wasteCatMap.get(cat) ?? 0) + row.amount);
  }

  const grnPurchases = r2(purchaseRows.reduce((s, r) => s + r.amount, 0));
  const manualAdditions = 0;
  const totalPurchases = grnPurchases;
  // Use the direct unconditional sum — not a reduction of grouped rows.
  const totalWaste = r2(wasteDirectResult[0]?.total ?? 0);
  const wasteCount = wasteDirectResult[0]?.count ?? 0;

  // ── 5. Build unified breakdown ────────────────────────────────────────────────

  const allCategories = new Set([...purchaseCatMap.keys(), ...wasteCatMap.keys()]);
  const breakdown = Array.from(allCategories)
    .map((cat) => {
      const purchases = r2(purchaseCatMap.get(cat) ?? 0);
      const waste = r2(wasteCatMap.get(cat) ?? 0);
      return { category: cat, purchases, waste, amount: r2(purchases + waste) };
    })
    .sort((a, b) => b.amount - a.amount);

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outletId?.toString() ?? 'all',
      grnPurchases,
      manualAdditions,
      totalPurchases,
      totalWaste,
      wasteCount,
      cogs: r2(totalPurchases + totalWaste),
      breakdown,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/cogs/by-item?from=&to=&outlet=
// Theoretical food cost per menu item: recipe cost (weighted-average ingredient +
// prep cost) × units sold in the period. This is THEORETICAL — distinct from the
// purchase-based actual COGS above. Items with no recipe report cost 0 + flagged.
// ═══════════════════════════════════════════════════════════════════════════════

// Recipe cost for ONE serving from a list of ingredients (no price fallback —
// 0 when no recipe). Used for both item-level recipes and per-variation recipes.
const recipeCostOf = (ingredients) => {
  let cost = 0;
  for (const ing of ingredients || []) {
    const prod = ing.product;
    if (!prod) continue;
    const unitCost = prod.currentPrice || prod.vendors?.[0]?.currentPrice || prod.defaultPrice || 0;
    cost += ingredientCostValue(ing.qty, ing.unit, unitCost, prod.unit || ing.unit);
  }
  return r2(cost);
};

// Resolve the same ingredient unit cost used by recipeCostOf, while retaining a
// human-readable source for the COGS detail drawer.
export const ingredientCostBasis = (product) => {
  if ((Number(product?.currentPrice) || 0) > 0) {
    return {
      unitCost: Number(product.currentPrice),
      source: product.kind === 'prep' ? 'prepRecipe' : 'weightedAveragePurchase',
    };
  }
  if ((Number(product?.vendors?.[0]?.currentPrice) || 0) > 0) {
    return { unitCost: Number(product.vendors[0].currentPrice), source: 'vendorFallback' };
  }
  if ((Number(product?.defaultPrice) || 0) > 0) {
    return { unitCost: Number(product.defaultPrice), source: 'catalogFallback' };
  }
  return { unitCost: 0, source: 'missing' };
};

export const recipeIngredientBreakdown = (ingredients, latestPurchaseMap = new Map()) => (
  (ingredients || []).map((ingredient) => {
    const product = ingredient.product;
    if (!product) return null;
    const { unitCost, source } = ingredientCostBasis(product);
    const productUnit = product.unit || ingredient.unit;
    const converted = convertQty(ingredient.qty, ingredient.unit, productUnit);
    return {
      productId: product._id,
      name: product.name,
      sku: product.sku || '',
      category: product.category || 'Uncategorised',
      kind: product.kind || 'standard',
      recipeQty: Number(ingredient.qty) || 0,
      recipeUnit: ingredient.unit,
      purchaseQty: parseFloat((Number(converted.qty) || 0).toFixed(6)),
      purchaseUnit: productUnit,
      unitsConverted: converted.converted,
      unitCost: r2(unitCost),
      costSource: source,
      cost: r2(ingredientCostValue(ingredient.qty, ingredient.unit, unitCost, productUnit)),
      latestPurchase: latestPurchaseMap.get(product._id.toString()) || null,
    };
  }).filter(Boolean)
);

export const getCOGSByItem = async (req, res) => {
  const { from, to, outlet } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dateRange = localDateRange(from, to, tz);
  const outletId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  // ── Sales in the period (units sold + revenue per menu item) ────────────────
  const saleMatch = { status: { $in: ['completed', 'refunded'] } };
  applySalesDateFilter(saleMatch, from, to, dateRange, clock);
  if (outletId) saleMatch.outlet = outletId;

  // Group by menu item AND chosen size, so each size gets its own cost row.
  // A line with no size groups under variationId = null.
  const sales = await SaleTransaction.aggregate([
    { $match: saleMatch },
    { $unwind: '$items' },
    {
      $group: {
        _id: { menuItem: '$items.menuItem', variationId: '$items.variation.id' },
        name: { $first: '$items.name' },
        variationName: { $first: '$items.variation.name' },
        quantity: { $sum: '$items.qty' },
        revenue: { $sum: '$items.lineTotal' },
      },
    },
  ]);
  const keyOf = (menuItemId, variationId) => `${menuItemId ?? ''}::${variationId ?? ''}`;
  const salesMap = new Map(
    sales
      .filter((s) => s._id?.menuItem)
      .map((s) => [keyOf(s._id.menuItem.toString(), s._id.variationId ? s._id.variationId.toString() : ''), s])
  );

  // ── ALL menu items (optionally scoped to the outlet) — so costs render even
  //    when there are no sales or no vendor prices yet ─────────────────────────
  const miFilter = {};
  if (outletId) miFilter.outlet = outletId;
  const menuItems = await MenuItem.find(miFilter)
    .select('name price ingredients variations')
    .populate('ingredients.product', 'name unit currentPrice vendors defaultPrice')
    .populate('variations.ingredients.product', 'name unit currentPrice vendors defaultPrice')
    .lean();

  const rows = [];
  const seenSaleKeys = new Set();

  // Build one row for a (menu item, optional variation) pair.
  const pushRow = ({ menuItemId, variationId, variationName, name, ingredients, price }) => {
    const key = keyOf(menuItemId.toString(), variationId ? variationId.toString() : '');
    const sale = salesMap.get(key);
    if (sale) seenSaleKeys.add(key);
    const hasRecipe = !!(ingredients?.length);
    const recipeCost = hasRecipe ? recipeCostOf(ingredients) : 0;
    // Food cost % is measured against the list price (which already excludes tax
    // and service charge — those are added on top at sale time).
    const p = price ?? 0;
    const quantity = sale?.quantity ?? 0;
    rows.push({
      id: menuItemId,
      variationId: variationId ?? null,
      variationName: variationName ?? null,
      name,
      quantity,
      price: r2(p),
      revenue: r2(sale?.revenue ?? 0),
      recipeCost,
      theoreticalCost: r2(recipeCost * quantity),
      foodCostPct: p > 0 ? r2((recipeCost / p) * 100) : 0,
      hasRecipe,
    });
  };

  for (const mi of menuItems) {
    if (mi.variations?.length) {
      // One row per size — each with its own price + recipe.
      for (const v of mi.variations) {
        pushRow({ menuItemId: mi._id, variationId: v._id, variationName: v.name, name: mi.name, ingredients: v.ingredients, price: v.price });
      }
    } else {
      pushRow({ menuItemId: mi._id, variationId: null, variationName: null, name: mi.name, ingredients: mi.ingredients, price: mi.price });
    }
  }

  // Sold (item, size) pairs whose menu item/variation was since deleted (or
  // filtered out) — still list them so the report reconciles with sales.
  for (const [key, s] of salesMap) {
    if (seenSaleKeys.has(key)) continue;
    const quantity = s.quantity;
    rows.push({
      id: s._id.menuItem,
      variationId: s._id.variationId ?? null,
      variationName: s.variationName ?? null,
      name: s.name ?? 'Unknown',
      quantity,
      price: quantity > 0 ? r2(s.revenue / quantity) : 0,
      revenue: r2(s.revenue),
      recipeCost: 0,
      theoreticalCost: 0,
      foodCostPct: 0,
      hasRecipe: false,
    });
  }

  rows.sort((a, b) => (b.theoreticalCost - a.theoreticalCost) || a.name.localeCompare(b.name));

  const theoreticalCOGS = r2(rows.reduce((s, r) => s + r.theoreticalCost, 0));
  const totalRevenue = r2(rows.reduce((s, r) => s + r.revenue, 0));

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outlet ?? 'all',
      rows,
      theoreticalCOGS,
      totalRevenue,
      foodCostPct: totalRevenue > 0 ? r2((theoreticalCOGS / totalRevenue) * 100) : 0,
      // Count DISTINCT menu items that have a size/recipe still missing — not raw
      // rows, so a 4-size item with no recipes counts once, not four times.
      itemsWithoutRecipe: new Set(rows.filter((r) => !r.hasRecipe).map((r) => String(r.id))).size,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/cogs/by-item/:itemId?variationId=&outlet=
// Recipe ingredient and purchase-cost detail for the COGS item drawer. The
// recipe total uses Product.currentPrice (weighted-average purchase cost), which
// is the same basis as the parent report. The latest posted purchase is included
// as context; it does not replace WAC in the calculation.
// ═══════════════════════════════════════════════════════════════════════════════

export const getCOGSItemDetail = async (req, res) => {
  const { itemId } = req.params;
  const { variationId, outlet } = req.query;
  if (!mongoose.isValidObjectId(itemId)) {
    return res.status(400).json({ success: false, message: 'Invalid menu item ID.' });
  }

  const itemFilter = { _id: itemId };
  if (outlet && mongoose.isValidObjectId(outlet)) itemFilter.outlet = outlet;
  const menuItem = await MenuItem.findOne(itemFilter)
    .select('name price recipeLocked ingredients variations outlet')
    .populate('ingredients.product', 'name sku category kind unit currentPrice vendors defaultPrice')
    .populate('variations.ingredients.product', 'name sku category kind unit currentPrice vendors defaultPrice')
    .lean();

  if (!menuItem) {
    return res.status(404).json({ success: false, message: 'Menu item is no longer available.' });
  }

  // Preserve recipe-lock guarantees: aggregate cost remains visible in the main
  // report, but ingredient composition is never returned without an unlock token.
  if (menuItem.recipeLocked && !hasValidUnlock(req)) {
    return res.json({
      success: true,
      data: {
        id: menuItem._id,
        name: menuItem.name,
        recipeLocked: true,
        recipes: [],
      },
    });
  }

  let recipeTargets;
  if (menuItem.variations?.length) {
    if (variationId) {
      const variation = menuItem.variations.find((entry) => entry._id?.toString() === variationId);
      if (!variation) {
        return res.status(404).json({ success: false, message: 'Menu item size is no longer available.' });
      }
      recipeTargets = [variation];
    } else {
      recipeTargets = menuItem.variations;
    }
  } else {
    recipeTargets = [{
      _id: null,
      name: null,
      price: menuItem.price,
      ingredients: menuItem.ingredients || [],
    }];
  }

  const productIds = [...new Set(
    recipeTargets.flatMap((target) => (target.ingredients || [])
      .map((ingredient) => ingredient.product?._id?.toString())
      .filter(Boolean))
  )].map((id) => new mongoose.Types.ObjectId(id));

  const purchaseMatch = {
    status: { $in: ['open', 'partiallyPaid', 'paid', 'corrected', 'migrationReview'] },
    type: { $in: ['stock', 'mixed'] },
  };
  if (outlet && mongoose.isValidObjectId(outlet)) {
    purchaseMatch.outlet = new mongoose.Types.ObjectId(outlet);
  }

  const latestPurchases = productIds.length ? await Purchase.aggregate([
    { $match: purchaseMatch },
    { $unwind: '$lines' },
    {
      $match: {
        'lines.product': { $in: productIds },
        $or: [
          { 'lines.accountingTreatment': 'inventory' },
          { 'lines.accountingTreatment': { $exists: false } },
          { 'lines.accountingTreatment': null },
        ],
      },
    },
    { $sort: { purchaseDate: -1, createdAt: -1 } },
    {
      $addFields: {
        purchasedUnits: {
          $multiply: [
            { $ifNull: ['$lines.qty', 0] },
            { $max: [{ $ifNull: ['$lines.packSize', 1] }, 1] },
          ],
        },
      },
    },
    {
      $group: {
        _id: '$lines.product',
        purchaseId: { $first: '$_id' },
        purchaseNumber: { $first: '$purchaseNumber' },
        purchaseDate: { $first: '$purchaseDate' },
        vendorId: { $first: '$vendor' },
        vendorName: { $first: '$vendorName' },
        purchasedUnits: { $first: '$purchasedUnits' },
        lineTotal: { $first: '$lines.lineTotal' },
      },
    },
    { $lookup: { from: 'vendors', localField: 'vendorId', foreignField: '_id', as: 'vendorData' } },
    {
      $project: {
        purchaseId: 1,
        purchaseNumber: 1,
        purchaseDate: 1,
        vendorName: {
          $ifNull: ['$vendorName', { $arrayElemAt: ['$vendorData.name', 0] }],
        },
        unitCost: {
          $cond: [
            { $gt: ['$purchasedUnits', 0] },
            { $divide: ['$lineTotal', '$purchasedUnits'] },
            0,
          ],
        },
      },
    },
  ]) : [];

  const latestPurchaseMap = new Map(latestPurchases.map((purchase) => [
    purchase._id.toString(),
    {
      id: purchase.purchaseId,
      purchaseNumber: purchase.purchaseNumber,
      purchaseDate: purchase.purchaseDate,
      vendorName: purchase.vendorName || 'Direct purchase',
      unitCost: r2(purchase.unitCost),
    },
  ]));

  const recipes = recipeTargets.map((target) => {
    const ingredients = recipeIngredientBreakdown(target.ingredients, latestPurchaseMap);
    const recipeCost = r2(ingredients.reduce((sum, ingredient) => sum + ingredient.cost, 0));
    const price = r2(target.price ?? menuItem.price ?? 0);
    return {
      variationId: target._id || null,
      variationName: target.name || null,
      price,
      recipeCost,
      foodCostPct: price > 0 ? r2((recipeCost / price) * 100) : 0,
      hasRecipe: ingredients.length > 0,
      ingredients,
    };
  });

  return res.json({
    success: true,
    data: {
      id: menuItem._id,
      name: menuItem.name,
      recipeLocked: false,
      recipes,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/spend?from=&to=&groupBy=vendor|category
// ═══════════════════════════════════════════════════════════════════════════════

export const getSpendReport = async (req, res) => {
  const { from, to, groupBy = 'vendor', outlet } = req.query;
  const tz = await resolveTimezone(outlet);
  const dateRange = localDateRange(from, to, tz);
  const outletId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  const purchaseMatch = { status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] } };
  purchaseMatch.purchaseDate = dateRange;
  if (outletId) purchaseMatch.outlet = outletId;

  let pipeline;

  if (groupBy === 'category') {
    // Line-level: unwind purchase lines → look up product category.
    pipeline = [
      { $match: purchaseMatch },
      { $unwind: '$lines' },
      {
        $lookup: {
          from: 'products',
          localField: 'lines.product',
          foreignField: '_id',
          as: 'productData',
        },
      },
      { $unwind: { path: '$productData', preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: '$productData.category',
          amount: { $sum: '$lines.lineTotal' },
          purchaseCount: { $addToSet: '$_id' },
        },
      },
      { $addFields: { purchaseCount: { $size: '$purchaseCount' } } },
      { $sort: { amount: -1 } },
    ];
  } else {
    // Purchase-level: group by vendor.
    pipeline = [
      { $match: purchaseMatch },
      {
        $lookup: {
          from: 'vendors',
          localField: 'vendor',
          foreignField: '_id',
          as: 'vendorData',
        },
      },
      { $unwind: { path: '$vendorData', preserveNullAndEmptyArrays: false } },
      {
        $group: {
          _id: '$vendor',
          name: { $first: '$vendorData.name' },
          amount: { $sum: '$totalAmount' },
          purchaseCount: { $sum: 1 },
        },
      },
      { $sort: { amount: -1 } },
    ];
  }

  const rows = await Purchase.aggregate(pipeline);

  const totalSpend = r2(rows.reduce((s, r) => s + r.amount, 0));

  const groups = rows.map((row) => ({
    name: row.name ?? row._id ?? 'Uncategorised',
    amount: r2(row.amount),
    purchaseCount: row.purchaseCount,
    percentOfTotal: totalSpend > 0 ? r2((row.amount / totalSpend) * 100) : 0,
  }));

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outletId?.toString() ?? 'all',
      groupBy,
      totalSpend,
      groups,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/price-changes?from=&to=&vendorId=
// ═══════════════════════════════════════════════════════════════════════════════

export const getPriceChangeReport = async (req, res) => {
  const { from, to, vendorId, outlet } = req.query;
  const tz = await resolveTimezone(outlet);
  const dateRange = localDateRange(from, to, tz);
  const outletId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  // Validate vendorId if provided
  if (vendorId && !mongoose.isValidObjectId(vendorId)) {
    return res.status(400).json({ success: false, message: 'Invalid vendorId.' });
  }

  // Price history is derived from the unit prices actually paid on posted
  // purchases — so it is OUTLET-SCOPED and reflects real
  // purchase prices over time rather than catalogue prices. For each product we
  // order its receipts chronologically and emit a row whenever the unit price
  // differs from the previous receipt. The match pulls everything up to the
  // period end (so a change landing on the first in-range receipt can still be
  // compared against the last receipt before the range); the lower date bound is
  // applied AFTER the previous price is computed.
  const purchaseMatchForPrice = {
    status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] },
    purchaseDate: { $lte: dateRange.$lte },
  };
  if (outletId) purchaseMatchForPrice.outlet = outletId;
  if (vendorId) purchaseMatchForPrice.vendor = new mongoose.Types.ObjectId(vendorId);

  const pipeline = [
    { $match: purchaseMatchForPrice },
    { $unwind: '$lines' },
    // Only priced product lines (skip free-text / zero-price lines).
    { $match: { 'lines.product': { $ne: null }, 'lines.unitPrice': { $gt: 0 } } },
    {
      $project: {
        product: '$lines.product',
        unitPrice: '$lines.unitPrice',
        vendor: '$vendor',
        date: '$purchaseDate',
      },
    },
    // Previous unit price for the same product, in chronological order.
    {
      $setWindowFields: {
        partitionBy: '$product',
        sortBy: { date: 1 },
        output: { prevPrice: { $shift: { output: '$unitPrice', by: -1 } } },
      },
    },
    // Keep only in-range receipts where the price actually moved.
    {
      $match: {
        date: { $gte: dateRange.$gte },
        prevPrice: { $ne: null },
        $expr: { $ne: ['$unitPrice', '$prevPrice'] },
      },
    },
    // Resolve product + vendor display fields.
    { $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'productData' } },
    { $unwind: { path: '$productData', preserveNullAndEmptyArrays: false } },
    { $lookup: { from: 'vendors', localField: 'vendor', foreignField: '_id', as: 'vendorData' } },
    { $unwind: { path: '$vendorData', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        productId: '$product',
        productName: '$productData.name',
        sku: '$productData.sku',
        vendorId: '$vendor',
        vendorName: { $ifNull: ['$vendorData.name', 'No vendor'] },
        vendorCode: { $ifNull: ['$vendorData.code', ''] },
        oldPrice: '$prevPrice',
        currentPrice: '$unitPrice',
        date: '$date',
        changePercent: {
          $cond: {
            if: { $gt: ['$prevPrice', 0] },
            then: {
              $round: [
                { $multiply: [{ $divide: [{ $subtract: ['$unitPrice', '$prevPrice'] }, '$prevPrice'] }, 100] },
                2,
              ],
            },
            else: 0,
          },
        },
      },
    },
    { $sort: { date: -1 } },
  ];

  const changes = await Purchase.aggregate(pipeline);

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outletId?.toString() ?? 'all',
      vendor: vendorId ?? 'all',
      changes,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/vendor-performance?from=&to=
// ═══════════════════════════════════════════════════════════════════════════════

export const getVendorPerformanceReport = async (req, res) => {
  const { from, to, outlet } = req.query;
  const tz = await resolveTimezone(outlet);
  const dateRange = localDateRange(from, to, tz);
  const outletId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  const purchaseMatchForVendor = {
    status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] },
    purchaseDate: dateRange,
  };
  if (outletId) purchaseMatchForVendor.outlet = outletId;

  const pipeline = [
    { $match: purchaseMatchForVendor },

    // Lookup vendor name
    {
      $lookup: {
        from: 'vendors',
        localField: 'vendor',
        foreignField: '_id',
        as: 'vendorData',
      },
    },
    { $unwind: { path: '$vendorData', preserveNullAndEmptyArrays: false } },

    // Compute per-purchase metrics without loading arrays into memory.
    {
      $project: {
        vendorId: '$vendor',
        vendorName: '$vendorData.name',
        vendorCode: '$vendorData.code',
        totalLines: { $size: '$lines' },
        shortLines: { $literal: 0 },
        creditCount: { $cond: [{ $eq: ['$status', 'corrected'] }, 1, 0] },
        totalCreditValue: { $literal: 0 },
      },
    },

    // Aggregate per vendor
    {
      $group: {
        _id: '$vendorId',
        vendorName: { $first: '$vendorName' },
        vendorCode: { $first: '$vendorCode' },
        totalOrders: { $sum: 1 },
        totalLines: { $sum: '$totalLines' },
        shortLines: { $sum: '$shortLines' },
        creditCount: { $sum: '$creditCount' },
        totalCreditValue: { $sum: '$totalCreditValue' },
      },
    },

    // Compute shortRate
    {
      $addFields: {
        shortRate: {
          $cond: {
            if: { $gt: ['$totalLines', 0] },
            then: { $round: [{ $divide: ['$shortLines', '$totalLines'] }, 4] },
            else: 0,
          },
        },
        totalCreditValue: { $round: ['$totalCreditValue', 2] },
      },
    },

    { $sort: { shortRate: -1, totalOrders: -1 } },
  ];

  const vendors = await Purchase.aggregate(pipeline);

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outletId?.toString() ?? 'all',
      vendors,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales?from=&to=&outlet=
// GET /api/reports/sales-summary?from=&to=&outlet=
// ═══════════════════════════════════════════════════════════════════════════════

export const getSalesSummary = async (req, res) => {
  const { from, to, outlet, groupBy = 'day', search } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dateRange = localDateRange(from, to, tz);

  const match = { status: { $in: ['completed', 'refunded', 'held'] } };
  applySalesDateFilter(match, from, to, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }
  await applyOrderSearch(match, search);

  // Build $dateToString format based on groupBy
  const dateFormats = { day: '%Y-%m-%d', week: '%Y-W%V', month: '%Y-%m' };
  const dateFormat = dateFormats[groupBy] || '%Y-%m-%d';

  const pipeline = [
    { $match: match },
    {
      $addFields: {
        _isSale: { $in: ['$status', ['completed', 'refunded']] },
        _isRefund: { $or: [{ $eq: ['$status', 'refunded'] }, { $eq: ['$isRefund', true] }] },
        _discounts: {
          $add: [
            { $ifNull: ['$discountAmount', 0] },
            { $ifNull: ['$pointsRedeemedValue', 0] },
          ],
        },
      },
    },
    {
      $addFields: {
        _sign: { $cond: ['$_isRefund', -1, 1] },
        _gross: {
          $cond: [
            { $gt: [{ $ifNull: ['$subtotal', 0] }, 0] },
            { $ifNull: ['$subtotal', 0] },
            {
              $add: [
                {
                  $max: [
                    0,
                    {
                      $subtract: [
                        { $ifNull: ['$totalAmount', 0] },
                        {
                          $add: [
                            { $ifNull: ['$taxAmount', 0] },
                            { $ifNull: ['$serviceChargeAmount', 0] },
                            { $ifNull: ['$deliveryChargeAmount', 0] },
                          ],
                        },
                      ],
                    },
                  ],
                },
                '$_discounts',
              ],
            },
          ],
        },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: dateFormat, date: reportingDateExpression(tz), timezone: 'UTC' } },
        totalSales: {
          $sum: {
            $cond: ['$_isSale', { $multiply: [{ $ifNull: ['$totalAmount', 0] }, '$_sign'] }, 0],
          },
        },
        grossSales: { $sum: { $cond: ['$_isSale', { $multiply: ['$_gross', '$_sign'] }, 0] } },
        netSales: {
          $sum: {
            $cond: [
              '$_isSale',
              { $multiply: [{ $max: [0, { $subtract: ['$_gross', '$_discounts'] }] }, '$_sign'] },
              0,
            ],
          },
        },
        salesTax: {
          $sum: {
            $cond: ['$_isSale', { $multiply: [{ $ifNull: ['$taxAmount', 0] }, '$_sign'] }, 0],
          },
        },
        serviceCharges: {
          $sum: {
            $cond: ['$_isSale', { $multiply: [{ $ifNull: ['$serviceChargeAmount', 0] }, '$_sign'] }, 0],
          },
        },
        deliveryCharges: {
          $sum: {
            $cond: ['$_isSale', { $multiply: [{ $ifNull: ['$deliveryChargeAmount', 0] }, '$_sign'] }, 0],
          },
        },
        discounts: {
          $sum: { $cond: ['$_isSale', { $multiply: ['$_discounts', '$_sign'] }, 0] },
        },
        itemCount: {
          $sum: {
            $cond: [
              '$_isSale',
              {
                $multiply: [
                  {
                    $sum: {
                      $map: {
                        input: { $ifNull: ['$items', []] },
                        as: 'item',
                        in: { $ifNull: ['$$item.qty', 0] },
                      },
                    },
                  },
                  '$_sign',
                ],
              },
              0,
            ],
          },
        },
        cashSales: {
          $sum: {
            $cond: [
              '$_isSale',
              {
                $multiply: [
                  {
                    $cond: [
                      { $eq: ['$paymentMethod', 'cash'] },
                      { $ifNull: ['$totalAmount', 0] },
                      { $ifNull: ['$cashAmount', 0] },
                    ],
                  },
                  '$_sign',
                ],
              },
              0,
            ],
          },
        },
        cardSales: {
          $sum: {
            $cond: [
              '$_isSale',
              {
                $multiply: [
                  {
                    $cond: [
                      { $eq: ['$paymentMethod', 'card'] },
                      { $ifNull: ['$totalAmount', 0] },
                      { $ifNull: ['$cardAmount', 0] },
                    ],
                  },
                  '$_sign',
                ],
              },
              0,
            ],
          },
        },
        onlineSales: {
          $sum: {
            $cond: [
              '$_isSale',
              {
                $multiply: [
                  {
                    $cond: [
                      { $eq: ['$paymentMethod', 'online-transfer'] },
                      { $ifNull: ['$totalAmount', 0] },
                      { $ifNull: ['$onlineTransferAmount', 0] },
                    ],
                  },
                  '$_sign',
                ],
              },
              0,
            ],
          },
        },
        foodPandaSales: {
          $sum: {
            $cond: [
              '$_isSale',
              {
                $multiply: [
                  {
                    $cond: [
                      { $eq: ['$paymentMethod', 'foodpanda'] },
                      { $ifNull: ['$totalAmount', 0] },
                      { $ifNull: ['$foodPandaAmount', 0] },
                    ],
                  },
                  '$_sign',
                ],
              },
              0,
            ],
          },
        },
        heldTotal: { $sum: { $cond: [{ $eq: ['$status', 'held'] }, { $ifNull: ['$totalAmount', 0] }, 0] } },
        heldCount: { $sum: { $cond: [{ $eq: ['$status', 'held'] }, 1, 0] } },
        transactions: { $sum: { $cond: ['$_isSale', 1, 0] } },
        dineInCount: {
          $sum: { $cond: [{ $and: ['$_isSale', { $eq: ['$orderType', 'dine-in'] }] }, 1, 0] },
        },
        takeawayCount: {
          $sum: { $cond: [{ $and: ['$_isSale', { $eq: ['$orderType', 'takeaway'] }] }, 1, 0] },
        },
        deliveryCount: {
          $sum: { $cond: [{ $and: ['$_isSale', { $eq: ['$orderType', 'delivery'] }] }, 1, 0] },
        },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const rows = await SaleTransaction.aggregate(pipeline);

  // Grand totals
  const totalSales = r2(rows.reduce((s, r) => s + r.totalSales, 0));
  const grossSales = r2(rows.reduce((s, r) => s + r.grossSales, 0));
  const netSales = r2(rows.reduce((s, r) => s + r.netSales, 0));
  const salesTax = r2(rows.reduce((s, r) => s + r.salesTax, 0));
  const serviceCharges = r2(rows.reduce((s, r) => s + r.serviceCharges, 0));
  const deliveryCharges = r2(rows.reduce((s, r) => s + r.deliveryCharges, 0));
  const discounts = r2(rows.reduce((s, r) => s + r.discounts, 0));
  const itemCount = rows.reduce((s, r) => s + r.itemCount, 0);
  const cashSales = r2(rows.reduce((s, r) => s + r.cashSales, 0));
  const cardSales = r2(rows.reduce((s, r) => s + r.cardSales, 0));
  const onlineSales = r2(rows.reduce((s, r) => s + r.onlineSales, 0));
  const foodPandaSales = r2(rows.reduce((s, r) => s + r.foodPandaSales, 0));
  const heldTotal = r2(rows.reduce((s, r) => s + r.heldTotal, 0));
  const heldCount = rows.reduce((s, r) => s + r.heldCount, 0);
  const dineInCount = rows.reduce((s, r) => s + r.dineInCount, 0);
  const takeawayCount = rows.reduce((s, r) => s + r.takeawayCount, 0);
  const deliveryCount = rows.reduce((s, r) => s + r.deliveryCount, 0);
  const transactionCount = rows.reduce((s, r) => s + r.transactions, 0);

  return res.json({
    success: true,
    data: {
      period: { from: from ?? null, to: to ?? null },
      outlet: outlet ?? 'all',
      totalSales,
      grossSales,
      netSales,
      salesTax,
      serviceCharges,
      deliveryCharges,
      discounts,
      itemCount,
      cashSales,
      cardSales,
      onlineSales,
      foodPandaSales,
      heldTotal,
      heldCount,
      dineInCount,
      takeawayCount,
      deliveryCount,
      transactionCount,
      avgTransactionValue: transactionCount ? r2(totalSales / transactionCount) : 0,
      rows: rows.map((r) => ({
        period: r._id,
        label: r._id,
        totalSales: r2(r.totalSales),
        grossSales: r2(r.grossSales),
        netSales: r2(r.netSales),
        salesTax: r2(r.salesTax),
        serviceCharges: r2(r.serviceCharges),
        deliveryCharges: r2(r.deliveryCharges),
        discounts: r2(r.discounts),
        itemCount: r.itemCount,
        cashSales: r2(r.cashSales),
        cardSales: r2(r.cardSales),
        onlineSales: r2(r.onlineSales),
        foodPandaSales: r2(r.foodPandaSales),
        heldTotal: r2(r.heldTotal),
        heldCount: r.heldCount,
        dineInCount: r.dineInCount,
        takeawayCount: r.takeawayCount,
        deliveryCount: r.deliveryCount,
        transactionCount: r.transactions,
      })),
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales/by-item?from=&to=&outlet=
// ═══════════════════════════════════════════════════════════════════════════════

export const getSalesByItem = async (req, res) => {
  const { from, to, outlet } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dateRange = localDateRange(from, to, tz);

  const match = { status: { $in: ['completed', 'refunded'] } };
  applySalesDateFilter(match, from, to, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }

  const pipeline = [
    { $match: match },
    { $unwind: '$items' },
    {
      // Break out by menu item AND size, so each variation is its own row
      // (a line with no size groups under variationId = null).
      $group: {
        _id: { menuItem: '$items.menuItem', variationId: '$items.variation.id' },
        name: { $first: '$items.name' },
        variationName: { $first: '$items.variation.name' },
        quantity: { $sum: '$items.qty' },
        totalSales: { $sum: '$items.lineTotal' },
      },
    },
    { $sort: { totalSales: -1 } },
  ];

  const rows = await SaleTransaction.aggregate(pipeline);

  return res.json({
    success: true,
    data: rows.map((r) => ({
      id: r._id?.menuItem ?? null,
      variationId: r._id?.variationId ?? null,
      variationName: r.variationName ?? null,
      name: r.name ?? 'Unknown',
      quantity: r.quantity,
      totalSales: r2(r.totalSales),
      avgPrice: r.quantity > 0 ? r2(r.totalSales / r.quantity) : 0,
    })),
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales/by-cashier?from=&to=&outlet=
// ═══════════════════════════════════════════════════════════════════════════════

export const getSalesByCashier = async (req, res) => {
  const { from, to, outlet } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dateRange = localDateRange(from, to, tz);

  const match = { status: { $in: ['completed', 'refunded'] } };
  applySalesDateFilter(match, from, to, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$cashier',
        totalSales: { $sum: { $cond: [{ $eq: ['$isRefund', true] }, { $multiply: ['$totalAmount', -1] }, '$totalAmount'] } },
        transactions: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'cashierData',
      },
    },
    { $sort: { totalSales: -1 } },
  ];

  const rows = await SaleTransaction.aggregate(pipeline);

  return res.json({
    success: true,
    data: rows.map((r) => {
      const cashier = r.cashierData?.[0];
      const totalSales = r2(r.totalSales);
      const transactions = r.transactions;
      return {
        cashierId: r._id,
        name: cashier?.name ?? cashier?.email ?? 'Unknown',
        totalSales,
        transactionCount: transactions,
        avgTransactionValue: transactions > 0 ? r2(r.totalSales / transactions) : 0,
      };
    }),
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales/transactions
//   ?from=&to=&outlet=&cashier=&menuItem=&period=&groupBy=
// Drill-down behind a Sales Summary / By Item / By Cashier row: the individual
// transactions that rolled up into it, with full detail + line items.
//  - period+groupBy → Sales Summary row (matches the same $dateToString bucket)
//  - menuItem       → Sales By Item row (transactions containing that item)
//  - cashier        → Sales By Cashier row
// ═══════════════════════════════════════════════════════════════════════════════

const TXN_DRILL_LIMIT = 500;

export const getSalesTransactions = async (req, res) => {
  const { from, to, outlet, cashier, menuItem, variationId, period, groupBy = 'day', search } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  const dateRange = localDateRange(from, to, tz);

  // A Sales Summary period also contains held-order metrics, so include held
  // rows in that drill. Item/cashier drills retain their paid/refunded scope.
  const match = { status: { $in: period ? ['completed', 'refunded', 'held'] : ['completed', 'refunded'] } };
  applySalesDateFilter(match, from, to, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }
  if (cashier && mongoose.Types.ObjectId.isValid(cashier)) {
    match.cashier = new mongoose.Types.ObjectId(cashier);
  }
  if (menuItem && mongoose.Types.ObjectId.isValid(menuItem)) {
    match['items.menuItem'] = new mongoose.Types.ObjectId(menuItem);
  }
  // Narrow to a specific size when drilling a per-variation Sales-by-Item row.
  if (variationId && mongoose.Types.ObjectId.isValid(variationId)) {
    match['items.variation.id'] = new mongoose.Types.ObjectId(variationId);
  }
  await applyOrderSearch(match, search);

  const pipeline = [{ $match: match }];

  // Sales Summary drill: restrict to the exact period bucket using the same
  // formatting the summary aggregation uses, so the drill ties out to the row.
  if (period) {
    const dateFormats = { day: '%Y-%m-%d', week: '%Y-W%V', month: '%Y-%m' };
    pipeline.push({
      $addFields: { _period: { $dateToString: { format: dateFormats[groupBy] || '%Y-%m-%d', date: reportingDateExpression(tz), timezone: 'UTC' } } },
    });
    pipeline.push({ $match: { _period: period } });
  }

  pipeline.push(
    { $sort: { createdAt: -1 } },
    { $limit: TXN_DRILL_LIMIT },
    {
      $lookup: { from: 'users', localField: 'cashier', foreignField: '_id', as: '_cashier' },
    },
    {
      $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: '_customer' },
    },
    {
      $project: {
        transactionNumber: 1,
        createdAt: 1,
        status: 1,
        isRefund: 1,
        orderType: 1,
        tableNumber: 1,
        subtotal: 1,
        taxAmount: 1,
        effectiveTaxRate: 1,
        serviceChargeAmount: 1,
        discountAmount: 1,
        discountMode: 1,
        discountPercent: 1,
        totalAmount: 1,
        paymentMethod: 1,
        onlineTransferReference: 1,
        foodPandaOrderNumber: 1,
        foodPandaReference: 1,
        foodPandaCustomerName: 1,
        allowanceSubjectName: 1,
        chargeToSalaryEmployeeName: 1,
        ctsCorrection: 1,
        deliveryAddress: 1,
        notes: 1,
        source: 1,
        qrOrder: 1,
        pra: 1,
        cardLast4: 1,
        cashAmount: 1,
        cardAmount: 1,
        items: 1,
        cashierName: {
          $ifNull: [
            { $arrayElemAt: ['$_cashier.name', 0] },
            { $arrayElemAt: ['$_cashier.email', 0] },
          ],
        },
        customerName: {
          $ifNull: [
            { $arrayElemAt: ['$_customer.name', 0] },
            { $ifNull: ['$foodPandaCustomerName', '$qrOrder.customerName'] },
          ],
        },
        customerPhone: {
          $ifNull: [
            { $arrayElemAt: ['$_customer.phone', 0] },
            '$qrOrder.customerPhone',
          ],
        },
      },
    },
  );

  const transactions = await SaleTransaction.aggregate(pipeline);

  return res.json({
    success: true,
    data: {
      transactions,
      count: transactions.length,
      truncated: transactions.length === TXN_DRILL_LIMIT,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales-transactions
// Paginated order register for the Sales Transactions report. Unlike the
// summary drill-down above, this intentionally includes every order state.
// ═══════════════════════════════════════════════════════════════════════════════

export const getAllSalesTransactions = async (req, res) => {
  const {
    from, to, outlet, status, orderType, paymentMethod, search, source,
    praStatus, discountState, wasteState, minAmount, maxAmount, tableNumber,
    sort = 'newest',
  } = req.query;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
  const clock = await resolveOutletClock(outlet);
  const dateRange = localDateRange(from, to, clock.timezone);
  const match = {};

  applySalesDateFilter(match, from, to, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }
  if (status) match.status = status;
  if (orderType) match.orderType = orderType;
  if (paymentMethod) match.paymentMethod = paymentMethod;
  if (source) match.source = source;
  if (praStatus) match['pra.status'] = praStatus;
  if (discountState === 'with-discount') match.discountAmount = { $gt: 0 };
  if (discountState === 'without-discount') match.discountAmount = { $lte: 0 };
  if (wasteState === 'fully-wasted') match.isVoidedAsWaste = true;
  if (wasteState === 'partially-wasted') match.partiallyWasted = true;
  if (wasteState === 'not-wasted') {
    match.isVoidedAsWaste = { $ne: true };
    match.partiallyWasted = { $ne: true };
  }
  if (tableNumber) match.tableNumber = flexibleOrderSearchRegex(tableNumber);
  const minimum = Number(minAmount);
  const maximum = Number(maxAmount);
  if (minAmount !== undefined && minAmount !== '' && Number.isFinite(minimum)) {
    match.totalAmount = { ...(match.totalAmount || {}), $gte: minimum };
  }
  if (maxAmount !== undefined && maxAmount !== '' && Number.isFinite(maximum)) {
    match.totalAmount = { ...(match.totalAmount || {}), $lte: maximum };
  }
  await applyOrderSearch(match, search);

  const sortStage = {
    oldest: { createdAt: 1, _id: 1 },
    amountHigh: { totalAmount: -1, createdAt: -1 },
    amountLow: { totalAmount: 1, createdAt: -1 },
  }[sort] || { createdAt: -1, _id: -1 };

  const [facet] = await SaleTransaction.aggregate([
    { $match: match },
    {
      $facet: {
        rows: [
          { $sort: sortStage },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: { from: 'users', localField: 'cashier', foreignField: '_id', as: '_cashier' } },
          { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: '_customer' } },
          { $lookup: { from: 'outlets', localField: 'outlet', foreignField: '_id', as: '_outlet' } },
          { $lookup: { from: 'employees', localField: 'assignedRider', foreignField: '_id', as: '_rider' } },
          {
            $project: {
              transactionNumber: 1, businessDate: 1, createdAt: 1, updatedAt: 1,
              status: 1, isRefund: 1, source: 1, orderType: 1, tableNumber: 1,
              items: 1, subtotal: 1, taxAmount: 1, effectiveTaxRate: 1,
              serviceChargeAmount: 1, deliveryChargeAmount: 1,
              discountAmount: 1, discountMode: 1, discountPercent: 1, totalAmount: 1,
              paymentMethod: 1, cashAmount: 1, cardAmount: 1,
              onlineTransferAmount: 1, onlineTransferReference: 1,
              foodPandaAmount: 1, foodPandaOrderNumber: 1, foodPandaReference: 1,
              foodPandaCustomerName: 1, cashTendered: 1, changeGiven: 1,
              cardLast4: 1, splitBill: 1, allowanceSubjectName: 1,
              chargeToSalaryEmployeeName: 1, ctsCorrection: 1,
              deliveryAddress: 1, notes: 1, qrOrder: 1, pra: 1,
              pointsEarned: 1, pointsRedeemed: 1, pointsRedeemedValue: 1,
              voidReason: 1, voidedAt: 1, refundReason: 1,
              heldAt: 1, dispatchedAt: 1, settledAt: 1,
              isVoidedAsWaste: 1, partiallyWasted: 1, rePrepared: 1,
              itemCount: { $sum: '$items.qty' },
              cashierName: {
                $ifNull: [{ $arrayElemAt: ['$_cashier.name', 0] }, { $arrayElemAt: ['$_cashier.email', 0] }],
              },
              customerName: {
                $ifNull: [
                  { $arrayElemAt: ['$_customer.name', 0] },
                  { $ifNull: ['$foodPandaCustomerName', '$qrOrder.customerName'] },
                ],
              },
              customerPhone: {
                $ifNull: [{ $arrayElemAt: ['$_customer.phone', 0] }, '$qrOrder.customerPhone'],
              },
              outletName: { $arrayElemAt: ['$_outlet.name', 0] },
              riderName: { $arrayElemAt: ['$_rider.name', 0] },
            },
          },
        ],
        summary: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
              refunded: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, 1, 0] } },
              voided: { $sum: { $cond: [{ $eq: ['$status', 'void'] }, 1, 0] } },
              grossAmount: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$totalAmount', 0] } },
              refundAmount: { $sum: { $cond: [{ $eq: ['$status', 'refunded'] }, '$totalAmount', 0] } },
            },
          },
        ],
      },
    },
  ]);

  const summary = facet?.summary?.[0] || {
    total: 0, completed: 0, refunded: 0, voided: 0, grossAmount: 0, refundAmount: 0,
  };

  return res.json({
    success: true,
    data: {
      transactions: facet?.rows || [],
      pagination: {
        page,
        limit,
        total: summary.total,
        pages: Math.max(1, Math.ceil(summary.total / limit)),
      },
      summary: {
        ...summary,
        grossAmount: r2(summary.grossAmount),
        refundAmount: r2(summary.refundAmount),
        netAmount: r2(summary.grossAmount - summary.refundAmount),
      },
    },
  });
};

// GET /api/reports/sales-transactions/:id
// Exact order lookup used by source links in journals and ledgers. It bypasses
// the report's date/page filters so an historical source always opens its drawer.
export const getSalesTransactionById = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid sales transaction ID.' });
  }

  const transaction = await SaleTransaction.findById(id)
    .populate('cashier', 'name email')
    .populate('customer', 'name phone')
    .populate('outlet', 'name')
    .populate('assignedRider', 'name')
    .lean();
  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Sales transaction not found.' });
  }

  return res.json({
    success: true,
    data: {
      ...transaction,
      cashierName: transaction.cashier?.name || transaction.cashier?.email || '',
      customerName: transaction.customer?.name
        || transaction.foodPandaCustomerName
        || transaction.qrOrder?.customerName
        || '',
      customerPhone: transaction.customer?.phone || transaction.qrOrder?.customerPhone || '',
      outletName: transaction.outlet?.name || '',
      riderName: transaction.assignedRider?.name || '',
      itemCount: (transaction.items || []).reduce(
        (sum, item) => sum + Number(item.qty || 0),
        0,
      ),
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/cancelled-orders?from=&to=&outlet=
// Whole-order voids plus partial cancellations of items already sent to the
// kitchen. Partial cancellations remain part of the paid/held transaction, so
// their durable audit events are projected into this report as separate rows.
// ═══════════════════════════════════════════════════════════════════════════════

export const getCancelledOrders = async (req, res) => {
  const { from, to, outlet } = req.query;
  const clock = await resolveOutletClock(outlet);
  const match = {
    status: 'void',
    ...cancellationReportDateMatch({ dateField: 'voidBusinessDate', timestampField: 'voidedAt', from, to, clock }),
  };
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }

  const itemCancellationMatch = {
    action: {
      $in: ['held_order_items_cancelled', 'held_order_items_cancelled_at_checkout', 'qr_order_add_on_declined'],
    },
    ...cancellationReportDateMatch({ dateField: 'after.cancellationBusinessDate', timestampField: 'timestamp', from, to, clock }),
    'after.cancellations.0': { $exists: true },
  };

  const [voidFacetResult, itemCancellationEvents] = await Promise.all([
    SaleTransaction.aggregate([
      { $match: match },
      {
        $facet: {
          rows: [
            { $sort: { voidedAt: -1, createdAt: -1 } },
            { $limit: TXN_DRILL_LIMIT },
            { $lookup: { from: 'users', localField: 'cashier', foreignField: '_id', as: '_cashier' } },
            { $lookup: { from: 'users', localField: 'voidedBy', foreignField: '_id', as: '_voidedBy' } },
            {
              $project: {
                cancellationType: { $literal: 'order' },
                transactionNumber: 1,
                createdAt: 1,
                businessDate: 1,
                voidedAt: 1,
                voidBusinessDate: 1,
                voidReason: 1,
                wasPreparedAtCancellation: 1,
                orderType: 1,
                tableNumber: 1,
                totalAmount: 1,
                subtotal: 1,
                taxAmount: 1,
                effectiveTaxRate: 1,
                serviceChargeAmount: 1,
                discountAmount: 1,
                discountMode: 1,
                discountPercent: 1,
                paymentMethod: 1,
                cardLast4: 1,
                items: 1,
                itemCount: { $size: { $ifNull: ['$items', []] } },
                praStatus: '$pra.status',
                praInvoiceNumber: '$pra.invoiceNumber',
                praCreditStatus: '$pra.credit.status',
                praCreditInvoiceNumber: '$pra.credit.invoiceNumber',
                cashierName: {
                  $ifNull: [{ $arrayElemAt: ['$_cashier.name', 0] }, { $arrayElemAt: ['$_cashier.email', 0] }],
                },
                voidedByName: {
                  $ifNull: [{ $arrayElemAt: ['$_voidedBy.name', 0] }, { $arrayElemAt: ['$_voidedBy.email', 0] }],
                },
              },
            },
          ],
          stats: [{ $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: '$totalAmount' } } }],
        },
      },
    ]),
    AuditLog.aggregate([
      { $match: itemCancellationMatch },
      {
        $lookup: {
          from: SaleTransaction.collection.name,
          localField: 'recordId',
          foreignField: '_id',
          as: '_order',
        },
      },
      { $unwind: { path: '$_order', preserveNullAndEmptyArrays: true } },
      { $set: { _order: { $ifNull: ['$_order', '$after.orderSnapshot'] } } },
      ...(outlet ? [{ $match: { '_order.outlet': match.outlet } }] : []),
      { $sort: { timestamp: -1 } },
      { $limit: TXN_DRILL_LIMIT },
      {
        $lookup: {
          from: User.collection.name,
          localField: '_order.cashier',
          foreignField: '_id',
          as: '_cashier',
        },
      },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'user',
          foreignField: '_id',
          as: '_actor',
        },
      },
      {
        $project: {
          timestamp: 1,
          recordId: 1,
          before: 1,
          after: 1,
          actorName: {
            $ifNull: ['$actorName', {
              $ifNull: [{ $arrayElemAt: ['$_actor.name', 0] }, { $arrayElemAt: ['$_actor.email', 0] }],
            }],
          },
          cashierName: {
            $ifNull: [{ $arrayElemAt: ['$_cashier.name', 0] }, { $arrayElemAt: ['$_cashier.email', 0] }],
          },
          order: {
            _id: '$_order._id',
            transactionNumber: '$_order.transactionNumber',
            createdAt: '$_order.createdAt',
            businessDate: '$_order.businessDate',
            orderType: '$_order.orderType',
            tableNumber: '$_order.tableNumber',
            paymentMethod: '$_order.paymentMethod',
            status: '$_order.status',
          },
        },
      },
    ]),
  ]);

  const facet = voidFacetResult?.[0];
  const voidRows = (facet?.rows ?? []).map(withOrderPreparationDetails);
  const itemRows = itemCancellationEvents.map((event) => itemCancellationAuditToReportRow(event, clock));
  const combinedRows = [...voidRows, ...itemRows]
    .sort((a, b) => new Date(b.voidedAt || b.createdAt || 0) - new Date(a.voidedAt || a.createdAt || 0));
  const truncated = combinedRows.length > TXN_DRILL_LIMIT
    || voidRows.length === TXN_DRILL_LIMIT
    || itemRows.length === TXN_DRILL_LIMIT;
  const rows = combinedRows.slice(0, TXN_DRILL_LIMIT);
  const stats = {
    count: rows.length,
    totalAmount: rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0),
  };

  return res.json({
    success: true,
    data: {
      transactions: rows,
      count: stats.count,
      totalAmount: parseFloat((stats.totalAmount || 0).toFixed(2)),
      truncated,
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/reports/sales/hourly?from=&to=&outlet=
// ═══════════════════════════════════════════════════════════════════════════════

export const getHourlyBreakdown = async (req, res) => {
  const { from, to, date, outlet } = req.query;
  const clock = await resolveOutletClock(req.query.outlet);
  const tz = clock.timezone;
  // Support single-date param (sent by frontend) or from/to range
  const effectiveFrom = date ?? from;
  const effectiveTo = date ?? to;
  const dateRange = localDateRange(effectiveFrom, effectiveTo, tz);

  const match = { status: { $in: ['completed', 'refunded'] } };
  applySalesDateFilter(match, effectiveFrom, effectiveTo, dateRange, clock);
  if (outlet) {
    match.outlet = mongoose.Types.ObjectId.isValid(outlet)
      ? new mongoose.Types.ObjectId(outlet)
      : outlet;
  }

  const pipeline = [
    { $match: match },
    {
      $project: {
        hour: { $hour: { date: '$createdAt', timezone: tz } },
        sales: { $cond: [{ $eq: ['$isRefund', true] }, { $multiply: ['$totalAmount', -1] }, '$totalAmount'] },
      },
    },
    {
      $group: {
        _id: '$hour',
        sales: { $sum: '$sales' },
        transactions: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const rows = await SaleTransaction.aggregate(pipeline);

  return res.json({
    success: true,
    data: rows.map((r) => ({ hour: r._id, sales: r2(r.sales), transactions: r.transactions })),
  });
};
