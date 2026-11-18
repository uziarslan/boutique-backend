import mongoose from 'mongoose';
import Vendor from '../models/Vendor.js';
import Product from '../models/Product.js';
import Purchase from '../models/Purchase.js';
import logger from '../utils/logger.js';

// ─── getAllVendors ─────────────────────────────────────────────────────────────
// GET /api/vendors
// Query params: page, limit, status, category, search, sortBy, sortOrder

export const getAllVendors = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status,
    category,
    search,
    currency,
    contactState,
    minPaymentTerms,
    maxPaymentTerms,
    minCreditLimit,
    maxCreditLimit,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = req.query;

  const pageNum  = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * pageSize;

  // Build filter
  const filter = {};
  if (status)   filter.status   = status;
  if (category) filter.category = category;
  if (currency) filter.currency = currency;
  if (contactState === 'with-email') filter.email = { $nin: [null, ''] };
  if (contactState === 'without-email') filter.$and = [...(filter.$and || []), { $or: [{ email: { $exists: false } }, { email: '' }, { email: null }] }];
  const minTerms = Number(minPaymentTerms);
  const maxTerms = Number(maxPaymentTerms);
  if (minPaymentTerms !== undefined && minPaymentTerms !== '' && Number.isFinite(minTerms)) filter.paymentTerms = { ...(filter.paymentTerms || {}), $gte: minTerms };
  if (maxPaymentTerms !== undefined && maxPaymentTerms !== '' && Number.isFinite(maxTerms)) filter.paymentTerms = { ...(filter.paymentTerms || {}), $lte: maxTerms };
  const minCredit = Number(minCreditLimit);
  const maxCredit = Number(maxCreditLimit);
  if (minCreditLimit !== undefined && minCreditLimit !== '' && Number.isFinite(minCredit)) filter.creditLimit = { ...(filter.creditLimit || {}), $gte: minCredit };
  if (maxCreditLimit !== undefined && maxCreditLimit !== '' && Number.isFinite(maxCredit)) filter.creditLimit = { ...(filter.creditLimit || {}), $lte: maxCredit };

  if (search) {
    const re = new RegExp(search.trim(), 'i');
    filter.$or = [{ name: re }, { code: re }];
  }

  const allowedSortFields = new Set(['createdAt', 'updatedAt', 'name', 'code', 'category', 'paymentTerms', 'creditLimit']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const sortDir = sortOrder === 'asc' ? 1 : -1;
  const sortObj = { [safeSortBy]: sortDir };

  const [vendors, total] = await Promise.all([
    Vendor.find(filter)
      .sort(sortObj)
      .skip(skip)
      .limit(pageSize)
      .populate('createdBy', 'name email')
      .lean(),
    Vendor.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: {
      vendors,
      total,
      page: pageNum,
      pages: Math.ceil(total / pageSize),
    },
  });
};

// ─── createVendor ─────────────────────────────────────────────────────────────
// POST /api/vendors

export const createVendor = async (req, res) => {
  const vendor = await Vendor.create({ ...req.body, createdBy: req.user.id });

  // Attach audit hints for audit.middleware
  req.auditRecordId = vendor._id;
  req.auditAfter    = vendor.toObject();

  logger.info(`Vendor created: ${vendor.code} — ${vendor.name} by user ${req.user.id}`);

  return res.status(201).json({ success: true, data: vendor });
};

// ─── getVendorById ────────────────────────────────────────────────────────────
// GET /api/vendors/:id

export const getVendorById = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid vendor ID.' });
  }

  // Run the vendor fetch and both counts in parallel
  const [vendor, productCountResult, poCountResult] = await Promise.all([
    Vendor.findById(id).populate('createdBy', 'name email').lean(),

    Product.countDocuments({ 'vendors.vendorId': new mongoose.Types.ObjectId(id) }),
    Purchase.countDocuments({
      vendor: new mongoose.Types.ObjectId(id),
      status: { $in: ['draft', 'pendingApproval'] },
    }),
  ]);

  if (!vendor) {
    return res.status(404).json({ success: false, message: 'Vendor not found.' });
  }

  return res.json({
    success: true,
    data: { ...vendor, productCount: productCountResult, openPoCount: poCountResult },
  });
};

// ─── updateVendor ─────────────────────────────────────────────────────────────
// PUT /api/vendors/:id

export const updateVendor = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid vendor ID.' });
  }

  const before = await Vendor.findById(id).lean();
  if (!before) {
    return res.status(404).json({ success: false, message: 'Vendor not found.' });
  }

  const updated = await Vendor.findByIdAndUpdate(id, req.body, {
    returnDocument: 'after',
    runValidators: true,
  }).lean();

  // Attach audit hints
  req.auditRecordId = updated._id;
  req.auditBefore   = before;
  req.auditAfter    = updated;

  logger.info(`Vendor updated: ${updated.code} by user ${req.user.id}`);

  return res.json({ success: true, data: updated });
};

// ─── deleteVendor ─────────────────────────────────────────────────────────────
// DELETE /api/vendors/:id  (soft delete — sets status: inactive)

export const deleteVendor = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid vendor ID.' });
  }

  const vendor = await Vendor.findById(id).lean();
  if (!vendor) {
    return res.status(404).json({ success: false, message: 'Vendor not found.' });
  }

  const unpaidCount = await Purchase.countDocuments({
    vendor: new mongoose.Types.ObjectId(id),
    deletedAt: null,
    status: { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] },
  });
  if (unpaidCount > 0) {
    return res.status(409).json({
      success: false,
      message: `Cannot deactivate vendor: ${unpaidCount} open purchase(s) remain.`,
    });
  }

  const updated = await Vendor.findByIdAndUpdate(
    id,
    { status: 'inactive' },
    { returnDocument: 'after' }
  ).lean();

  // Attach audit hints
  req.auditRecordId = updated._id;
  req.auditBefore   = vendor;
  req.auditAfter    = updated;

  logger.info(`Vendor soft-deleted (inactive): ${vendor.code} by user ${req.user.id}`);

  return res.json({
    success: true,
    message: 'Vendor deactivated successfully.',
    data: updated,
  });
};

// ─── getPriceHistory ──────────────────────────────────────────────────────────
// GET /api/vendors/:id/price-history

export const getPriceHistory = async (req, res) => {
  const { id } = req.params;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid vendor ID.' });
  }

  const vendorExists = await Vendor.exists({ _id: id });
  if (!vendorExists) {
    return res.status(404).json({ success: false, message: 'Vendor not found.' });
  }

  const vendorOid = new mongoose.Types.ObjectId(id);

  /*
   * Pipeline:
   *  1. Match products that have at least one vendor entry for this vendorId.
   *  2. Unwind the vendors array to work per-vendor-entry.
   *  3. Filter to entries belonging to our vendor.
   *  4. Project product info + priceHistory array.
   *  5. Sort priceHistory entries newest-first inside each product.
   */
  const results = await Product.aggregate([
    { $match: { 'vendors.vendorId': vendorOid } },
    { $unwind: '$vendors' },
    { $match: { 'vendors.vendorId': vendorOid } },
    {
      $project: {
        _id: 1,
        name: 1,
        sku: 1,
        unit: 1,
        vendorProductCode: '$vendors.vendorProductCode',
        packSize: '$vendors.packSize',
        currentPrice: '$vendors.currentPrice',
        priceHistory: {
          $sortArray: {
            input: '$vendors.priceHistory',
            sortBy: { date: -1 },
          },
        },
      },
    },
    { $sort: { name: 1 } },
  ]);

  return res.json({ success: true, data: results });
};
