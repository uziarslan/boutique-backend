import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Purchase from '../models/Purchase.js';
import { recomputeAllPrepCosts } from './prepRecipe.controller.js';
import logger from '../utils/logger.js';

// ─── getAllProducts ────────────────────────────────────────────────────────────
// GET /api/products
// Query: page, limit, category, isActive, search, sortBy, sortOrder

export const getAllProducts = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    category,
    isActive,
    search,
    kind,
    unit,
    storageLocation,
    vendorState,
    minParLevel,
    maxParLevel,
    minPrice,
    maxPrice,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * pageSize;

  const filter = {};
  if (category !== undefined) filter.category = category;
  if (isActive !== undefined) filter.isActive  = isActive === 'true';
  if (unit) filter.unit = unit;
  if (storageLocation) filter.storageLocation = storageLocation;
  if (vendorState === 'with-vendor') filter['vendors.0'] = { $exists: true };
  if (vendorState === 'without-vendor') filter['vendors.0'] = { $exists: false };
  const minPar = Number(minParLevel);
  const maxPar = Number(maxParLevel);
  if (minParLevel !== undefined && minParLevel !== '' && Number.isFinite(minPar)) filter.parLevel = { ...(filter.parLevel || {}), $gte: minPar };
  if (maxParLevel !== undefined && maxParLevel !== '' && Number.isFinite(maxPar)) filter.parLevel = { ...(filter.parLevel || {}), $lte: maxPar };
  const minimumPrice = Number(minPrice);
  const maximumPrice = Number(maxPrice);
  if (minPrice !== undefined && minPrice !== '' && Number.isFinite(minimumPrice)) filter.currentPrice = { ...(filter.currentPrice || {}), $gte: minimumPrice };
  if (maxPrice !== undefined && maxPrice !== '' && Number.isFinite(maximumPrice)) filter.currentPrice = { ...(filter.currentPrice || {}), $lte: maximumPrice };
  // kind filter: 'standard' hides prep-recipe backing products from the raw
  // catalog; 'prep' shows only those. Omitted → all kinds (legacy behaviour).
  if (kind === 'standard') {
    // Treat legacy docs with no `kind` as standard.
    filter.$and = [...(filter.$and || []), { $or: [{ kind: 'standard' }, { kind: { $exists: false } }] }];
  } else if (kind === 'prep') {
    filter.kind = 'prep';
  }

  if (search) {
    const re = new RegExp(search.trim(), 'i');
    filter.$or = [{ name: re }, { sku: re }];
  }

  const allowedSortFields = new Set(['createdAt', 'updatedAt', 'name', 'sku', 'category', 'unit', 'parLevel', 'currentPrice']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ [safeSortBy]: sortDir })
      .skip(skip)
      .limit(pageSize)
      .populate('vendors.vendorId', 'name code')
      .populate('createdBy', 'name email')
      .lean(),
    Product.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { products, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── createProduct ────────────────────────────────────────────────────────────
// POST /api/products

export const createProduct = async (req, res) => {
  const product = await Product.create({ ...req.body, createdBy: req.user.id });

  req.auditRecordId = product._id;
  req.auditAfter    = product.toObject();

  logger.info(`Product created: ${product.sku} — ${product.name} by user ${req.user.id}`);

  return res.status(201).json({ success: true, data: product });
};

// ─── getProductById ───────────────────────────────────────────────────────────
// GET /api/products/:id

export const getProductById = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const product = await Product.findById(id)
    .populate('vendors.vendorId',          'name code currency paymentTerms')
    .populate('vendors.priceHistory.changedBy', 'name email')
    .populate('vendors.priceHistory.purchase', 'purchaseNumber')
    .populate('vendors.priceHistory.purchaseAdjustment', 'adjustmentNumber')
    .populate('priceHistory.changedBy', 'name email')
    .populate('priceHistory.vendorId', 'name code')
    .populate('priceHistory.purchase', 'purchaseNumber')
    .populate('priceHistory.purchaseAdjustment', 'adjustmentNumber')
    .populate('createdBy', 'name email')
    .lean();

  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  return res.json({ success: true, data: product });
};

// ─── updateProduct ────────────────────────────────────────────────────────────
// PUT /api/products/:id
//
// Vendor price-change logic:
//   For each vendor entry in req.body.vendors:
//     - Find the existing entry by vendorId
//     - If currentPrice changed: push old price to priceHistory, set lastPrice
//     - If change > 10%: logger.warn

export const updateProduct = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  // Fetch the live Mongoose document (not lean) so we can mutate and save
  const product = await Product.findById(id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  const before = product.toObject();

  // ── Apply top-level field updates ───────────────────────────────────────────
  const { vendors: vendorUpdates, ...topLevelFields } = req.body;

  const TOP_LEVEL = ['name', 'category', 'unit', 'storageLocation',
                     'shelfLifeDays', 'parLevel', 'reorderQty', 'isActive'];

  for (const field of TOP_LEVEL) {
    if (field in topLevelFields) {
      product[field] = topLevelFields[field];
    }
  }

  // Track the latest edited unit price so we can mirror it onto the product's
  // canonical currentPrice (the cost basis recipe/COGS costing reads).
  let editedUnitPrice = null;

  // ── Reconcile vendor links ───────────────────────────────────────────────────
  // The vendors array is reconciled only when the client explicitly sends it. The
  // Product form always submits every linked vendor as {vendorId, vendorProductCode},
  // so any vendor on the product but absent from the payload was removed by the
  // user — we unlink it (which also drops that entry's priceHistory; the intended
  // consequence of an explicit unlink). Requests that omit `vendors` entirely
  // (partial updates) leave the existing vendor list untouched.
  if (Array.isArray(vendorUpdates)) {
    // Unlink vendors no longer present in the payload.
    const incomingVendorIds = new Set(
      vendorUpdates
        .filter((v) => v && v.vendorId != null)
        .map((v) => v.vendorId.toString())
    );
    for (let i = product.vendors.length - 1; i >= 0; i -= 1) {
      if (!incomingVendorIds.has(product.vendors[i].vendorId.toString())) {
        product.vendors.splice(i, 1);
      }
    }

    // Merge in / update the vendors present in the payload.
    for (const incoming of vendorUpdates) {
      const existingIdx = product.vendors.findIndex(
        (v) => v.vendorId.toString() === incoming.vendorId.toString()
      );

      if (existingIdx === -1) {
        // New vendor entry for this product — add it
        product.vendors.push({
          vendorId:          incoming.vendorId,
          vendorProductCode: incoming.vendorProductCode ?? '',
          packSize:          incoming.packSize ?? '',
          currentPrice:      incoming.currentPrice ?? 0,
          lastPrice:         0,
          priceHistory:      [],
        });
        if (incoming.currentPrice != null) editedUnitPrice = Number(incoming.currentPrice);
        continue;
      }

      const entry = product.vendors[existingIdx];

      // Update non-price fields if provided
      if (incoming.vendorProductCode !== undefined) entry.vendorProductCode = incoming.vendorProductCode;
      if (incoming.packSize          !== undefined) entry.packSize          = incoming.packSize;

      // Handle price change
      if (incoming.currentPrice !== undefined && incoming.currentPrice !== entry.currentPrice) {
        const oldPrice = entry.currentPrice;
        const newPrice = incoming.currentPrice;

        // Guard against division by zero
        if (oldPrice > 0) {
          const changePct = Math.abs((newPrice - oldPrice) / oldPrice) * 100;
          if (changePct > 10) {
            logger.warn(
              `Price change >10% on "${product.name}" [${product.sku}] ` +
              `vendor ${incoming.vendorId}: ${oldPrice} → ${newPrice} ` +
              `(${changePct.toFixed(1)}%)`
            );
          }
        }

        // Archive old price
        entry.priceHistory.push({
          price:     oldPrice,
          date:      new Date(),
          changedBy: new mongoose.Types.ObjectId(req.user.id),
        });

        entry.lastPrice    = oldPrice;
        entry.currentPrice = newPrice;
        editedUnitPrice    = Number(newPrice);
      }
    }
  }

  // A direct top-level price edit (if the form ever sends one) also drives cost.
  if (topLevelFields.currentPrice != null) editedUnitPrice = Number(topLevelFields.currentPrice);

  // Mirror the edited price onto currentPrice — the canonical cost basis read by
  // recipe & COGS costing — so changing a product's price updates menu-item cost.
  if (editedUnitPrice != null && Number.isFinite(editedUnitPrice) && editedUnitPrice !== product.currentPrice) {
    product.lastPrice = product.currentPrice || 0;
    product.currentPrice = editedUnitPrice;
  }

  await product.save();

  // If the cost changed, re-roll prep-recipe costs so any prep (and the menu
  // items that use it) reflect the new ingredient price. Non-blocking.
  if (editedUnitPrice != null) {
    try {
      await recomputeAllPrepCosts();
    } catch (err) {
      logger.error(`Prep cost recompute after product ${product.sku} price edit failed: ${err.message}`);
    }
  }

  req.auditRecordId = product._id;
  req.auditBefore   = before;
  req.auditAfter    = product.toObject();

  logger.info(`Product updated: ${product.sku} by user ${req.user.id}`);

  return res.json({ success: true, data: product });
};

// ─── deleteProduct ────────────────────────────────────────────────────────────
// DELETE /api/products/:id  (soft delete — isActive: false)

export const deleteProduct = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }

  const product = await Product.findById(id).lean();
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  const openPurchaseCount = await Purchase.countDocuments({
    'lines.product': new mongoose.Types.ObjectId(id),
    status: { $in: ['draft', 'pendingApproval'] },
  });
  if (openPurchaseCount > 0) {
    return res.status(409).json({
      success: false,
      message: `Cannot deactivate product: referenced in ${openPurchaseCount} draft purchase(s).`,
    });
  }

  const updated = await Product.findByIdAndUpdate(
    id,
    { isActive: false },
    { returnDocument: 'after' }
  ).lean();

  req.auditRecordId = updated._id;
  req.auditBefore   = product;
  req.auditAfter    = updated;

  logger.info(`Product soft-deleted: ${product.sku} by user ${req.user.id}`);

  return res.json({
    success: true,
    message: 'Product deactivated successfully.',
    data: updated,
  });
};

// ─── getBelowPar ──────────────────────────────────────────────────────────────
// GET /api/products/below-par
//
// Aggregates Product ⟶ StockItem, sums qtyOnHand across all outlets,
// returns products where total stock < parLevel.
// Includes primary vendor name via $lookup.

export const getBelowPar = async (req, res) => {
  /*
   * Pipeline:
   *  1. Active products with a parLevel > 0
   *  2. Lookup StockItems for each product (all outlets)
   *  3. Sum qtyOnHand across outlets
   *  4. Filter where sum < parLevel
   *  5. Lookup primary vendor (vendors[0]) for name
   *  6. Project to the fields the frontend needs
   */
  const results = await Product.aggregate([
    { $match: { isActive: true, parLevel: { $gt: 0 } } },
    {
      $lookup: {
        from:         'stockitems',
        localField:   '_id',
        foreignField: 'product',
        as:           'stockEntries',
      },
    },
    {
      $addFields: {
        qtyOnHand: { $sum: '$stockEntries.qtyOnHand' },
      },
    },
    {
      $match: {
        $expr: { $lt: ['$qtyOnHand', '$parLevel'] },
      },
    },
    // Lookup the primary vendor (first entry in vendors array)
    {
      $lookup: {
        from: 'vendors',
        let:  { primaryVendorId: { $arrayElemAt: ['$vendors.vendorId', 0] } },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$primaryVendorId'] } } },
          { $project: { name: 1, code: 1 } },
        ],
        as: 'primaryVendorData',
      },
    },
    {
      $project: {
        name:          1,
        sku:           1,
        unit:          1,
        category:      1,
        parLevel:      1,
        reorderQty:    1,
        qtyOnHand:     1,
        primaryVendor: { $arrayElemAt: ['$primaryVendorData.name', 0] },
      },
    },
    { $sort: { name: 1 } },
  ]);

  return res.json({ success: true, data: results });
};
