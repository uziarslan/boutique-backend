import mongoose from 'mongoose';
import LoyaltyConfig from '../models/LoyaltyConfig.js';
import LoyaltyTransaction from '../models/LoyaltyTransaction.js';
import Customer from '../models/Customer.js';
import {
  getOrCreateConfig,
  issueCard,
  adjustBalance,
  runExpirySweep,
} from '../services/loyalty.service.js';

// ─── Date-range helpers ─────────────────────────────────────────────────────
// `to` must be the END of its day, otherwise a `to=2026-06-15` (parsed as
// midnight) would exclude everything that happened during that day.
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

// ─── Config ───────────────────────────────────────────────────────────────────

export const getConfig = async (_req, res) => {
  const cfg = await getOrCreateConfig();
  return res.json({ success: true, data: cfg });
};

export const updateConfig = async (req, res) => {
  const cfg = await getOrCreateConfig();

  const allowed = [
    'pointsPerCurrencyUnit', 'earnBasis', 'earnOnPaymentMethods',
    'redemptionValue', 'minRedeemPoints', 'maxRedeemPercent', 'redemptionApplyMode',
    'cardNumberMode', 'cardNumberPrefix',
    'refundReversesPoints', 'expiryMonths', 'breakageAccountCode',
    'enabled',
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) cfg[key] = req.body[key];
  }
  await cfg.save();
  return res.json({ success: true, data: cfg });
};

// ─── Members ──────────────────────────────────────────────────────────────────

export const listMembers = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page ?? 1, 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? 25, 10)));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.search) {
    const safe = String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: safe, $options: 'i' } },
      { phone: { $regex: safe, $options: 'i' } },
      { membershipCardNumber: { $regex: safe, $options: 'i' } },
    ];
  }
  if (req.query.withCard === 'true') filter.membershipCardNumber = { $ne: null };

  const [data, total] = await Promise.all([
    Customer.find(filter)
      .select('name phone email membershipCardNumber membershipCardIssuedAt pointsBalance lifetimePointsEarned lifetimePointsRedeemed pointsExpireAt')
      .sort({ pointsBalance: -1, name: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Customer.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
};

export const getMember = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid id.' });
  }
  const customer = await Customer.findById(req.params.id).lean();
  if (!customer) return res.status(404).json({ success: false, message: 'Customer not found.' });

  const recent = await LoyaltyTransaction.find({ customer: customer._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .populate('sale', 'transactionNumber totalAmount createdAt')
    .lean();

  return res.json({ success: true, data: { customer, transactions: recent } });
};

export const issueMemberCard = async (req, res) => {
  const customer = await issueCard({
    customerId: req.params.id,
    manualNumber: req.body?.cardNumber,
    cashier: req.user?.id,
  });
  return res.json({ success: true, data: customer });
};

export const adjustMemberPoints = async (req, res) => {
  const { deltaPoints, note } = req.body || {};
  const lt = await adjustBalance({
    customerId: req.params.id,
    deltaPoints: Number(deltaPoints),
    note,
    userId: req.user?.id,
  });
  return res.json({ success: true, data: lt });
};

// ─── Transactions ─────────────────────────────────────────────────────────────

export const listTransactions = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page ?? 1, 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? 50, 10)));
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.customer && mongoose.isValidObjectId(req.query.customer)) {
    filter.customer = req.query.customer;
  }
  if (req.query.outlet && mongoose.isValidObjectId(req.query.outlet)) {
    filter.outlet = req.query.outlet;
  }
  if (req.query.type) filter.type = req.query.type;
  // Default to today when no range is supplied (matches the frontend's default
  // "Today" filter); end the upper bound at end-of-day so today's rows count.
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) filter.createdAt.$gte = startOfDay(req.query.from);
    if (req.query.to) filter.createdAt.$lte = endOfDay(req.query.to);
  } else {
    const now = new Date();
    filter.createdAt = { $gte: startOfDay(now), $lte: endOfDay(now) };
  }

  const [data, total] = await Promise.all([
    LoyaltyTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name phone membershipCardNumber')
      .populate('sale', 'transactionNumber totalAmount')
      .lean(),
    LoyaltyTransaction.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
};

// ─── Dashboard / reports ─────────────────────────────────────────────────────

export const getDashboard = async (_req, res) => {
  const [
    totalCardholders,
    pointsOutstandingAgg,
    last30Agg,
    topMembers,
  ] = await Promise.all([
    Customer.countDocuments({ membershipCardNumber: { $ne: null } }),
    Customer.aggregate([
      { $group: { _id: null, totalBalance: { $sum: '$pointsBalance' } } },
    ]),
    LoyaltyTransaction.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
      {
        $group: {
          _id: '$type',
          points: { $sum: '$points' },
          value: { $sum: '$valueAtTxn' },
          count: { $sum: 1 },
        },
      },
    ]),
    Customer.find({ pointsBalance: { $gt: 0 } })
      .sort({ pointsBalance: -1 })
      .limit(10)
      .select('name phone membershipCardNumber pointsBalance')
      .lean(),
  ]);

  const cfg = await getOrCreateConfig();
  const pointsOutstanding = pointsOutstandingAgg[0]?.totalBalance ?? 0;
  const liabilityValue = parseFloat((pointsOutstanding * (cfg.redemptionValue || 0)).toFixed(2));

  return res.json({
    success: true,
    data: {
      totalCardholders,
      pointsOutstanding,
      liabilityValue,
      last30: last30Agg,
      topMembers,
    },
  });
};

export const getReports = async (req, res) => {
  // Default to today (matches the frontend's default "Today" filter). `to` ends
  // at end-of-day so the current day's transactions are included.
  const from = req.query.from ? startOfDay(req.query.from) : startOfDay(new Date());
  const to = req.query.to ? endOfDay(req.query.to) : endOfDay(new Date());

  const match = { createdAt: { $gte: from, $lte: to } };
  if (req.query.outlet && mongoose.isValidObjectId(req.query.outlet)) {
    match.outlet = new mongoose.Types.ObjectId(req.query.outlet);
  }

  const agg = await LoyaltyTransaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } } },
        points: { $sum: '$points' },
        value: { $sum: '$valueAtTxn' },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.day': 1 } },
  ]);

  const totals = await LoyaltyTransaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$type',
        points: { $sum: '$points' },
        value: { $sum: '$valueAtTxn' },
        count: { $sum: 1 },
      },
    },
  ]);

  return res.json({ success: true, data: { from, to, byDay: agg, totals } });
};

// ─── Expiry sweep (manual trigger) ────────────────────────────────────────────

export const triggerExpiry = async (req, res) => {
  const result = await runExpirySweep({ userId: req.user?.id });
  return res.json({ success: true, data: result });
};
