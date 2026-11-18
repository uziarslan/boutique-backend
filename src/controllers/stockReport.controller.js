import mongoose from 'mongoose';
import StockMovement from '../models/StockMovement.js';
import StockItem from '../models/StockItem.js';
import Product from '../models/Product.js';
import AuditLog from '../models/AuditLog.js';
import { rewindInventoryUnitCosts } from '../services/inventoryValuation.service.js';
import { resolveTimezone, startOfLocalDayUtc, endOfLocalDayUtc } from '../utils/timezone.js';

const r2 = (n) => parseFloat((Number(n) || 0).toFixed(2));
const r4 = (n) => parseFloat((Number(n) || 0).toFixed(4));

const resolveArea = (a) => (a === 'store' ? 'store' : 'kitchen');

// ─── getStockMovementSummary ──────────────────────────────────────────────────
// GET /api/inventory/stock-movement-summary?area=&outlet=&from=&to=
// Per-product opening / in / out / closing for one holding area.
//
// Closing is anchored to the AUTHORITATIVE StockItem.qtyOnHand (source of truth),
// then adjusted back to the window end by netting out movements after `to`:
//     closing(to) = currentOnHand − netMovementsAfter(to)
//     opening(from) = closing(to) − netMovementsInWindow
// This keeps balances correct even for stock that predates the ledger (it simply
// shows as a static opening=closing with no in/out) and for historical `to` dates.
export const getStockMovementSummary = async (req, res) => {
  const { outlet, area, from, to } = req.query;
  const areaVal = resolveArea(area);
  const outletOid = outlet && mongoose.isValidObjectId(outlet) ? new mongoose.Types.ObjectId(outlet) : null;

  const base = { area: areaVal };
  if (outletOid) base.outlet = outletOid;

  const timezone = await resolveTimezone(outlet);
  const fromDate = from ? startOfLocalDayUtc(from, timezone) : null;
  const toDate   = to ? endOfLocalDayUtc(to, timezone) : new Date();

  // Authoritative current on-hand per product for this area.
  const stockFilter = { area: areaVal };
  if (outletOid) stockFilter.outlet = outletOid;
  const stockRows = await StockItem.find(stockFilter).select('product qtyOnHand unit').lean();
  const currentByProduct = {};
  for (const s of stockRows) {
    const pid = s.product?.toString();
    if (!pid) continue;
    const cur = currentByProduct[pid] || { qty: 0, unit: s.unit };
    cur.qty += (s.qtyOnHand || 0);
    currentByProduct[pid] = cur;
  }

  // Net of movements AFTER the window end — backed out of current to get closing(to).
  const afterAgg = await StockMovement.aggregate([
    { $match: { ...base, at: { $gt: toDate } } },
    { $group: { _id: '$product', qty: { $sum: '$qty' } } },
  ]);
  const afterNet = {};
  afterAgg.forEach((r) => { afterNet[r._id.toString()] = r.qty; });

  // In-window movements grouped by product + type.
  const rangeMatch = { ...base, at: { $lte: toDate } };
  if (fromDate) rangeMatch.at.$gte = fromDate;
  const rangeAgg = await StockMovement.aggregate([
    { $match: rangeMatch },
    { $group: { _id: { product: '$product', type: '$type' }, qty: { $sum: '$qty' }, value: { $sum: '$value' } } },
  ]);

  const byProduct = new Map();
  const ensure = (pid) => {
    if (!byProduct.has(pid)) byProduct.set(pid, { product: pid, byType: {}, totalIn: 0, totalOut: 0, net: 0 });
    return byProduct.get(pid);
  };
  for (const r of rangeAgg) {
    const e = ensure(r._id.product.toString());
    e.byType[r._id.type] = r2((e.byType[r._id.type] || 0) + r.qty);
    if (r.qty >= 0) e.totalIn = r2(e.totalIn + r.qty);
    else e.totalOut = r2(e.totalOut + -r.qty);
    e.net = r2(e.net + r.qty);
  }
  // Products currently holding stock still need a row even with no in-window activity.
  Object.keys(currentByProduct).forEach((pid) => ensure(pid));

  const ids = [...byProduct.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const products = await Product.find({ _id: { $in: ids } }).select('name sku unit currentPrice').lean();
  const pmap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

  // Product.currentPrice is today's tenant-global WAC. For a historical report,
  // rewind later cost-changing purchases/corrections so the same `to` date keeps
  // the same valuation as time passes. The quantity rewind above is scoped to the
  // selected holding area/outlet; cost rewind is intentionally tenant-global,
  // matching the way Product.currentPrice is maintained.
  let unitCostByProduct = new Map(
    products.map((p) => [p._id.toString(), Number(p.currentPrice) || 0]),
  );
  if (to && ids.length > 0 && toDate < new Date()) {
    const observedWacTypes = [
      'issue-out', 'issue-in', 'return-out', 'return-in', 'sale', 'waste',
      'reprepare', 'prep-in', 'prep-out', 'reversal',
    ];
    const [globalQtyRows, laterMovements, cutoffCostRows, laterManualCostChanges] = await Promise.all([
      StockItem.aggregate([
        { $match: { product: { $in: ids } } },
        { $group: { _id: '$product', qty: { $sum: '$qtyOnHand' } } },
      ]),
      StockMovement.find({ product: { $in: ids }, at: { $gt: toDate } })
        .select('product qty value type ref at createdAt inventoryUnitCostBefore inventoryUnitCostAfter')
        .sort({ createdAt: -1, at: -1, _id: -1 })
        .lean(),
      StockMovement.aggregate([
        {
          $match: {
            product: { $in: ids },
            at: { $lte: toDate },
            unitCost: { $gt: 0 },
            $or: [
              { type: { $in: observedWacTypes } },
              { type: 'manual-adjust', 'ref.kind': { $ne: 'purchaseAdjustment' } },
            ],
          },
        },
        { $sort: { at: -1, _id: -1 } },
        { $group: { _id: '$product', unitCost: { $first: '$unitCost' } } },
      ]),
      AuditLog.find({
        module: 'Product',
        action: 'UPDATE',
        recordId: { $in: ids },
        timestamp: { $gt: toDate },
        'before.currentPrice': { $exists: true },
        'after.currentPrice': { $exists: true },
      }).select('recordId before.currentPrice after.currentPrice timestamp').lean(),
    ]);

    const costHistory = [
      ...laterMovements,
      ...laterManualCostChanges
        .filter((change) => Number(change.before?.currentPrice) !== Number(change.after?.currentPrice))
        .map((change) => ({
          _id: change._id,
          product: change.recordId,
          type: 'cost-override',
          qty: 0,
          value: 0,
          inventoryUnitCostBefore: Number(change.before.currentPrice) || 0,
          inventoryUnitCostAfter: Number(change.after.currentPrice) || 0,
          at: change.timestamp,
          createdAt: change.timestamp,
        })),
    ];

    unitCostByProduct = rewindInventoryUnitCosts({
      products,
      currentQtyByProduct: new Map(globalQtyRows.map((r) => [r._id.toString(), r.qty])),
      laterMovements: costHistory,
      cutoffCostByProduct: new Map(cutoffCostRows.map((r) => [r._id.toString(), r.unitCost])),
    });
  }

  const rows = [...byProduct.values()]
    .map((e) => {
      const p = pmap[e.product];
      const current = currentByProduct[e.product]?.qty || 0;
      const closing = r4(current - (afterNet[e.product] || 0));
      const opening = r4(closing - e.net);
      const unitCost = unitCostByProduct.get(e.product) ?? p?.currentPrice ?? 0;
      return {
        product: e.product,
        name: p?.name ?? e.product,
        sku: p?.sku,
        unit: p?.unit ?? currentByProduct[e.product]?.unit,
        opening,
        totalIn: e.totalIn,
        totalOut: e.totalOut,
        closing,
        byType: e.byType,
        unitCost: r2(unitCost),
        value: r2(closing * unitCost),
      };
    })
    .filter((r) => r.opening !== 0 || r.totalIn !== 0 || r.totalOut !== 0 || r.closing !== 0)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const totalInByUnit = {};
  const totalOutByUnit = {};
  for (const row of rows) {
    const unit = String(row.unit || 'unit');
    totalInByUnit[unit] = r2((totalInByUnit[unit] || 0) + row.totalIn);
    totalOutByUnit[unit] = r2((totalOutByUnit[unit] || 0) + row.totalOut);
  }

  const totals = {
    totalIn: r2(rows.reduce((s, r) => s + r.totalIn, 0)),
    totalOut: r2(rows.reduce((s, r) => s + r.totalOut, 0)),
    totalInByUnit,
    totalOutByUnit,
    closingValue: r2(rows.reduce((s, r) => s + r.value, 0)),
    products: rows.length,
  };

  return res.json({
    success: true,
    data: { area: areaVal, rows, totals, period: { from: fromDate, to: toDate } },
  });
};

// ─── getStockMovements ────────────────────────────────────────────────────────
// GET /api/inventory/stock-movements?area=&outlet=&product=&type=&from=&to=&page=&limit=
// The raw ledger, most recent first — drill-down for the reports.
export const getStockMovements = async (req, res) => {
  const { outlet, area, product, type, from, to, page = 1, limit = 100 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {};
  if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (area === 'store' || area === 'kitchen') filter.area = area;
  if (product && mongoose.isValidObjectId(product)) filter.product = new mongoose.Types.ObjectId(product);
  if (type) filter.type = type;
  if (from || to) {
    const timezone = await resolveTimezone(outlet);
    filter.at = {};
    if (from) filter.at.$gte = startOfLocalDayUtc(from, timezone);
    filter.at.$lte = to ? endOfLocalDayUtc(to, timezone) : new Date();
  }

  const [movements, total] = await Promise.all([
    StockMovement.find(filter)
      .sort({ at: -1, _id: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('product', 'name sku unit')
      .populate('user', 'name email')
      .lean(),
    StockMovement.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { movements, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};
