import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import Purchase from '../models/Purchase.js';
import Vendor from '../models/Vendor.js';
import {
  recordPurchasePayment,
  updatePurchasePaymentInPlace,
} from '../services/payment.service.js';
import { reverseJournalEntry } from '../accounting/journalEngine.js';
import logger from '../utils/logger.js';

// ─── recordPayment ────────────────────────────────────────────────────────────
// POST /api/payments

export const recordPayment = async (req, res) => {
  const { purchaseId, amount, method, reference, paymentDate, currency, notes } = req.body;

  if (!mongoose.isValidObjectId(purchaseId)) {
    return res.status(400).json({ success: false, message: 'Invalid purchaseId.' });
  }

  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) {
    return res.status(404).json({ success: false, message: 'Purchase not found.' });
  }

  const payable = ['open', 'partiallyPaid', 'corrected', 'migrationReview'];
  if (!payable.includes(purchase.status)) {
    return res.status(409).json({
      success: false,
      message: `Cannot record a payment against a purchase with status '${purchase.status}'.`,
    });
  }

  const numericAmount = Number(amount);
  const balance = parseFloat((purchase.totalAmount - purchase.amountPaid).toFixed(2));

  if (!(numericAmount > 0) || numericAmount > balance + 0.001) {
    return res.status(422).json({
      success: false,
      message: `Payment must be greater than zero and no more than ${balance}.`,
    });
  }

  const purchaseBefore = purchase.toObject();

  const { payment, journalEntry } = await recordPurchasePayment(purchase, {
    amount: numericAmount, method, reference, paymentDate, currency, notes, userId: req.user.id,
  });
  const newBalance = parseFloat((purchase.totalAmount - purchase.amountPaid).toFixed(2));

  req.auditRecordId = payment._id;
  req.auditAfter = payment.toObject();
  req.auditBefore = purchaseBefore;

  logger.info(
    `Payment recorded: ${payment._id} | purchase: ${purchase.purchaseNumber} | ` +
    `amount: ${payment.amount} ${payment.currency} | method: ${payment.method} | ` +
    `purchase status → ${purchase.status} | JE: ${journalEntry.entryNumber} | ` +
    `by user ${req.user.id}`
  );

  return res.status(201).json({
    success: true,
    data: {
      payment,
      purchase: {
        id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        status: purchase.status,
        amountPaid: purchase.amountPaid,
        balance: newBalance,
      },
      journalEntry: {
        id: journalEntry._id,
        entryNumber: journalEntry.entryNumber,
      },
    },
  });
};

// ─── getAllPayments ────────────────────────────────────────────────────────────
// GET /api/payments
// Query: page, limit, vendor, from, to, sortOrder

export const getAllPayments = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    vendor,
    outlet,
    from,
    to,
    search,
    method,
    minAmount,
    maxAmount,
    referenceState,
    purchaseState,
    sort,
    sortOrder = 'desc',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = { status: { $ne: 'reversed' } };
  if (vendor && mongoose.isValidObjectId(vendor)) filter.vendor = vendor;
  if (['cash', 'bankTransfer', 'cheque', 'creditCard'].includes(method)) filter.method = method;
  const min = Number(minAmount);
  const max = Number(maxAmount);
  if ((minAmount !== undefined && minAmount !== '' && Number.isFinite(min))
    || (maxAmount !== undefined && maxAmount !== '' && Number.isFinite(max))) {
    filter.amount = {};
    if (minAmount !== undefined && minAmount !== '' && Number.isFinite(min)) filter.amount.$gte = Math.max(0, min);
    if (maxAmount !== undefined && maxAmount !== '' && Number.isFinite(max)) filter.amount.$lte = Math.max(0, max);
  }
  if (referenceState === 'withReference') filter.reference = { $nin: [null, ''] };
  if (referenceState === 'withoutReference') filter.reference = { $in: [null, ''] };
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = new Date(from);
    if (to) filter.paymentDate.$lte = new Date(`${to}T23:59:59.999Z`);
  }
  const purchaseFilter = {};
  if (outlet && mongoose.isValidObjectId(outlet)) {
    purchaseFilter.outlet = new mongoose.Types.ObjectId(outlet);
  }
  if (purchaseState === 'outstanding') {
    purchaseFilter.status = { $in: ['open', 'partiallyPaid', 'corrected', 'migrationReview'] };
    purchaseFilter.$expr = { $gt: ['$totalAmount', '$amountPaid'] };
  } else if (purchaseState === 'settled') {
    purchaseFilter.status = 'paid';
  }
  if (Object.keys(purchaseFilter).length) {
    const purchaseIds = await Purchase.find(purchaseFilter).distinct('_id');
    filter.purchase = { $in: purchaseIds };
  }
  if (String(search || '').trim()) {
    const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const [purchaseIds, vendorIds] = await Promise.all([
      Purchase.find({
        deletedAt: null,
        $or: [
          { purchaseNumber: regex },
          { vendorInvoiceNumber: regex },
          { itemSummary: regex },
          { vendorName: regex },
        ],
      }).distinct('_id'),
      Vendor.find({ $or: [{ name: regex }, { code: regex }] }).distinct('_id'),
    ]);
    filter.$or = [
      { reference: regex },
      { notes: regex },
      { purchase: { $in: purchaseIds } },
      { vendor: { $in: vendorIds } },
    ];
  }

  const sortBy = {
    newest: { paymentDate: -1, createdAt: -1 },
    oldest: { paymentDate: 1, createdAt: 1 },
    amountHigh: { amount: -1, paymentDate: -1 },
    amountLow: { amount: 1, paymentDate: -1 },
  }[sort] || { paymentDate: sortOrder === 'asc' ? 1 : -1, createdAt: sortOrder === 'asc' ? 1 : -1 };

  const [payments, total, summaryRows] = await Promise.all([
    Payment.find(filter)
      .sort(sortBy)
      .skip(skip)
      .limit(pageSize)
      .populate('purchase', 'purchaseNumber vendorInvoiceNumber vendorName itemSummary type destination totalAmount amountPaid status dueDate lines outlet')
      .populate('purchase.lines.product', 'name sku unit')
      .populate('vendor', 'name code')
      .populate('recordedBy', 'name email')
      .populate('journalEntryId', 'entryNumber date')
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: filter },
      { $group: {
        _id: null,
        totalPaid: { $sum: '$amount' },
        cash: { $sum: { $cond: [{ $eq: ['$method', 'cash'] }, 1, 0] } },
        bankTransfer: { $sum: { $cond: [{ $eq: ['$method', 'bankTransfer'] }, 1, 0] } },
        cheque: { $sum: { $cond: [{ $eq: ['$method', 'cheque'] }, 1, 0] } },
        creditCard: { $sum: { $cond: [{ $eq: ['$method', 'creditCard'] }, 1, 0] } },
        cashAmount: { $sum: { $cond: [{ $eq: ['$method', 'cash'] }, '$amount', 0] } },
        digitalAmount: { $sum: { $cond: [{ $ne: ['$method', 'cash'] }, '$amount', 0] } },
      } },
    ]),
  ]);

  const summary = summaryRows[0] ?? {
    totalPaid: 0,
    cash: 0,
    bankTransfer: 0,
    cheque: 0,
    creditCard: 0,
    cashAmount: 0,
    digitalAmount: 0,
  };

  return res.json({
    success: true,
    data: { payments, total, summary, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── getPaymentById ───────────────────────────────────────────────────────────
// GET /api/payments/:id

export const getPaymentById = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid payment ID.' });
  }

  const payment = await Payment.findById(id)
    .populate('purchase', 'purchaseNumber vendorInvoiceNumber itemSummary totalAmount amountPaid status dueDate lines outlet')
    .populate('purchase.lines.product', 'name sku unit')
    .populate('vendor', 'name code currency paymentTerms')
    .populate('recordedBy', 'name email')
    .populate('journalEntryId', 'entryNumber date description lines')
    .lean();

  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found.' });
  }

  return res.json({ success: true, data: payment });
};

// ─── getPaymentsByVendor ──────────────────────────────────────────────────────
// GET /api/payments/vendor/:vendorId

export const getPaymentsByVendor = async (req, res) => {
  const { vendorId } = req.params;
  if (!mongoose.isValidObjectId(vendorId)) {
    return res.status(400).json({ success: false, message: 'Invalid vendor ID.' });
  }

  const {
    page = 1,
    limit = 50,
    from,
    to,
    sortOrder = 'desc',
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const skip = (pageNum - 1) * pageSize;

  const filter = { vendor: vendorId };
  if (from || to) {
    filter.paymentDate = {};
    if (from) filter.paymentDate.$gte = new Date(from);
    if (to) filter.paymentDate.$lte = new Date(to);
  }

  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .sort({ paymentDate: sortDir })
      .skip(skip)
      .limit(pageSize)
      .populate('purchase', 'purchaseNumber vendorInvoiceNumber itemSummary totalAmount amountPaid status dueDate')
      .populate('recordedBy', 'name email')
      .populate('journalEntryId', 'entryNumber date')
      .lean(),
    Payment.countDocuments(filter),
  ]);

  // Running total paid to this vendor
  const totalPaid = await Payment.aggregate([
    { $match: { vendor: new mongoose.Types.ObjectId(vendorId) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  return res.json({
    success: true,
    data: {
      payments,
      total,
      page: pageNum,
      pages: Math.ceil(total / pageSize),
      totalPaid: totalPaid[0]?.total ?? 0,
    },
  });
};

// ─── updatePaymentDate ───────────────────────────────────────────────────────
// PATCH /api/payments/:id/date  (payments.edit)
// Updates the existing payment date/method and linked journal in place. No
// reversal or replacement journal entry is created. The route name is retained
// for backward compatibility with clients that only send paymentDate.

export const updatePaymentDate = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid payment ID.' });
  }

  const rawDate = String(req.body?.paymentDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return res.status(422).json({ success: false, message: 'Enter a valid payment date.' });
  }
  const paymentDate = new Date(`${rawDate}T00:00:00.000Z`);
  if (Number.isNaN(paymentDate.getTime()) || paymentDate.toISOString().slice(0, 10) !== rawDate) {
    return res.status(422).json({ success: false, message: 'Enter a valid payment date.' });
  }
  if (paymentDate > new Date()) {
    return res.status(422).json({ success: false, message: 'Payment date cannot be in the future.' });
  }

  const payment = await Payment.findById(id);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found.' });
  }
  if (payment.status === 'reversed') {
    return res.status(409).json({ success: false, message: 'A reversed payment cannot be edited.' });
  }

  const method = req.body?.method == null ? payment.method : String(req.body.method).trim();
  if (!['cash', 'bankTransfer', 'cheque', 'creditCard'].includes(method)) {
    return res.status(422).json({ success: false, message: 'Select a valid payment method.' });
  }

  const before = payment.toObject();
  const { journalEntry } = await updatePurchasePaymentInPlace(payment, { paymentDate, method });

  req.auditRecordId = payment._id;
  req.auditBefore = {
    paymentDate: before.paymentDate,
    method: before.method,
    journalEntryId: before.journalEntryId,
  };
  req.auditAfter = {
    paymentDate: payment.paymentDate,
    method: payment.method,
    journalEntryId: journalEntry._id,
    journalUpdatedInPlace: true,
  };

  logger.info(
    `Payment details corrected in place: ${payment._id} | JE: ${journalEntry.entryNumber} | ` +
    `date: ${rawDate} | method: ${method} | by user ${req.user.id}`,
  );

  return res.json({
    success: true,
    message: 'Payment date and method updated on the existing payment and journal entry.',
    data: {
      payment,
      journalEntry: {
        id: journalEntry._id,
        entryNumber: journalEntry.entryNumber,
        date: journalEntry.date,
      },
    },
  });
};

// ─── deletePayment ────────────────────────────────────────────────────────────
// DELETE /api/payments/:id  (payments.delete)
// Reverses the payment journal and restores the purchase balance. The original
// payment is retained for audit history.

export const deletePayment = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid payment ID.' });
  }

  const payment = await Payment.findById(id);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found.' });
  }

  if (payment.status === 'reversed') {
    return res.status(409).json({ success: false, message: 'Payment is already reversed.' });
  }
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) {
    return res.status(422).json({ success: false, message: 'A clear reversal reason is required.' });
  }

  const purchase = await Purchase.findById(payment.purchase);
  if (payment.journalEntryId) await reverseJournalEntry(payment.journalEntryId, req.user.id);
  if (purchase) {
    purchase.amountPaid = parseFloat(Math.max(0, purchase.amountPaid - payment.amount).toFixed(2));
    purchase.status = purchase.amountPaid <= 0 ? 'open' : 'partiallyPaid';
    await purchase.save();
  }
  req.auditRecordId = payment._id;
  req.auditBefore = payment.toObject();
  payment.status = 'reversed';
  payment.reversedAt = new Date();
  payment.reversedBy = req.user.id;
  payment.reversalReason = reason;
  await payment.save();
  req.auditAfter = payment.toObject();

  logger.info(
    `Payment ${id} (amount: ${payment.amount}) reversed by user ${req.user.id} | ` +
    `purchase: ${purchase?.purchaseNumber ?? 'none'} restored to ${purchase?.status ?? 'n/a'}`
  );

  return res.json({
    success: true,
    message: 'Payment reversed; the original record and journal trail were retained.',
  });
};
