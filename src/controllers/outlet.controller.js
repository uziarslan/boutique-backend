import Outlet from '../models/Outlet.js';
import AuditLog from '../models/AuditLog.js';
import User from '../models/User.js';
import JournalEntry from '../models/JournalEntry.js';
import logger from '../utils/logger.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  ensureOutletFeatureAssignments,
  isFeatureEnabledForOutlet,
} from '../services/outletFeatures.service.js';
import { cacheDel, tenantKey } from '../utils/requestCache.js';

const syncOutletFeatureAssignment = async (req, outlet) => {
  try {
    const tenant = await TenantModel().findOne({ slug: req.tenantSlug });
    if (!tenant) return;
    const changed = await ensureOutletFeatureAssignments(tenant, [outlet], {
      completeMigration: false,
      updatedBy: req.user?.email || 'tenant-owner',
    });
    if (changed) cacheDel(tenantKey(req.tenantSlug));
  } catch (err) {
    // Outlet creation/update remains authoritative even if the platform
    // projection is temporarily unavailable; the resolver has a safe fallback
    // and the admin detail page repairs the assignment idempotently.
    logger.warn(`Outlet feature assignment sync skipped for ${outlet.code}: ${err.message}`);
  }
};

// ── getAllOutlets ──────────────────────────────────────────────────────────────
// GET /api/outlets
// Query: page, limit, isActive (true/false/all)

export const getAllOutlets = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  const skip = (page - 1) * limit;

  const filter = {};

  if (req.query.isActive !== undefined && req.query.isActive !== 'all') {
    filter.isActive = req.query.isActive === 'true';
  }

  const [outlets, total] = await Promise.all([
    Outlet.find(filter)
      .select('name code address phone timezone businessDayStart businessDayEnd isActive qrOrdering kds createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Outlet.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: outlets,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  });
};

// ── createOutlet ───────────────────────────────────────────────────────────────
// POST /api/outlets
// Body: { name, address?, phone?, timezone? }

export const createOutlet = async (req, res) => {
  const { name, code, address, phone, timezone, businessDayStart, businessDayEnd } = req.body;

  if (!name || !name.trim()) {
    return res.status(422).json({ success: false, message: 'Outlet name is required.' });
  }
  if (businessDayStart !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(businessDayStart)) {
    return res.status(422).json({ success: false, message: 'Business day start must be a valid HH:mm time.' });
  }
  if (businessDayEnd !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(businessDayEnd)) {
    return res.status(422).json({ success: false, message: 'Business day end must be a valid HH:mm time.' });
  }

  const outlet = await Outlet.create({
    name: name.trim(),
    code: code ? code.trim().toUpperCase() : undefined,
    address,
    phone,
    timezone,
    businessDayStart,
    businessDayEnd,
    createdBy: req.user.id,
  });

  await AuditLog.create({
    user: req.user.id,
    action: 'outlet_created',
    module: 'outlet',
    recordId: outlet._id,
    after: { name: outlet.name, code: outlet.code },
    ip: req.ip,
  });

  logger.info(`Outlet created: ${outlet.code} (${outlet.name}) by ${req.user.email}`);
  await syncOutletFeatureAssignment(req, outlet);

  return res.status(201).json({ success: true, data: outlet });
};

// ── getOutletById ──────────────────────────────────────────────────────────────
// GET /api/outlets/:id

export const getOutletById = async (req, res) => {
  const outlet = await Outlet.findById(req.params.id)
    .populate('createdBy', 'name email')
    .lean();

  if (!outlet) {
    return res.status(404).json({ success: false, message: 'Outlet not found.' });
  }
  // Today's POS sales total from AuditLog (advisory — actual source of truth is JournalEntry)
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const todayLogs = await AuditLog.find({
    module: 'pos',
    action: 'pos_sales_event',
    timestamp: { $gte: startOfDay },
    'after.outlet': outlet.code,
  }).lean();

  const todaysSalesTotal = todayLogs.reduce(
    (sum, log) => sum + (Number(log.after?.totalAmount) || 0),
    0
  );

  // Active cashier count: cashier users assigned to this outlet
  // (full session tracking is a Phase 2 POS concern; this is a static count)
  const activeCashierCount = await User.countDocuments({
    outletRef: outlet._id,
    role: 'cashier',
    isActive: true,
  });

  return res.json({
    success: true,
    data: {
      ...outlet,
      todaysSalesTotal,
      activeCashierCount,
    },
  });
};

// ── updateOutlet ───────────────────────────────────────────────────────────────
// PATCH /api/outlets/:id
// Body: any subset of { name, address, phone, timezone, isActive }

export const updateOutlet = async (req, res) => {
  const outlet = await Outlet.findById(req.params.id);

  if (!outlet) {
    return res.status(404).json({ success: false, message: 'Outlet not found.' });
  }
  const beforeKds = outlet.kds?.toObject?.() ?? outlet.kds;
  if (req.body.kds !== undefined && req.user.role !== 'owner') {
    return res.status(403).json({ success: false, message: 'Only an owner can change KDS settings.' });
  }
  if (req.body.kds !== undefined) {
    if (!isFeatureEnabledForOutlet(req.tenant, 'kds', outlet._id)) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_DISABLED',
        message: 'Kitchen Display System is not enabled for this outlet. Contact your administrator.',
      });
    }
    const next = req.body.kds || {};
    const warningMinutes = Number(next.warningMinutes ?? outlet.kds?.warningMinutes ?? 15);
    const criticalMinutes = Number(next.criticalMinutes ?? outlet.kds?.criticalMinutes ?? 25);
    if (!Number.isFinite(warningMinutes) || !Number.isFinite(criticalMinutes)
      || warningMinutes < 1 || criticalMinutes < warningMinutes || criticalMinutes > 240) {
      return res.status(422).json({
        success: false,
        message: 'KDS timer settings require critical minutes to be at least warning minutes and no more than 240.',
      });
    }
    outlet.kds = {
      enabled: next.enabled === true,
      warningMinutes,
      criticalMinutes,
    };
  }
  if (req.body.businessDayStart !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(req.body.businessDayStart)) {
    return res.status(422).json({ success: false, message: 'Business day start must be a valid HH:mm time.' });
  }
  if (req.body.businessDayEnd !== undefined && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(req.body.businessDayEnd)) {
    return res.status(422).json({ success: false, message: 'Business day end must be a valid HH:mm time.' });
  }

  const before = {
    name: outlet.name,
    isActive: outlet.isActive,
    phone: outlet.phone,
    timezone: outlet.timezone,
    businessDayStart: outlet.businessDayStart,
    businessDayEnd: outlet.businessDayEnd,
    address: outlet.address?.toObject?.() ?? outlet.address,
    kds: beforeKds,
  };

  const allowedFields = ['name', 'address', 'phone', 'timezone', 'businessDayStart', 'businessDayEnd', 'isActive'];
  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      outlet[field] = req.body[field];
    }
  });

  // Handle code separately so it is always stored uppercase/trimmed
  if (req.body.code !== undefined) {
    outlet.code = req.body.code.trim().toUpperCase();
  }

  await outlet.save();
  await syncOutletFeatureAssignment(req, outlet);

  const after = {
    name: outlet.name,
    isActive: outlet.isActive,
    phone: outlet.phone,
    timezone: outlet.timezone,
    businessDayStart: outlet.businessDayStart,
    businessDayEnd: outlet.businessDayEnd,
    address: outlet.address,
    kds: outlet.kds,
  };

  await AuditLog.create({
    user: req.user.id,
    action: 'outlet_updated',
    module: 'outlet',
    recordId: outlet._id,
    before,
    after,
    ip: req.ip,
  });

  logger.info(`Outlet updated: ${outlet.code} by ${req.user.email}`);

  return res.json({ success: true, data: outlet });
};
