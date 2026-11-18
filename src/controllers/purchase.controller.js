import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import PurchaseAdjustment from '../models/PurchaseAdjustment.js';
import Payment from '../models/Payment.js';
import Product from '../models/Product.js';
import Vendor from '../models/Vendor.js';
import Asset from '../models/Asset.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetMovement from '../models/AssetMovement.js';
import JournalEntry from '../models/JournalEntry.js';
import Outlet from '../models/Outlet.js';
import StockItem from '../models/StockItem.js';
import StockMovement from '../models/StockMovement.js';
import { postPurchaseDocument, aggregatePurchaseLines } from '../services/purchase.service.js';
import { updatePurchaseJournalInPlace } from '../services/purchaseJournalDate.service.js';
import {
  recordPurchasePayment,
  reconcileFullyPaidPurchasePayments,
  restorePurchasePaymentVendors,
  syncPurchasePaymentVendor,
} from '../services/payment.service.js';
import { reverseJournalEntry } from '../accounting/journalEngine.js';
import {
  enabledAssetAuditOutletIds,
  isAssetAuditEnabledForOutlet,
} from '../services/assetFeature.service.js';
import { ensureAssetDefaults } from '../services/assetDefaults.service.js';
import {
  purchaseLineTreatment as lineTreatment,
  validatePurchaseLineInputs,
} from '../utils/purchaseLineValidation.js';
import { normalizeLegacyProductPriceHistory } from '../utils/productPriceHistory.js';
import bucketize from '../utils/agingReport.js';
import { buildPurchaseJournalDeletionIds, runPurchaseDeletionRollback } from '../utils/purchaseDeletion.js';

const round4 = (value) => Number((Number(value) || 0).toFixed(4));
const PAYABLE_STATUSES = ['open', 'partiallyPaid', 'corrected', 'migrationReview'];
const POSTED_STATUSES = [...PAYABLE_STATUSES, 'paid', 'disputed'];
const activePurchaseById = (id) => Purchase.findOne({ _id: id, deletedAt: null });
const populated = (query) => query
  .populate('vendor', 'name code currency paymentTerms')
  .populate('outlet', 'name code')
  .populate('lines.product', 'name sku unit packSize')
  .populate('lines.assetCategory', 'code name trackingMode defaultUnit defaultUsefulLifeMonths depreciationMethod accounts')
  .populate('lines.assetAccount', 'code name type')
  .populate('postedBy', 'name email')
  .populate('createdBy', 'name email')
  .populate('journalEntryId', 'entryNumber date description sourcePath');

const cleanLines = (lines = [], purchaseType = 'stock') => lines
  .filter((line) => Number(line.qty ?? line.quantity) > 0)
  .map((line) => {
    const accountingTreatment = lineTreatment(purchaseType, line);
    const entryMode = accountingTreatment === 'inventory' && line.entryMode === 'pack'
      ? 'pack'
      : 'loose';
    return {
      product: accountingTreatment === 'inventory'
        ? (line.product?._id || line.product || null)
        : null,
      productName: line.productName || line.product?.name || line.name || line.description,
      description: line.description || line.name || line.productName,
      accountingTreatment,
      assetCategory: accountingTreatment === 'asset'
        ? (line.assetCategory?._id || line.assetCategory || null)
        : null,
      assetAccount: accountingTreatment === 'asset'
        ? (line.assetAccount?._id || line.assetAccount || null)
        : null,
      assetLocation: accountingTreatment === 'asset'
        ? String(line.assetLocation || '').trim()
        : '',
      assetUsefulLifeMonths: accountingTreatment === 'asset' && line.assetUsefulLifeMonths
        ? Math.max(1, Number(line.assetUsefulLifeMonths) || 1)
        : null,
      assetResidualValue: accountingTreatment === 'asset'
        && line.assetResidualValue !== undefined
        && line.assetResidualValue !== ''
        ? Math.max(0, Number(line.assetResidualValue) || 0)
        : null,
      qty: Number(line.qty ?? line.quantity) || 0,
      entryMode,
      packSize: entryMode === 'pack' ? Math.max(1, Number(line.packSize) || 1) : 1,
      unit: line.unit || line.product?.unit || '',
      priceEntryMode: line.priceEntryMode === 'total' ? 'total' : 'unit',
      unitPrice: Number(line.unitPrice) || 0,
      lineDiscount: Math.max(0, Number(line.lineDiscount) || 0),
      notes: line.notes,
    };
  });

const assignPurchase = (purchase, body) => {
  if (body.type !== undefined) {
    purchase.type = ['stock', 'expense', 'mixed'].includes(body.type) ? body.type : 'stock';
  }
  if (body.vendor !== undefined) purchase.vendor = mongoose.isValidObjectId(body.vendor) ? body.vendor : null;
  if (body.vendorName !== undefined) purchase.vendorName = String(body.vendorName || '').trim();
  if (body.vendorInvoiceNumber !== undefined) purchase.vendorInvoiceNumber = String(body.vendorInvoiceNumber || '').trim();
  if (body.purchaseDate) purchase.purchaseDate = new Date(body.purchaseDate);
  if (body.dueDate !== undefined) purchase.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (body.outlet !== undefined) purchase.outlet = mongoose.isValidObjectId(body.outlet) ? body.outlet : null;
  if (body.destination !== undefined) {
    purchase.destination = ['store', 'kitchen', 'none'].includes(body.destination) ? body.destination : 'store';
  }
  if (Array.isArray(body.lines)) {
    validatePurchaseLineInputs(body.lines, purchase.type);
    purchase.lines = cleanLines(body.lines, purchase.type);
  }
  if (body.discountAmount !== undefined) purchase.discountAmount = Math.max(0, Number(body.discountAmount) || 0);
  if (body.taxRate !== undefined) purchase.taxRate = Math.max(0, Number(body.taxRate) || 0);
  if (body.aitRate !== undefined) purchase.aitRate = Math.max(0, Number(body.aitRate) || 0);
  if (body.notes !== undefined) purchase.notes = String(body.notes || '').trim();
};

const hydratePurchaseSnapshots = async (purchase, tenant) => {
  if (purchase.vendor) {
    const vendor = await Vendor.findById(purchase.vendor).select('name currency').lean();
    if (!vendor) throw new Error('The selected vendor no longer exists.');
    purchase.vendorName = vendor.name;
    if (vendor.currency) purchase.currency = vendor.currency;
  }
  const productIds = purchase.lines
    .filter((line) => lineTreatment(purchase.type, line) === 'inventory')
    .map((line) => line.product?._id || line.product)
    .filter(Boolean);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } }).select('name unit packSize').lean()
    : [];
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));
  const categoryIds = purchase.lines
    .filter((line) => lineTreatment(purchase.type, line) === 'asset')
    .map((line) => line.assetCategory?._id || line.assetCategory)
    .filter(Boolean);
  const categories = categoryIds.length
    ? await AssetCategory.find({ _id: { $in: categoryIds }, isActive: true }).lean()
    : [];
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));

  for (const line of purchase.lines) {
    const treatment = lineTreatment(purchase.type, line);
    line.accountingTreatment = treatment;
    if (treatment === 'inventory') {
      if (!line.product) throw new Error('Every inventory line must have an item.');
      const product = productMap.get((line.product?._id || line.product).toString());
      if (!product) throw new Error('One of the selected products no longer exists.');
      line.productName = product.name;
      line.description = line.description || product.name;
      line.unit = product.unit;
      continue;
    }
    line.product = null;
    line.entryMode = 'loose';
    line.packSize = 1;
    if (treatment === 'expense') {
      if (!String(line.description || '').trim()) {
        throw new Error('Every expense line must have a description.');
      }
      continue;
    }

    if (!purchase.outlet || !isAssetAuditEnabledForOutlet(tenant, purchase.outlet)) {
      const err = new Error('Asset Register & Audit must be enabled for the selected outlet before an asset can be purchased.');
      err.statusCode = 403;
      throw err;
    }
    const categoryId = line.assetCategory?._id || line.assetCategory;
    const category = categoryMap.get(String(categoryId || ''));
    if (!category) throw new Error('Every asset line must have an active asset category.');
    if (!category.accounts?.asset) {
      throw new Error(`Asset category "${category.name}" does not have a fixed-asset COA head.`);
    }
    if (category.trackingMode === 'serialized' && !Number.isInteger(Number(line.qty))) {
      throw new Error(`"${line.description || category.name}" uses serialized tracking, so its quantity must be a whole number.`);
    }
    line.assetCategory = category._id;
    line.assetAccount = category.accounts.asset;
    line.productName = line.description || category.name;
    line.description = line.description || category.name;
    line.unit = category.defaultUnit || line.unit || 'unit';
    line.assetUsefulLifeMonths = Math.max(
      1,
      Number(line.assetUsefulLifeMonths) || Number(category.defaultUsefulLifeMonths) || 60,
    );
  }
  purchase.recalculateTotals();
};

export const listPurchases = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status,
    vendor,
    outlet,
    from,
    to,
    search,
    type,
    destination,
    paymentState,
    dueState,
    billState,
    minAmount,
    maxAmount,
    sort = 'newest',
  } = req.query;
  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 20));
  const filter = { deletedAt: null };
  const and = [];
  if (status) filter.status = status;
  if (mongoose.isValidObjectId(vendor)) filter.vendor = vendor;
  if (mongoose.isValidObjectId(outlet)) filter.outlet = outlet;
  if (['stock', 'expense', 'mixed'].includes(type)) filter.type = type;
  if (['store', 'kitchen', 'none'].includes(destination)) filter.destination = destination;
  if (from || to) {
    filter.purchaseDate = {};
    if (from) filter.purchaseDate.$gte = new Date(from);
    if (to) filter.purchaseDate.$lte = new Date(`${to}T23:59:59.999Z`);
  }
  const min = Number(minAmount);
  const max = Number(maxAmount);
  if ((minAmount !== undefined && minAmount !== '' && Number.isFinite(min))
    || (maxAmount !== undefined && maxAmount !== '' && Number.isFinite(max))) {
    filter.totalAmount = {};
    if (minAmount !== undefined && minAmount !== '' && Number.isFinite(min)) filter.totalAmount.$gte = Math.max(0, min);
    if (maxAmount !== undefined && maxAmount !== '' && Number.isFinite(max)) filter.totalAmount.$lte = Math.max(0, max);
  }

  if (paymentState === 'outstanding') {
    and.push({ status: { $in: PAYABLE_STATUSES } });
    and.push({ $expr: { $gt: ['$totalAmount', '$amountPaid'] } });
  } else if (paymentState === 'unpaid') {
    and.push({ status: { $in: PAYABLE_STATUSES } });
    and.push({ $expr: { $and: [
      { $gt: ['$totalAmount', '$amountPaid'] },
      { $lte: ['$amountPaid', 0] },
    ] } });
  } else if (paymentState === 'partial') {
    and.push({ status: { $in: PAYABLE_STATUSES } });
    and.push({ $expr: { $and: [
      { $gt: ['$amountPaid', 0] },
      { $lt: ['$amountPaid', '$totalAmount'] },
    ] } });
  } else if (paymentState === 'settled') {
    and.push({ status: 'paid' });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (dueState === 'overdue') {
    and.push({ status: { $in: PAYABLE_STATUSES } });
    and.push({ dueDate: { $ne: null, $lt: today } });
  } else if (dueState === 'next7') {
    const sevenDays = new Date(today);
    sevenDays.setDate(sevenDays.getDate() + 7);
    and.push({ status: { $in: PAYABLE_STATUSES } });
    and.push({ dueDate: { $gte: today, $lte: sevenDays } });
  } else if (dueState === 'noDueDate') {
    and.push({ dueDate: null });
  } else if (dueState === 'hasDueDate') {
    and.push({ dueDate: { $ne: null } });
  }

  if (billState === 'withBill') and.push({ vendorInvoiceNumber: { $nin: [null, ''] } });
  if (billState === 'withoutBill') and.push({ vendorInvoiceNumber: { $in: [null, ''] } });
  if (and.length) filter.$and = and;

  if (String(search || '').trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    filter.$or = [
      { purchaseNumber: regex },
      { vendorInvoiceNumber: regex },
      { itemSummary: regex },
      { vendorName: regex },
      { notes: regex },
      { 'lines.productName': regex },
      { 'lines.description': regex },
    ];
  }
  const sortBy = {
    newest: { purchaseDate: -1, createdAt: -1 },
    oldest: { purchaseDate: 1, createdAt: 1 },
    amountHigh: { totalAmount: -1, purchaseDate: -1 },
    amountLow: { totalAmount: 1, purchaseDate: -1 },
    dueSoonest: { dueDate: 1, purchaseDate: -1 },
  }[sort] || { purchaseDate: -1, createdAt: -1 };
  const [purchases, total, summaryRows] = await Promise.all([
    populated(Purchase.find(filter)
      .sort(sortBy)
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize)).lean(),
    Purchase.countDocuments(filter),
    Purchase.aggregate([
      { $match: filter },
      { $group: {
        _id: null,
        total: { $sum: { $cond: [{ $in: ['$status', POSTED_STATUSES] }, '$totalAmount', 0] } },
        paid: { $sum: { $cond: [{ $in: ['$status', POSTED_STATUSES] }, '$amountPaid', 0] } },
        open: {
          $sum: {
            $cond: [
              { $in: ['$status', PAYABLE_STATUSES] },
              { $max: [0, { $subtract: ['$totalAmount', '$amountPaid'] }] },
              0,
            ],
          },
        },
        drafts: { $sum: { $cond: [{ $in: ['$status', ['draft', 'pendingApproval']] }, 1, 0] } },
        review: { $sum: { $cond: [{ $eq: ['$status', 'migrationReview'] }, 1, 0] } },
        reversed: { $sum: { $cond: [{ $eq: ['$status', 'reversed'] }, 1, 0] } },
      } },
    ]),
  ]);
  return res.json({
    success: true,
    data: {
      purchases, total, page: pageNum, pages: Math.ceil(total / pageSize),
      summary: summaryRows[0] || {
        total: 0, paid: 0, open: 0, drafts: 0, review: 0, reversed: 0,
      },
    },
  });
};

export const getPurchaseAssetOptions = async (req, res) => {
  const enabledIds = enabledAssetAuditOutletIds(req.tenant).filter(mongoose.isValidObjectId);
  if (!enabledIds.length) {
    return res.json({
      success: true,
      data: { enabled: false, outlets: [], categories: [] },
    });
  }
  await ensureAssetDefaults();
  const [outlets, categories] = await Promise.all([
    Outlet.find({ _id: { $in: enabledIds }, isActive: true })
      .select('name code')
      .sort({ name: 1 })
      .lean(),
    AssetCategory.find({ isActive: true })
      .select('code name trackingMode defaultUnit defaultUsefulLifeMonths defaultResidualValuePercent depreciationMethod capitalisationThreshold accounts.asset')
      .populate('accounts.asset', 'code name type')
      .sort({ name: 1 })
      .lean(),
  ]);
  return res.json({
    success: true,
    data: {
      enabled: outlets.length > 0,
      outlets,
      categories: categories.filter((category) => category.accounts?.asset),
    },
  });
};

export const getPurchase = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid purchase ID.' });
  }
  const purchase = await populated(activePurchaseById(req.params.id)).lean();
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  const [payments, adjustments, assets] = await Promise.all([
    Payment.find({ purchase: purchase._id })
      .populate('recordedBy', 'name email')
      .populate('journalEntryId', 'entryNumber date description sourcePath')
      .sort({ paymentDate: -1 }).lean(),
    PurchaseAdjustment.find({ purchase: purchase._id })
      .populate('createdBy', 'name email')
      .populate('journalEntryId', 'entryNumber date description sourcePath')
      .sort({ createdAt: -1 }).lean(),
    Asset.find({ purchase: purchase._id })
      .populate('category', 'code name trackingMode')
      .select('assetNumber name category trackingMode quantity originalCost status purchaseLineId')
      .sort({ assetNumber: 1 })
      .lean(),
  ]);
  return res.json({ success: true, data: {
    ...purchase, payments, adjustments, assets,
  } });
};

export const getPurchaseAging = async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const filter = { deletedAt: null, status: { $in: PAYABLE_STATUSES } };
  if (req.query.outlet && mongoose.isValidObjectId(req.query.outlet)) {
    filter.outlet = new mongoose.Types.ObjectId(req.query.outlet);
  }
  const purchases = await Purchase.find(filter).populate('vendor', 'name code').lean();
  const bucketKeys = {
    current: 'current',
    '1-30': 'bucket1to30',
    '31-60': 'bucket31to60',
    '61-90': 'bucket61to90',
    '90plus': 'bucket90plus',
  };
  const vendorMap = new Map();
  for (const purchase of purchases) {
    const vendorId = purchase.vendor?._id?.toString() || 'unknown';
    if (!vendorMap.has(vendorId)) {
      vendorMap.set(vendorId, {
        vendorId,
        vendorName: purchase.vendor?.name || purchase.vendorName || 'Unknown',
        vendorCode: purchase.vendor?.code || '',
        current: 0,
        bucket1to30: 0,
        bucket31to60: 0,
        bucket61to90: 0,
        bucket90plus: 0,
        total: 0,
      });
    }
    const row = vendorMap.get(vendorId);
    const balance = round4(purchase.totalAmount - purchase.amountPaid);
    const key = bucketKeys[bucketize(purchase.dueDate, today)];
    row[key] = round4(row[key] + balance);
    row.total = round4(row.total + balance);
  }
  const vendors = [...vendorMap.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  const totals = vendors.reduce((acc, row) => {
    for (const key of ['current', 'bucket1to30', 'bucket31to60', 'bucket61to90', 'bucket90plus', 'total']) {
      acc[key] = round4(acc[key] + row[key]);
    }
    return acc;
  }, { current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucket90plus: 0, total: 0 });
  return res.json({ success: true, data: { vendors, totals } });
};

export const createPurchase = async (req, res) => {
  const postNow = req.body.postNow === true;
  if (postNow && !req.user.hasPermission('purchases.post')) {
    return res.status(403).json({ success: false, message: 'You do not have permission to post purchases.' });
  }
  if (postNow && req.body.paymentStatus === 'paid' && !req.user.hasPermission('payments.record')) {
    return res.status(403).json({ success: false, message: 'You do not have permission to record payments.' });
  }

  const purchase = new Purchase({ createdBy: req.user.id });
  assignPurchase(purchase, req.body);
  await hydratePurchaseSnapshots(purchase, req.tenant);
  if (!purchase.lines.length) {
    return res.status(422).json({ success: false, message: 'Add at least one item with a quantity.' });
  }
  await purchase.save();

  let payment = null;
  if (postNow) {
    await postPurchaseDocument(purchase, req.user.id, { tenant: req.tenant });
    if (req.body.paymentStatus === 'paid') {
      const result = await recordPurchasePayment(purchase, {
        amount: purchase.totalAmount,
        method: req.body.paymentMethod || 'cash',
        reference: req.body.paymentReference,
        paymentDate: purchase.purchaseDate,
        notes: req.body.paymentNotes,
        userId: req.user.id,
      });
      payment = result.payment;
    }
  }

  req.auditRecordId = purchase._id;
  req.auditAfter = purchase.toObject();
  return res.status(201).json({
    success: true,
    message: postNow
      ? (payment ? 'Purchase posted and paid.' : 'Purchase posted on credit.')
      : 'Purchase saved as draft.',
    data: { purchase, payment },
  });
};

export const updateDraftPurchase = async (req, res) => {
  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (!['draft', 'pendingApproval'].includes(purchase.status)) {
    return res.status(409).json({ success: false, message: 'Posted purchases must be corrected, not edited.' });
  }
  const before = purchase.toObject();
  assignPurchase(purchase, req.body);
  await hydratePurchaseSnapshots(purchase, req.tenant);
  await purchase.save();
  req.auditRecordId = purchase._id;
  req.auditBefore = before;
  req.auditAfter = purchase.toObject();
  return res.json({ success: true, message: 'Draft purchase updated.', data: purchase });
};

export const postPurchaseById = async (req, res) => {
  if (req.body.paymentStatus === 'paid' && !req.user.hasPermission('payments.record')) {
    return res.status(403).json({ success: false, message: 'You do not have permission to record payments.' });
  }
  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  const before = purchase.toObject();
  const journalEntry = await postPurchaseDocument(purchase, req.user.id, { tenant: req.tenant });
  let payment = null;
  if (req.body.paymentStatus === 'paid') {
    const result = await recordPurchasePayment(purchase, {
      amount: purchase.totalAmount,
      method: req.body.paymentMethod || 'cash',
      reference: req.body.paymentReference,
      paymentDate: purchase.purchaseDate,
      userId: req.user.id,
    });
    payment = result.payment;
  }
  req.auditRecordId = purchase._id;
  req.auditBefore = before;
  req.auditAfter = purchase.toObject();
  return res.json({ success: true, data: { purchase, payment, journalEntry } });
};

const stockDeltaRows = (beforeLines, afterLines) => {
  const before = aggregatePurchaseLines(beforeLines);
  const after = aggregatePurchaseLines(afterLines);
  return [...new Set([...before.keys(), ...after.keys()])].map((key) => ({
    key,
    product: after.get(key)?.product || before.get(key)?.product,
    units: round4((after.get(key)?.units || 0) - (before.get(key)?.units || 0)),
    spend: round4((after.get(key)?.spend || 0) - (before.get(key)?.spend || 0)),
  })).filter((row) => row.units || row.spend);
};

const appliedStockRows = async (purchase) => {
  const adjustmentIds = await PurchaseAdjustment.find({
    purchase: purchase._id,
    inventoryAction: { $ne: 'keep' },
  }).distinct('_id');
  return StockMovement.aggregate([
    {
      $match: {
        $or: [
          { 'ref.kind': 'purchase', 'ref.id': purchase._id },
          { 'ref.kind': 'purchaseAdjustment', 'ref.id': { $in: adjustmentIds } },
        ],
      },
    },
    {
      $group: {
        _id: { product: '$product', outlet: '$outlet', area: '$area', unit: '$unit' },
        units: { $sum: '$qty' },
        value: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ['$value', 0] }, 0] },
              '$value',
              { $multiply: ['$qty', { $ifNull: ['$unitCost', 0] }] },
            ],
          },
        },
      },
    },
    { $match: { units: { $ne: 0 } } },
    {
      $project: {
        _id: 0,
        product: '$_id.product',
        outlet: '$_id.outlet',
        area: '$_id.area',
        unit: '$_id.unit',
        units: 1,
        value: 1,
      },
    },
  ]);
};

export const correctPurchase = async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const inventoryAction = req.body.inventoryAction === 'keep' ? 'keep' : 'adjust';
  if (reason.length < 5) {
    return res.status(422).json({ success: false, message: 'A clear correction reason is required.' });
  }
  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (['draft', 'pendingApproval', 'reversed'].includes(purchase.status)) {
    return res.status(409).json({ success: false, message: 'This purchase cannot be corrected in its current state.' });
  }

  const before = purchase.toObject();
  const originalTotal = purchase.totalAmount;
  const originalAmountPaid = purchase.amountPaid;
  const originalAit = purchase.aitAmount;
  const originalLines = before.lines || [];
  if (originalLines.some((line) => lineTreatment(before.type, line) === 'asset')) {
    return res.status(409).json({
      success: false,
      message: 'A posted purchase containing fixed assets cannot be corrected because asset tags and acquisition values already exist. Reverse it and enter a replacement purchase.',
    });
  }
  assignPurchase(purchase, req.body.changes || {});
  if (purchase.lines.some((line) => lineTreatment(purchase.type, line) === 'asset')) {
    return res.status(409).json({
      success: false,
      message: 'Fixed-asset lines cannot be added through a correction. Reverse this purchase and enter a replacement purchase.',
    });
  }
  const originalOutlet = before.outlet?.toString?.() || String(before.outlet || '');
  const correctedOutlet = purchase.outlet?.toString?.() || String(purchase.outlet || '');
  if (
    purchase.type !== before.type
    || purchase.destination !== before.destination
    || correctedOutlet !== originalOutlet
  ) {
    return res.status(409).json({
      success: false,
      message: 'A posted purchase cannot change type, outlet, or destination. Reverse it and enter the correct purchase instead.',
    });
  }
  await hydratePurchaseSnapshots(purchase, req.tenant);
  await purchase.validate();
  const financialDelta = round4(purchase.totalAmount - originalTotal);
  const paidReductionRequired = purchase.totalAmount + 0.001 < originalAmountPaid;
  const wasFullyPaid = originalAmountPaid + 0.001 >= originalTotal;
  if (paidReductionRequired && !wasFullyPaid) {
    return res.status(409).json({
      success: false,
      message: 'This partially paid purchase would become overpaid. Reverse or correct its payments before lowering the total.',
    });
  }
  if (paidReductionRequired) purchase.amountPaid = round4(purchase.totalAmount);

  const deltas = stockDeltaRows(originalLines, purchase.lines);
  const hasInventory = purchase.lines.some(
    (line) => lineTreatment(purchase.type, line) === 'inventory',
  );
  const quantityChanged = deltas.some((row) => row.units !== 0);
  const valueChanged = financialDelta !== 0 || deltas.some((row) => row.spend !== 0);
  const type = quantityChanged && valueChanged ? 'mixed'
    : quantityChanged ? 'quantity'
      : valueChanged ? 'value'
        : 'metadata';

  const area = purchase.destination === 'kitchen' ? 'kitchen' : 'store';
  const products = deltas.length ? await Product.find({ _id: { $in: deltas.map((row) => row.product) } }) : [];
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));
  for (const row of inventoryAction === 'adjust' ? deltas : []) {
    if (!row.units) continue;
    const stock = await StockItem.findOne({ product: row.product, outlet: purchase.outlet, area });
    if (row.units < 0 && Number(stock?.qtyOnHand || 0) + row.units < 0) {
      return res.status(409).json({
        success: false,
        message: `${productMap.get(row.key)?.name || 'An item'} has already been consumed; the requested reduction exceeds available stock.`,
      });
    }
  }

  const globalOnHandRows = inventoryAction === 'adjust' && deltas.length ? await StockItem.aggregate([
    { $match: { product: { $in: deltas.map((row) => row.product) } } },
    { $group: { _id: '$product', qty: { $sum: '$qtyOnHand' } } },
  ]) : [];
  const globalOnHand = new Map(globalOnHandRows.map((row) => [row._id.toString(), Number(row.qty) || 0]));

  const adjustment = await PurchaseAdjustment.create({
    purchase: purchase._id,
    type,
    reason,
    inventoryAction: hasInventory ? inventoryAction : 'notApplicable',
    before,
    after: purchase.toObject(),
    stockDeltas: deltas,
    financialDelta,
    financialBreakdown: {
      goods: round4((purchase.totalAmount - purchase.aitAmount) - (originalTotal - originalAit)),
      ait: round4(purchase.aitAmount - originalAit),
      total: financialDelta,
    },
    createdBy: req.user.id,
  });
  const undo = [];
  try {
    const originalVendor = before.vendor?.toString?.() || '';
    const correctedVendor = purchase.vendor?.toString?.() || '';
    if (originalVendor !== correctedVendor) {
      const previousPaymentVendors = await syncPurchasePaymentVendor(
        purchase._id,
        purchase.vendor || null,
      );
      undo.push(async () => restorePurchasePaymentVendors(previousPaymentVendors));
    }

    if (paidReductionRequired) {
      const paymentReconciliation = await reconcileFullyPaidPurchasePayments(
        purchase._id,
        { previousPaid: originalAmountPaid, correctedPaid: purchase.amountPaid },
      );
      adjustment.paymentChanges = paymentReconciliation.changes;
      undo.push(paymentReconciliation.rollback);
    }

    for (const row of inventoryAction === 'adjust' ? deltas : []) {
      const product = productMap.get(row.key);
      if (!product) throw new Error('A corrected product no longer exists.');

      let productBefore = null;
      let inventoryUnitCostBefore = Number(product.currentPrice) || 0;
      let inventoryUnitCostAfter = inventoryUnitCostBefore;
      if (row.units || row.spend) {
        normalizeLegacyProductPriceHistory(product);
        productBefore = product.toObject();
        const oldQty = globalOnHand.get(row.key) || 0;
        const newQty = oldQty + row.units;
        const oldValue = oldQty * inventoryUnitCostBefore;
        inventoryUnitCostAfter = newQty > 0
          ? Math.max(0, round4((oldValue + row.spend) / newQty))
          : 0;
      }

      if (row.units) {
        const filter = { product: row.product, outlet: purchase.outlet, area };
        await StockItem.findOneAndUpdate(
          filter,
          {
            $inc: { qtyOnHand: row.units },
            $setOnInsert: { unit: product.unit || '' },
            $set: { updatedAt: new Date() },
          },
          { upsert: row.units > 0 },
        );
        undo.push(async () => StockItem.updateOne(filter, { $inc: { qtyOnHand: -row.units } }));
      }

      if (row.units || row.spend) {
        const movement = await StockMovement.create({
          product: row.product,
          outlet: purchase.outlet,
          area,
          qty: row.units,
          unit: product.unit || '',
          type: 'manual-adjust',
          unitCost: row.units ? Math.abs(row.spend / row.units) : 0,
          value: row.spend,
          inventoryUnitCostBefore,
          inventoryUnitCostAfter,
          ref: { kind: 'purchaseAdjustment', id: adjustment._id },
          note: `Correction: ${purchase.itemSummary}`,
          user: req.user.id,
        });
        undo.push(async () => StockMovement.deleteOne({ _id: movement._id }));
      }

      if (row.units || row.spend) {
        product.lastPrice = product.currentPrice;
        product.currentPrice = inventoryUnitCostAfter;
        product.priceHistory.push({
          price: inventoryUnitCostAfter,
          date: new Date(),
          changedBy: req.user.id,
          source: 'purchaseAdjustment',
          purchase: purchase._id,
          purchaseAdjustment: adjustment._id,
          vendorId: purchase.vendor || undefined,
        });
        await product.save();
        undo.push(async () => Product.replaceOne({ _id: product._id }, productBefore));
      }
    }

    const { previousJournal } = await updatePurchaseJournalInPlace(purchase);
    undo.push(async () => JournalEntry.replaceOne(
      { _id: previousJournal._id },
      previousJournal,
      { upsert: true },
    ));
    // Keep the correction document as the audit/stock history, but corrections
    // no longer create a second financial journal for the same purchase.
    adjustment.journalEntryId = null;
    await adjustment.save();
    const balance = purchase.totalAmount - purchase.amountPaid;
    purchase.status = balance <= 0.001 ? 'paid' : purchase.amountPaid > 0 ? 'partiallyPaid' : 'corrected';
    await purchase.save();
  } catch (err) {
    for (const rollback of undo.reverse()) {
      try { await rollback(); } catch { /* preserve the original failure */ }
    }
    await PurchaseAdjustment.deleteOne({ _id: adjustment._id });
    throw err;
  }

  req.auditRecordId = purchase._id;
  req.auditBefore = before;
  req.auditAfter = purchase.toObject();
  return res.json({ success: true, message: 'Purchase correction posted.', data: { purchase, adjustment } });
};

export const recordPurchasePaymentController = async (req, res) => {
  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (!['open', 'partiallyPaid', 'corrected', 'migrationReview'].includes(purchase.status)) {
    return res.status(409).json({ success: false, message: 'This purchase is not open for payment.' });
  }
  const amount = Number(req.body.amount);
  const balance = round4(purchase.totalAmount - purchase.amountPaid);
  if (!(amount > 0) || amount > balance + 0.001) {
    return res.status(422).json({ success: false, message: `Payment must be between 0 and ${balance}.` });
  }
  const result = await recordPurchasePayment(purchase, {
    amount,
    method: req.body.method,
    reference: req.body.reference,
    paymentDate: req.body.paymentDate,
    notes: req.body.notes,
    userId: req.user.id,
  });
  req.auditRecordId = result.payment._id;
  req.auditAfter = result.payment.toObject();
  return res.status(201).json({ success: true, message: 'Payment posted.', data: result });
};

export const reversePurchase = async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const inventoryAction = req.body.inventoryAction === 'keep' ? 'keep' : 'adjust';
  if (reason.length < 5) return res.status(422).json({ success: false, message: 'A reversal reason is required.' });
  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (purchase.status === 'reversed') return res.status(409).json({ success: false, message: 'Purchase is already reversed.' });

  const before = purchase.toObject();
  const linkedAssets = await Asset.find({ purchase: purchase._id });
  if (linkedAssets.length) {
    const assetIds = linkedAssets.map((asset) => asset._id);
    const lifecycleMovements = await AssetMovement.countDocuments({
      asset: { $in: assetIds },
      type: { $nin: ['acquisition'] },
    });
    const changedAsset = linkedAssets.some((asset) => (
      asset.status !== 'active'
      || Number(asset.accumulatedDepreciation || 0) > 0
      || Number(asset.quantity || 0) !== Number(asset.originalQuantity || 0)
    ));
    if (lifecycleMovements || changedAsset) {
      return res.status(409).json({
        success: false,
        message: 'This purchase cannot be reversed because one or more linked assets have already been audited, depreciated, transferred, adjusted, or disposed.',
      });
    }
  }

  const stockRows = inventoryAction === 'adjust' && purchase.stockPostedAt
    ? await appliedStockRows(purchase)
    : [];
  for (const row of stockRows) {
    const stock = await StockItem.findOne({
      product: row.product,
      outlet: row.outlet,
      area: row.area,
    });
    if (Number(stock?.qtyOnHand || 0) < row.units) {
      return res.status(409).json({
        success: false,
        message: 'This purchase cannot be fully reversed because some received stock has already been consumed. Use a correction instead.',
      });
    }
  }

  const payments = await Payment.find({ purchase: purchase._id, status: { $ne: 'reversed' } });
  for (const payment of payments) {
    if (payment.journalEntryId) await reverseJournalEntry(payment.journalEntryId, req.user.id);
    payment.status = 'reversed';
    payment.reversedAt = new Date();
    payment.reversedBy = req.user.id;
    payment.reversalReason = reason;
    await payment.save();
  }
  if (purchase.journalEntryId) await reverseJournalEntry(purchase.journalEntryId, req.user.id);

  if (stockRows.length) {
    for (const row of stockRows) {
      await StockItem.updateOne(
        { product: row.product, outlet: row.outlet, area: row.area },
        { $inc: { qtyOnHand: -row.units }, $set: { updatedAt: new Date() } },
      );
      await StockMovement.create({
        product: row.product,
        outlet: row.outlet,
        area: row.area,
        qty: -row.units,
        unit: row.unit || '',
        type: 'manual-adjust',
        unitCost: row.units ? Math.abs(row.value / row.units) : 0,
        value: -row.value,
        ref: { kind: 'purchase', id: purchase._id },
        note: `Reversal: ${reason}`,
        user: req.user.id,
      });
    }
  }
  for (const asset of linkedAssets) {
    const quantityBefore = Number(asset.quantity || 0);
    const carryingAmount = Math.max(
      0,
      Number(asset.grossCarryingAmount || 0) - Number(asset.accumulatedDepreciation || 0),
    );
    asset.quantity = 0;
    asset.grossCarryingAmount = 0;
    asset.status = 'inactive';
    asset.updatedBy = req.user.id;
    await asset.save();
    await AssetMovement.create({
      asset: asset._id,
      outlet: asset.outlet,
      type: 'reversal',
      quantityBefore,
      quantityChange: -quantityBefore,
      quantityAfter: 0,
      conditionBefore: asset.condition,
      conditionAfter: asset.condition,
      locationBefore: asset.location,
      locationAfter: asset.location,
      journalEntry: purchase.journalEntryId || null,
      amount: -carryingAmount,
      reason: `Purchase ${purchase.purchaseNumber} reversed: ${reason}`,
      user: req.user.id,
    });
  }
  purchase.status = 'reversed';
  purchase.amountPaid = 0;
  purchase.reversedAt = new Date();
  purchase.reversedBy = req.user.id;
  purchase.reversalReason = reason;
  purchase.reversalInventoryAction = inventoryAction;
  await purchase.save();
  req.auditRecordId = purchase._id;
  req.auditBefore = before;
  req.auditAfter = purchase.toObject();
  return res.json({ success: true, message: 'Purchase reversed. Original records were retained.', data: purchase });
};

const deletePostedPurchaseWithoutReversal = async (purchase, req, res, reason, inventoryAction) => {
  const linkedAssets = await Asset.find({ purchase: purchase._id });
  if (linkedAssets.length) {
    const assetIds = linkedAssets.map((asset) => asset._id);
    const lifecycleMovements = await AssetMovement.countDocuments({
      asset: { $in: assetIds },
      type: { $nin: ['acquisition'] },
    });
    const changedAsset = linkedAssets.some((asset) => (
      asset.status !== 'active'
      || Number(asset.accumulatedDepreciation || 0) > 0
      || Number(asset.quantity || 0) !== Number(asset.originalQuantity || 0)
    ));
    if (lifecycleMovements || changedAsset) {
      return res.status(409).json({
        success: false,
        message: 'This purchase cannot be deleted because a linked asset has later audit, depreciation, transfer, adjustment, or disposal activity.',
      });
    }
  }

  const stockRows = inventoryAction === 'adjust' && purchase.stockPostedAt
    ? await appliedStockRows(purchase)
    : [];
  for (const row of stockRows) {
    const stock = await StockItem.findOne({ product: row.product, outlet: row.outlet, area: row.area });
    if (Number(stock?.qtyOnHand || 0) < row.units) {
      return res.status(409).json({
        success: false,
        message: 'This purchase cannot remove its quantities because some received stock has already been consumed. Choose Keep quantities or use a correction.',
      });
    }
  }

  const [payments, adjustments] = await Promise.all([
    Payment.find({ purchase: purchase._id }),
    PurchaseAdjustment.find({ purchase: purchase._id }),
  ]);
  const primaryJournalIds = [
    purchase.journalEntryId,
    ...payments.map((payment) => payment.journalEntryId),
    ...adjustments.map((adjustment) => adjustment.journalEntryId),
  ].filter(Boolean);
  const primaryJournals = primaryJournalIds.length
    ? await JournalEntry.find({ _id: { $in: primaryJournalIds } })
    : [];
  const reversalIds = primaryJournals.map((entry) => entry.reversedBy).filter(Boolean);
  const reversalJournals = reversalIds.length
    ? await JournalEntry.find({ _id: { $in: reversalIds } })
    : [];
  let journalIds;
  try {
    journalIds = buildPurchaseJournalDeletionIds(primaryJournals, reversalJournals);
  } catch (error) {
    return res.status(error.statusCode || 409).json({ success: false, message: error.message });
  }

  const before = purchase.toObject();
  const paymentSnapshots = payments.map((document) => document.toObject());
  const adjustmentSnapshots = adjustments.map((document) => document.toObject());
  const assetSnapshots = linkedAssets.map((document) => document.toObject());
  const assetIds = linkedAssets.map((asset) => asset._id);
  const assetMovementDocs = assetIds.length
    ? await AssetMovement.find({ asset: { $in: assetIds }, type: 'acquisition' })
    : [];
  const assetMovementSnapshots = assetMovementDocs.map((document) => document.toObject());
  const journalSnapshots = [...new Map(
    [...primaryJournals, ...reversalJournals].map((document) => [String(document._id), document.toObject()]),
  ).values()];
  const rollback = [];
  const restoreSnapshots = async (Model, snapshots) => {
    for (const snapshot of snapshots) {
      await Model.replaceOne({ _id: snapshot._id }, snapshot, { upsert: true });
    }
  };

  try {
    for (const row of stockRows) {
      const stockFilter = { product: row.product, outlet: row.outlet, area: row.area };
      const stockUpdate = await StockItem.updateOne(
        { ...stockFilter, qtyOnHand: { $gte: row.units } },
        { $inc: { qtyOnHand: -row.units }, $set: { updatedAt: new Date() } },
      );
      if (stockUpdate.modifiedCount !== 1) throw new Error(`Stock changed for ${row._id.product}; refresh and try again.`);
      rollback.push(() => StockItem.updateOne(stockFilter, { $inc: { qtyOnHand: row.units } }));

      const movement = await StockMovement.create({
        product: row.product,
        outlet: row.outlet,
        area: row.area,
        qty: -row.units,
        unit: row.unit || '',
        type: 'manual-adjust',
        unitCost: row.units ? Math.abs(row.value / row.units) : 0,
        value: -row.value,
        ref: { kind: 'purchase', id: purchase._id },
        note: `Purchase deleted: ${reason}`,
        user: req.user.id,
      });
      rollback.push(() => StockMovement.deleteOne({ _id: movement._id }));
    }

    if (assetIds.length) {
      const deletedMovements = await AssetMovement.deleteMany({ asset: { $in: assetIds }, type: 'acquisition' });
      rollback.push(() => restoreSnapshots(AssetMovement, assetMovementSnapshots));
      if (deletedMovements.deletedCount !== assetMovementSnapshots.length) throw new Error('Linked asset movements changed before deletion.');
      const deletedAssets = await Asset.deleteMany({ _id: { $in: assetIds } });
      rollback.push(() => restoreSnapshots(Asset, assetSnapshots));
      if (deletedAssets.deletedCount !== assetSnapshots.length) throw new Error('Linked assets changed before deletion.');
    }
    if (journalIds.length) {
      const deletedJournals = await JournalEntry.deleteMany({ _id: { $in: journalIds } });
      rollback.push(() => restoreSnapshots(JournalEntry, journalSnapshots));
      if (deletedJournals.deletedCount !== journalIds.length) throw new Error('A linked journal changed before deletion.');
    }
    const deletedPayments = await Payment.deleteMany({ purchase: purchase._id });
    rollback.push(() => restoreSnapshots(Payment, paymentSnapshots));
    if (deletedPayments.deletedCount !== paymentSnapshots.length) throw new Error('Linked payments changed before deletion.');
    const deletedAdjustments = await PurchaseAdjustment.deleteMany({ purchase: purchase._id });
    rollback.push(() => restoreSnapshots(PurchaseAdjustment, adjustmentSnapshots));
    if (deletedAdjustments.deletedCount !== adjustmentSnapshots.length) throw new Error('Linked corrections changed before deletion.');

    purchase.deletedAt = new Date();
    purchase.deletedBy = req.user.id;
    purchase.deleteReason = reason;
    purchase.amountPaid = 0;
    purchase.journalEntryId = null;
    await purchase.save();
    rollback.push(() => Purchase.replaceOne({ _id: before._id }, before));

    req.auditRecordId = purchase._id;
    req.auditBefore = before;
    req.auditAfter = {
      ...purchase.toObject(),
      deletedJournalEntries: primaryJournals.map((entry) => entry.entryNumber),
      deletedReversalEntries: reversalJournals.map((entry) => entry.entryNumber),
      reversalCreated: false,
      inventoryAction,
    };
    return res.json({
      success: true,
      message: inventoryAction === 'adjust'
        ? 'Purchase deleted, quantities removed, and journal entries deleted without reversal.'
        : 'Purchase and journal entries deleted without reversal; inventory quantities were kept.',
    });
  } catch (error) {
    const rollbackErrors = await runPurchaseDeletionRollback(rollback);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: rollbackErrors.length
        ? `${error.message || 'Purchase could not be deleted.'} Some rollback steps also failed; contact support before retrying.`
        : error.message || 'Purchase could not be deleted.',
    });
  }
};

export const deletePurchase = async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const inventoryAction = req.body.inventoryAction === 'adjust' ? 'adjust' : 'keep';
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid purchase ID.' });
  }
  if (reason.length < 5) {
    return res.status(422).json({ success: false, message: 'A clear deletion reason is required.' });
  }

  const purchase = await activePurchaseById(req.params.id);
  if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (POSTED_STATUSES.includes(purchase.status)) {
    return deletePostedPurchaseWithoutReversal(purchase, req, res, reason, inventoryAction);
  }
  if (!['draft', 'pendingApproval', 'reversed'].includes(purchase.status)) {
    return res.status(409).json({
      success: false,
      message: 'Only draft or fully reversed purchases can be removed. Reverse a posted purchase first.',
    });
  }
  if (['draft', 'pendingApproval'].includes(purchase.status) && (purchase.postedAt || purchase.journalEntryId || purchase.stockPostedAt)) {
    return res.status(409).json({
      success: false,
      message: 'This draft has posted activity and cannot be removed safely.',
    });
  }
  const activePayments = await Payment.countDocuments({ purchase: purchase._id, status: { $ne: 'reversed' } });
  if (activePayments) {
    return res.status(409).json({
      success: false,
      message: 'This purchase still has an active payment. Reverse the payment before removing the purchase.',
    });
  }

  const before = purchase.toObject();
  purchase.deletedAt = new Date();
  purchase.deletedBy = req.user.id;
  purchase.deleteReason = reason;
  await purchase.save();

  req.auditRecordId = purchase._id;
  req.auditBefore = before;
  req.auditAfter = purchase.toObject();
  return res.json({
    success: true,
    message: 'Purchase removed from operational lists. Its audit record was retained.',
  });
};
