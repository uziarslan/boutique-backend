import mongoose from 'mongoose';
import StockItem from '../models/StockItem.js';
import StockCount from '../models/StockCount.js';
import WasteLog from '../models/WasteLog.js';
import Product from '../models/Product.js';
import MenuItem from '../models/MenuItem.js';
import Purchase from '../models/Purchase.js';
import SaleTransaction from '../models/SaleTransaction.js';
import { postWasteLog, postStockCountAdjustment } from '../accounting/journalEngine.js';
import { postPurchaseDocument } from '../services/purchase.service.js';
import { recordPurchasePayment } from '../services/payment.service.js';
import { allocateOrderValues, computeRecipeCost, logSaleAsWaste } from '../services/saleWaste.service.js';
import { recordStockMovement, recordStockMovements } from '../services/stockLedger.js';
import { hasValidUnlock } from '../utils/recipeLock.js';
import { convertQty } from '../utils/unitConversion.js';
import logger from '../utils/logger.js';

// ─── getAllStock ───────────────────────────────────────────────────────────────
// GET /api/inventory
// Query: outlet, belowPar, page, limit

export const getAllStock = async (req, res) => {
  const {
    outlet,
    belowPar,
    area,
    page = 1,
    limit = 50,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const matchStage = {};
  if (outlet && mongoose.isValidObjectId(outlet)) matchStage.outlet = new mongoose.Types.ObjectId(outlet);
  // Scope to a holding area. Defaults to the kitchen so the (renamed) Kitchen
  // stock page never double-counts store balances once store rows exist.
  matchStage.area = area === 'store' ? 'store' : 'kitchen';

  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: 'products',
        localField: 'product',
        foreignField: '_id',
        as: 'productData',
      },
    },
    { $unwind: '$productData' },
    {
      $lookup: {
        from: 'outlets',
        localField: 'outlet',
        foreignField: '_id',
        as: 'outletData',
      },
    },
    {
      $addFields: {
        outletData: { $arrayElemAt: ['$outletData', 0] },
      },
    },
    {
      $addFields: {
        productName: '$productData.name',
        sku: '$productData.sku',
        category: '$productData.category',
        parLevel: '$productData.parLevel',
        reorderQty: '$productData.reorderQty',
        currentPrice: {
          $cond: {
            if: { $gt: [{ $ifNull: ['$productData.currentPrice', 0] }, 0] },
            then: '$productData.currentPrice',
            else: { $ifNull: [{ $arrayElemAt: ['$productData.vendors.currentPrice', 0] }, 0] },
          },
        },
        // Prefer StockItem unit; fall back to product unit
        unit: { $ifNull: ['$unit', '$productData.unit'] },
        packSize: { $ifNull: ['$productData.packSize', { $arrayElemAt: ['$productData.vendors.packSize', 0] }] },
        belowPar: {
          $cond: {
            if: { $gt: ['$productData.parLevel', 0] },
            then: { $lt: ['$qtyOnHand', '$productData.parLevel'] },
            else: false,
          },
        },
      },
    },
    {
      $project: {
        product: '$productData._id',
        productName: 1,
        sku: 1,
        category: 1,
        parLevel: 1,
        reorderQty: 1,
        currentPrice: 1,
        outlet: {
          _id: '$outletData._id',
          name: '$outletData.name',
          code: '$outletData.code',
        },
        qtyOnHand: 1,
        unit: 1,
        packSize: 1,
        location: 1,
        area: 1,
        belowPar: 1,
        lastCountDate: 1,
        lastCountQty: 1,
        lastCountVariance: 1,
        updatedAt: 1,
      },
    },
  ];

  if (belowPar === 'true') {
    pipeline.push({ $match: { belowPar: true } });
  }

  pipeline.push({ $sort: { productName: 1 } });

  // Count then paginate
  const countPipeline = [...pipeline, { $count: 'total' }];
  pipeline.push({ $skip: skip }, { $limit: pageSize });

  const [items, countResult] = await Promise.all([
    StockItem.aggregate(pipeline),
    StockItem.aggregate(countPipeline),
  ]);

  const total = countResult[0]?.total ?? 0;

  return res.json({
    success: true,
    data: { items, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── updateStockItem ──────────────────────────────────────────────────────────
// PUT /api/inventory/:productId
// Body: { qtyOnHand, outlet?, reason, notes? }

export const updateStockItem = async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const { qtyOnHand, outlet: rawOutlet, reason, notes } = req.body;

  if (qtyOnHand === undefined || typeof qtyOnHand !== 'number') {
    return res.status(422).json({ success: false, message: 'qtyOnHand (number) is required.' });
  }
  if (!reason || reason.trim().length < 3) {
    return res.status(422).json({ success: false, message: 'A reason (min 3 chars) is required for manual adjustments.' });
  }
  if (!rawOutlet || !mongoose.isValidObjectId(rawOutlet)) {
    return res.status(400).json({ success: false, message: 'Valid outlet ID is required.' });
  }
  const outletId = new mongoose.Types.ObjectId(rawOutlet);
  const area = req.body.area === 'store' ? 'store' : 'kitchen';

  const product = await Product.findById(productId).lean();
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  const before = await StockItem.findOne({ product: productId, outlet: outletId, area }).lean();

  const stockItem = await StockItem.findOneAndUpdate(
    { product: productId, outlet: outletId, area },
    {
      $set: {
        qtyOnHand,
        unit: product.unit,
        updatedAt: new Date(),
      },
      $setOnInsert: { product: productId, outlet: outletId, area },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();

  // Ledger: record the signed delta as a manual adjustment.
  const delta = parseFloat((qtyOnHand - (before?.qtyOnHand ?? 0)).toFixed(4));
  if (delta !== 0) {
    await recordStockMovement({
      product: productId,
      outlet: outletId,
      area,
      qty: delta,
      unit: product.unit,
      type: 'manual-adjust',
      unitCost: product.currentPrice || 0,
      ref: { kind: 'manual' },
      note: reason,
      user: req.user.id,
    });
  }

  // Audit hints
  req.auditRecordId = stockItem._id;
  req.auditBefore = before ?? null;
  req.auditAfter = stockItem;

  logger.info(
    `Stock manually adjusted: product ${productId} | outlet: ${outletId} | area: ${area} | ` +
    `${before?.qtyOnHand ?? 'new'} → ${qtyOnHand} | reason: ${reason} | by user ${req.user.id}`
  );

  return res.json({
    success: true,
    message: 'Stock level updated.',
    data: stockItem,
  });
};

// ─── submitStockCount ─────────────────────────────────────────────────────────
// POST /api/inventory/stock-count
// Body: { outlet, vendor?, lines: [{ product, countedQty, unit?, notes? }], notes? }

export const submitStockCount = async (req, res) => {
  const { outlet: rawOutlet, lines, notes } = req.body;

  if (!rawOutlet || !mongoose.isValidObjectId(rawOutlet)) {
    return res.status(400).json({ success: false, message: 'Valid outlet ID is required.' });
  }
  const outlet = new mongoose.Types.ObjectId(rawOutlet);
  const area = req.body.area === 'store' ? 'store' : 'kitchen';
  // How to book shortages: 'sold' (default — normal consumption, cost stays in
  // Purchase Expense) or 'waste' (reclassify to Waste & Spoilage).
  const shortageMode = req.body.shortageMode === 'waste' ? 'waste' : 'sold';

  if (!Array.isArray(lines) || lines.length === 0) {
    return res.status(422).json({ success: false, message: 'lines array is required and cannot be empty.' });
  }

  // Validate all product IDs up front
  const productIds = lines.map((l) => l.product);
  const invalidId = productIds.find((id) => !mongoose.isValidObjectId(id));
  if (invalidId) {
    return res.status(422).json({ success: false, message: `Invalid product ID: ${invalidId}` });
  }

  // Fetch current stock levels for all products in one query (this area only)
  const stockItems = await StockItem.find({ product: { $in: productIds }, outlet, area }).lean();
  const stockByProduct = Object.fromEntries(
    stockItems.map((s) => [s.product.toString(), s])
  );

  // Build count lines with systemQty and variance
  const countLines = lines.map((line) => {
    const existing = stockByProduct[line.product?.toString()];
    const systemQty = existing?.qtyOnHand ?? 0;
    const countedQty = parseFloat(line.countedQty);
    const variance = parseFloat((countedQty - systemQty).toFixed(4));
    return {
      product: line.product,
      systemQty,
      countedQty,
      variance,
      unit: line.unit ?? existing?.unit ?? '',
      notes: line.notes ?? '',
    };
  });

  // Create the completed StockCount record
  const stockCount = await StockCount.create({
    outlet,
    area,
    countedBy: req.user.id,
    lines: countLines,
    status: 'completed',
    completedAt: new Date(),
    shortageMode,
    notes,
  });

  // Bulk update StockItem for every counted line (this area only)
  const updateOps = countLines.map((line) =>
    StockItem.findOneAndUpdate(
      { product: line.product, outlet, area },
      {
        $set: {
          qtyOnHand: line.countedQty,
          unit: line.unit || undefined,
          lastCountDate: stockCount.completedAt,
          lastCountQty: line.countedQty,
          lastCountVariance: line.variance,
          updatedAt: new Date(),
        },
        $setOnInsert: { product: line.product, outlet, area },
      },
      { upsert: true, returnDocument: 'after' }
    )
  );

  await Promise.all(updateOps);

  // ── Post journal entries for lines with a non-zero variance ─────────────────
  const linesWithVariance = countLines.filter((l) => l.variance !== 0);

  // Derive unit cost from the most recent confirmed GRN line for each product.
  const recentGRNPrices = await Purchase.aggregate([
    { $match: { status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] }, 'lines.product': { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $unwind: '$lines' },
    { $match: { 'lines.product': { $in: productIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $sort: { purchaseDate: -1 } },
    { $group: { _id: '$lines.product', unitPrice: { $first: '$lines.unitPrice' }, packSize: { $first: '$lines.packSize' } } },
  ]);
  // GRN unitPrice is PER PACK for packaged lines; stock counts are in base units,
  // so divide by packSize to get the per-base-unit cost (packSize is 1 for loose).
  const costByProduct = Object.fromEntries(
    recentGRNPrices.map((r) => {
      const packSize = r.packSize && r.packSize > 0 ? r.packSize : 1;
      return [r._id.toString(), (r.unitPrice ?? 0) / packSize];
    })
  );

  if (linesWithVariance.length > 0) {
    await postStockCountAdjustment(stockCount, costByProduct, req.user.id, shortageMode);
  }

  // Build a unified per-product cost map (recent GRN price → product vendor price
  // fallback) purely to VALUE the count-adjust ledger rows below.
  const allProductIds = countLines.map((l) => l.product?.toString());
  const extendedCostMap = { ...(costByProduct ?? {}) };
  const productDocs = await Product.find({ _id: { $in: allProductIds } }).lean();
  productDocs.forEach((p) => {
    const pid = p._id.toString();
    if (!extendedCostMap[pid] || extendedCostMap[pid] === 0) {
      extendedCostMap[pid] = p.vendors?.[0]?.currentPrice ?? 0;
    }
  });

  // Ledger: one 'count-adjust' row per variance line (signed to the counted qty).
  await recordStockMovements(
    linesWithVariance.map((l) => ({
      product: l.product,
      outlet,
      area,
      qty: l.variance,
      unit: l.unit,
      type: 'count-adjust',
      unitCost: extendedCostMap[l.product?.toString()] ?? 0,
      ref: { kind: 'stockCount', id: stockCount._id },
      user: req.user.id,
    })),
  );

  // NOTE: a SURPLUS (positive variance) posts NO accounting entry — it's a recount
  // correction (quantity + the count-adjust ledger row above only). It used to
  // auto-generate a phantom cash purchase (DR Purchase Expense / CR Cash) AND a
  // reclassification, which double-debited Purchase Expense and booked a phantom
  // cash purchase for stock merely found in a count. Both were removed.

  logger.info(
    `Stock count submitted: outlet ${outlet} | ${countLines.length} lines | ` +
    `${linesWithVariance.length} variance(s) | by user ${req.user.id}`
  );

  req.auditRecordId = stockCount._id;
  req.auditAfter = stockCount.toObject();

  return res.status(201).json({ success: true, data: stockCount });
};

// ─── createNewStock (create product + post an initial unified purchase) ──────
// POST /api/inventory/create-new-stock
// Body: { product: { name, category, unit, parLevel, reorderQty, storageLocation, shelfLifeDays, packSize, price }, outlet?, qty, notes? }
export const createNewStock = async (req, res) => {
  const { product: prodPayload, outlet: rawOutlet, qty, notes } = req.body;
  if (!rawOutlet || !mongoose.isValidObjectId(rawOutlet)) {
    return res.status(400).json({ success: false, message: 'Valid outlet ID is required.' });
  }
  const outlet = new mongoose.Types.ObjectId(rawOutlet);

  if (!prodPayload || typeof prodPayload !== 'object') {
    return res.status(422).json({ success: false, message: 'product object is required.' });
  }

  const { name, category, unit } = prodPayload;
  if (!name || !category || !unit) {
    return res.status(422).json({ success: false, message: 'Product name, category and unit are required.' });
  }

  const qtyNum = parseFloat(qty);
  if (!qtyNum || qtyNum <= 0) {
    return res.status(422).json({ success: false, message: 'qty must be a number greater than 0.' });
  }

  let purchase = null;

  try {
    // Create product (no vendor required)
    const productDoc = await Product.create({
      name: name.trim(),
      category: category.trim(),
      unit: unit.trim(),
      storageLocation: prodPayload.storageLocation?.trim() ?? undefined,
      shelfLifeDays: prodPayload.shelfLifeDays ? parseInt(prodPayload.shelfLifeDays, 10) : undefined,
      packSize: prodPayload.packSize?.trim() ?? undefined,
      defaultPrice: prodPayload.price != null ? parseFloat(prodPayload.price) : 0,
      parLevel: prodPayload.parLevel != null ? parseFloat(prodPayload.parLevel) : 0,
      reorderQty: prodPayload.reorderQty != null ? parseFloat(prodPayload.reorderQty) : 0,
      createdBy: req.user.id,
    });

    // Initial quantity is a normal unified purchase, not an inventory bypass.
    const unitPrice = prodPayload.price != null ? parseFloat(prodPayload.price) : (productDoc.defaultPrice ?? 0);
    purchase = await Purchase.create({
      type: 'stock',
      vendorName: 'Initial stock',
      outlet,
      destination: 'kitchen',
      lines: [{
        product: productDoc._id,
        productName: productDoc.name,
        description: productDoc.name,
        qty: qtyNum,
        packSize: 1,
        unit: productDoc.unit,
        unitPrice,
      }],
      notes: notes || `Initial stock for ${productDoc.name}`,
      createdBy: req.user.id,
    });
    await postPurchaseDocument(purchase, req.user.id);
    if (purchase.totalAmount > 0) {
      await recordPurchasePayment(purchase, {
        amount: purchase.totalAmount,
        method: 'cash',
        notes: 'Initial stock paid at entry',
        userId: req.user.id,
      });
    }
    const stockItem = await StockItem.findOne({ product: productDoc._id, outlet, area: 'kitchen' });

    req.auditRecordId = productDoc._id;
    req.auditAfter = { product: productDoc.toObject(), stockItem: stockItem?.toObject(), purchase: purchase.toObject() };

    return res.status(201).json({ success: true, data: { product: productDoc, stockItem, purchase } });
  } catch (err) {
    logger.error(`Create new stock failed: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Failed to create product and add stock.' });
  }
};


// ─── logWaste ─────────────────────────────────────────────────────────────────
// POST /api/inventory/waste-log
// Body: { product, outlet?, qty, unit?, reason, costAtTime?, notes? }

export const logWaste = async (req, res) => {
  const { product, outlet: rawOutlet, qty, unit, reason, costAtTime, notes } = req.body;

  // Resolve outlet as ObjectId: use provided ID, then user's outletRef, then first active outlet.
  let outletId;
  if (rawOutlet && mongoose.isValidObjectId(rawOutlet)) {
    outletId = new mongoose.Types.ObjectId(rawOutlet);
  } else if (req.user?.outletRef && mongoose.isValidObjectId(req.user.outletRef)) {
    outletId = new mongoose.Types.ObjectId(req.user.outletRef);
  } else {
    const Outlet = (await import('../models/Outlet.js')).default;
    const firstOutlet = await Outlet.findOne({ isActive: true }).select('_id').lean();
    if (!firstOutlet) {
      return res.status(400).json({ success: false, message: 'No outlet found. Please create an outlet first.' });
    }
    outletId = firstOutlet._id;
  }

  if (!mongoose.isValidObjectId(product)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const productDoc = await Product.findById(product).lean();
  if (!productDoc) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  // Convert the entered quantity into the product's BASE stock unit — cost, stock
  // deduction and the ledger are all in base units. Waste of "500 g" against a
  // kg-based item becomes 0.5 kg. The waste record is stored in base units.
  const baseUnit = productDoc.unit || (unit ?? '');
  const enteredUnit = (unit && String(unit).trim()) || baseUnit;
  const { qty: convertedQty, converted } = convertQty(qty, enteredUnit, baseUnit);
  if (!converted) {
    return res.status(422).json({
      success: false,
      message: `Cannot convert ${enteredUnit || 'that unit'} to ${baseUnit || 'the base unit'} for "${productDoc.name}". Use a compatible unit.`,
    });
  }
  const baseQty = parseFloat((Number(convertedQty) || 0).toFixed(4));

  // Resolve unit cost (per BASE unit). Priority mirrors every other cost site
  // (saleWaste / prepRecipe / reports): explicit value → product WAC
  // (currentPrice) → best vendor price → defaultPrice → most recent GRN price.
  let resolvedCost;
  if (costAtTime != null) {
    resolvedCost = parseFloat(costAtTime);
  } else {
    const vendorBestPrice = productDoc.vendors?.reduce((best, v) => Math.max(best, v.currentPrice ?? 0), 0) ?? 0;
    let grnCost = 0;
    if (!(productDoc.currentPrice > 0) && !(vendorBestPrice > 0) && !(productDoc.defaultPrice > 0)) {
      const recentGRN = await Purchase.aggregate([
        { $match: { status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] }, 'lines.product': new mongoose.Types.ObjectId(product) } },
        { $unwind: '$lines' },
        { $match: { 'lines.product': new mongoose.Types.ObjectId(product) } },
        { $sort: { purchaseDate: -1 } },
        { $limit: 1 },
        { $project: { unitPrice: '$lines.unitPrice', packSize: '$lines.packSize' } },
      ]);
      // GRN unitPrice is PER PACK for packaged lines; waste is measured in base
      // units, so divide by packSize (1 for loose) to get per-base-unit cost.
      const grnPackSize = recentGRN[0]?.packSize && recentGRN[0].packSize > 0 ? recentGRN[0].packSize : 1;
      grnCost = (recentGRN[0]?.unitPrice ?? 0) / grnPackSize;
    }
    resolvedCost = productDoc.currentPrice || vendorBestPrice || productDoc.defaultPrice || grnCost;
  }

  const totalCost = parseFloat((baseQty * resolvedCost).toFixed(2));

  const wasteLog = await WasteLog.create({
    product,
    outlet: outletId,
    qty: baseQty,
    unit: baseUnit,
    reason,
    costAtTime: resolvedCost,
    totalCost,
    loggedBy: req.user.id,
    loggedAt: new Date(),
  });

  // Decrement stock — waste is always drawn from the kitchen.
  const stockItem = await StockItem.findOneAndUpdate(
    { product, outlet: outletId, area: 'kitchen' },
    {
      $inc: { qtyOnHand: -baseQty },
      $set: { updatedAt: new Date() },
      $setOnInsert: { product, outlet: outletId, area: 'kitchen' },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Ledger: one 'waste' row (kitchen, −baseQty).
  await recordStockMovement({
    product,
    outlet: outletId,
    area: 'kitchen',
    qty: -baseQty,
    unit: baseUnit,
    type: 'waste',
    unitCost: resolvedCost,
    ref: { kind: 'wasteLog', id: wasteLog._id },
    note: reason,
    user: req.user.id,
  });

  // Post journal entry: DR Waste and Spoilage (5003), CR Inventory (1200)
  let journalEntry = null;
  try {
    journalEntry = await postWasteLog(wasteLog, req.user.id);
    wasteLog.journalEntryId = journalEntry._id;
    await wasteLog.save();
  } catch (err) {
    // Accounting failure should not undo the physical stock entry
    logger.error(`Waste JE post failed for wasteLog ${wasteLog._id}: ${err.message}`);
  }

  req.auditRecordId = wasteLog._id;
  req.auditAfter = wasteLog.toObject();

  logger.info(
    `Waste logged: ${baseQty} ${baseUnit} of product ${product} | ` +
    `reason: ${reason} | cost: ${totalCost} | outlet: ${outletId} | by user ${req.user.id}`
  );

  return res.status(201).json({
    success: true,
    data: {
      wasteLog,
      stockQtyOnHand: stockItem.qtyOnHand,
      journalEntry: journalEntry ? { id: journalEntry._id, entryNumber: journalEntry.entryNumber } : null,
    },
  });
};

// ─── getWasteLogs ─────────────────────────────────────────────────────────────
// GET /api/inventory/waste-log
// Query: outlet, reason, from, to, page, limit

export const getWasteLogs = async (req, res) => {
  const {
    outlet,
    reason,
    from,
    to,
    page = 1,
    limit = 25,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {};
  if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (reason) filter.reason = reason;
  if (from || to) {
    filter.loggedAt = {};
    if (from) filter.loggedAt.$gte = new Date(from);
    if (to) filter.loggedAt.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
  }

  const [wasteLogs, total] = await Promise.all([
    WasteLog.find(filter)
      .sort({ loggedAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('product', 'name sku unit')
      .populate('loggedBy', 'name email')
      .lean(),
    WasteLog.countDocuments(filter),
  ]);

  // Sale-order waste rows fall back to the order's cashier as "logged by" when
  // no explicit logger is recorded (older rows logged before the logger was
  // captured). Resolved in one extra query for the page's affected rows.
  const needsCashier = wasteLogs.filter((w) => w.source === 'saleOrder' && !w.loggedBy && w.saleTransactionId);
  if (needsCashier.length) {
    const txIds = [...new Set(needsCashier.map((w) => String(w.saleTransactionId)))];
    const txs = await SaleTransaction.find({ _id: { $in: txIds } })
      .select('cashier')
      .populate('cashier', 'name email')
      .lean();
    const cashierByTx = new Map(txs.map((t) => [String(t._id), t.cashier]));
    for (const w of needsCashier) {
      w.loggedBy = cashierByTx.get(String(w.saleTransactionId)) ?? null;
    }
  }

  return res.json({
    success: true,
    data: { wasteLogs, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── getVarianceReport ────────────────────────────────────────────────────────
// GET /api/inventory/variance-report
// Query: outlet, from, to, page, limit

export const getVarianceReport = async (req, res) => {
  const {
    outlet,
    from,
    to,
    page = 1,
    limit = 20,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = { status: 'completed' };
  if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (from || to) {
    filter.completedAt = {};
    if (from) filter.completedAt.$gte = new Date(from);
    if (to) filter.completedAt.$lte = new Date(to);
  }

  const [counts, total] = await Promise.all([
    StockCount.find(filter)
      .sort({ completedAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('lines.product', 'name sku unit vendors')
      .populate('countedBy', 'name email')
      .lean(),
    StockCount.countDocuments(filter),
  ]);

  // Filter to lines with non-zero variance and attach cost value per line
  const sessions = counts
    .map((count) => {
      const varianceLines = count.lines
        .filter((l) => l.variance !== 0)
        .map((l) => {
          const currentPrice = l.product?.vendors?.[0]?.currentPrice ?? 0;
          return {
            product: l.product?._id ?? l.product,
            productName: l.product?.name ?? '',
            sku: l.product?.sku ?? '',
            unit: l.unit ?? l.product?.unit ?? '',
            systemQty: l.systemQty,
            countedQty: l.countedQty,
            variance: l.variance,
            costPerUnit: currentPrice,
            costValue: parseFloat(Math.abs(l.variance * currentPrice).toFixed(2)),
            notes: l.notes,
          };
        });

      return {
        _id: count._id,
        outlet: count.outlet,
        countedBy: count.countedBy,
        completedAt: count.completedAt,
        notes: count.notes,
        varianceLines,
        totalVarianceLines: varianceLines.length,
        totalCostVariance: parseFloat(
          varianceLines.reduce((s, l) => s + l.costValue, 0).toFixed(2)
        ),
      };
    })
    .filter((s) => s.varianceLines.length > 0);

  return res.json({
    success: true,
    data: { sessions, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── getStockDetail ───────────────────────────────────────────────────────────
// GET /api/inventory/:productId/detail?outlet=TSO-001
// Returns stock item + product info + purchase, count, and waste history.

export const getStockDetail = async (req, res) => {
  const { productId } = req.params;
  const { outlet } = req.query;

  if (!mongoose.isValidObjectId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const query = { product: productId, area: req.query.area === 'store' ? 'store' : 'kitchen' };
  if (outlet && mongoose.isValidObjectId(outlet)) query.outlet = new mongoose.Types.ObjectId(outlet);
  const outletObjId = (outlet && mongoose.isValidObjectId(outlet)) ? new mongoose.Types.ObjectId(outlet) : null;

  // Fetch the stock item (defaults to the kitchen area)
  const stockItem = await StockItem.findOne(query).populate('outlet', 'name code').lean();
  if (!stockItem) {
    return res.status(404).json({ success: false, message: 'Stock item not found.' });
  }

  // Fetch product details
  const product = await Product.findById(productId).lean();

  // Posted purchases that contain this product (most recent first)
  const purchases = await Purchase.find({
    'lines.product': new mongoose.Types.ObjectId(productId),
    status: { $in: ['open', 'paid', 'partiallyPaid', 'corrected', 'migrationReview'] },
  })
    .populate('vendor', 'name code')
    .populate('postedBy', 'name email')
    .sort({ purchaseDate: -1 })
    .limit(20)
    .lean();

  const purchaseHistory = purchases.map((purchase) => {
    const line = purchase.lines.find((item) => item.product?.toString() === productId);
    return {
      type: 'purchase',
      date: purchase.purchaseDate ?? purchase.createdAt,
      purchaseId: purchase._id,
      purchaseNumber: purchase.purchaseNumber,
      vendor: purchase.vendor,
      receivedBy: purchase.postedBy,
      receivedQty: (line?.qty ?? 0) * (line?.packSize || 1),
      unitPrice: line?.unitPrice ?? 0,
      lineTotal: line?.lineTotal ?? 0,
    };
  });

  // Stock counts that include this product, most recent first
  const stockCounts = await StockCount.find({
    'lines.product': new mongoose.Types.ObjectId(productId),
    ...(outletObjId ? { outlet: outletObjId } : {}),
    status: 'completed',
  })
    .populate('countedBy', 'name email')
    .sort({ completedAt: -1 })
    .limit(20)
    .lean();

  const countHistory = stockCounts.map((sc) => {
    const line = sc.lines.find((l) => l.product.toString() === productId);
    return {
      type: 'stockCount',
      date: sc.completedAt ?? sc.createdAt,
      stockCountId: sc._id,
      countedBy: sc.countedBy,
      systemQty: line?.systemQty ?? 0,
      countedQty: line?.countedQty ?? 0,
      variance: line?.variance ?? 0,
    };
  });

  // Waste logs for this product, most recent first
  const wasteLogs = await WasteLog.find({
    product: productId,
    ...(outletObjId ? { outlet: outletObjId } : {}),
  })
    .populate('loggedBy', 'name email')
    .sort({ loggedAt: -1 })
    .limit(20)
    .lean();

  const wasteHistory = wasteLogs.map((w) => ({
    type: 'waste',
    date: w.loggedAt,
    wasteLogId: w._id,
    qty: w.qty,
    unit: w.unit,
    reason: w.reason,
    costAtTime: w.costAtTime,
    totalCost: w.totalCost,
    loggedBy: w.loggedBy,
    journalEntryId: w.journalEntryId,
  }));

  // Merge and sort all history by date ascending (oldest first)
  const history = [...purchaseHistory, ...countHistory, ...wasteHistory].sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  return res.json({
    success: true,
    data: {
      stockItem,
      product,
      purchases,
      history,
    },
  });
};

// ─── getSaleTransactionsForWaste ──────────────────────────────────────────────
// GET /api/inventory/waste-log/sale-transactions
// Returns completed POS sale transactions that have not yet been voided as waste.
// Query: outlet, q (search transactionNumber), page, limit

export const getSaleTransactionsForWaste = async (req, res) => {
  const { outlet, q, page = 1, limit = 20 } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = {
    status: 'completed',
    isVoidedAsWaste: { $ne: true },
  };
  if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);
  if (q) filter.transactionNumber = { $regex: q, $options: 'i' };

  const [transactions, total] = await Promise.all([
    SaleTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize)
      .populate('cashier', 'name')
      .populate('outlet', 'name code')
      .select('transactionNumber totalAmount items createdAt cashier outlet orderType partiallyWasted pra.status pra.invoiceNumber')
      .lean(),
    SaleTransaction.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { transactions, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── logWasteFromSale ─────────────────────────────────────────────────────────
// POST /api/inventory/waste-log/from-sale
// Body: { saleTransactionId, reason, notes }
// Marks a completed POS sale as waste/loss and creates a WasteLog entry.

export const logWasteFromSale = async (req, res) => {
  const { saleTransactionId, reason = 'orderVoid', notes } = req.body;
  const rePrepare = req.body.rePrepare === true || req.body.rePrepare === 'true';
  const selection = Array.isArray(req.body.selection) ? req.body.selection : null;
  const valuationMethod = req.body.valuationMethod ?? 'ingredientCost';

  if (!['ingredientCost', 'orderValue'].includes(valuationMethod)) {
    return res.status(400).json({ success: false, message: 'Waste valuation must be ingredient cost or order value.' });
  }

  if (!saleTransactionId || !mongoose.isValidObjectId(saleTransactionId)) {
    return res.status(400).json({ success: false, message: 'Valid saleTransactionId is required.' });
  }

  const transaction = await SaleTransaction.findById(saleTransactionId);
  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Sale transaction not found.' });
  }
  if (transaction.status !== 'completed') {
    return res.status(400).json({ success: false, message: 'Only completed transactions can be marked as waste.' });
  }
  if (transaction.isVoidedAsWaste) {
    return res.status(409).json({ success: false, message: 'This transaction has already been fully marked as waste.' });
  }

  // Shared logic — identical accounting impact as the POS terminal path.
  let result;
  try {
    result = await logSaleAsWaste({
      transaction,
      reason,
      notes,
      userId: req.user?.id ?? null,
      rePrepare,
      selection,
      valuationMethod,
      requirePositiveValue: true,
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    throw err;
  }
  const { wasteLog, journalEntry } = result;

  return res.status(201).json({
    success: true,
    message: rePrepare
      ? 'Sale transaction logged as waste and re-prepared (stock re-deducted).'
      : 'Sale transaction logged as waste successfully.',
    data: {
      wasteLog,
      journalEntryId: journalEntry?._id ?? null,
      valuationMethod: result.valuationMethod,
      wasteValue: result.wasteValue,
      ingredientCost: result.recipeCost,
      orderValue: result.orderValue,
      partial: result.partial,
      fullyWasted: result.fullyWasted,
      partiallyWasted: result.partiallyWasted,
    },
  });
};

// ─── getSaleWasteCostPreview ──────────────────────────────────────────────────
// GET /api/inventory/waste-log/sale-transactions/:id/cost-preview
// Returns the ingredient-cost breakdown for a transaction before it is logged
// as waste, so the frontend can show a detailed preview to the user.

export const getSaleWasteCostPreview = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid transaction ID.' });
  }

  const transaction = await SaleTransaction.findById(id)
    .select('transactionNumber totalAmount items')
    .lean();

  if (!transaction) {
    return res.status(404).json({ success: false, message: 'Transaction not found.' });
  }

  const menuItemIds = transaction.items.map((i) => i.menuItem).filter(Boolean);

  const menuItems = menuItemIds.length
    ? await MenuItem.find({ _id: { $in: menuItemIds } })
      .populate('ingredients.product', 'name vendors defaultPrice currentPrice unit')
      .populate('variations.ingredients.product', 'name vendors defaultPrice currentPrice unit')
      .lean()
    : [];

  const menuItemMap = Object.fromEntries(menuItems.map((mi) => [mi._id.toString(), mi]));

  const { breakdown, recipeCost } = computeRecipeCost(transaction.items, menuItemMap);
  const orderValues = allocateOrderValues(transaction.items, transaction.totalAmount);

  // A locked menu item must not reveal its per-ingredient composition here — keep
  // the aggregate ingredientCost (a number) but withhold the ingredient list
  // unless the caller holds a valid unlock token.
  const unlocked = hasValidUnlock(req);

  // breakdown is 1:1 (same order) with transaction.items — surface the line
  // index and remaining (un-wasted) quantity so the UI can offer per-unit
  // partial selection and avoid re-wasting units already logged.
  const items = breakdown.map((b, i) => {
    const src = transaction.items[i] || {};
    const qty = Number(src.qty) || 0;
    const wastedQty = Number(src.wastedQty) || 0;
    const mi = src.menuItem ? menuItemMap[src.menuItem.toString()] : null;
    const locked = !!mi?.recipeLocked && !unlocked;
    const entry = locked ? { ...b, ingredients: [], recipeLocked: true } : b;
    return {
      ...entry,
      index: i,
      orderValue: orderValues[i] || 0,
      wastedQty,
      remainingQty: Math.max(0, qty - wastedQty),
    };
  });

  return res.json({
    success: true,
    data: {
      transactionNumber: transaction.transactionNumber,
      saleTotal: transaction.totalAmount,
      recipeCost,
      orderValue: orderValues.reduce((sum, value) => sum + value, 0),
      items,
    },
  });
};
