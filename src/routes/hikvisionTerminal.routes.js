import { Router } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import protect from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import authorize from '../middleware/role.middleware.js';
import logger from '../utils/logger.js';
import Outlet from '../models/Outlet.js';
import Employee from '../models/Employee.js';
import { HikvisionTerminalModel } from '../platform/models/HikvisionTerminal.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { hashToken, isSubscriptionActive } from '../middleware/attendanceDevice.middleware.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import { extractAccessEvent, evaluateAccessEvent } from '../utils/hikEvent.js';
import { getIo } from '../utils/socket.js';
import { isFeatureEnabledForOutlet } from '../services/outletFeatures.service.js';
import { recordAttendancePunch } from '../services/attendance.service.js';
import { attendanceCaptureAccessError } from '../services/attendanceAccess.service.js';

const router = Router();

// Hikvision terminals POST recognition events as either application/json OR
// multipart/form-data (a JSON part plus an optional face JPEG). Multer only
// touches multipart requests; for JSON it's a no-op and express.json's parsed
// body is used as-is. Cap parts so a rogue POST can't exhaust memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
});

const sanitize = (d) => ({
  id: d._id,
  label: d.label || '',
  graceMinutes: d.graceMinutes ?? 0,
  tenantSlug: d.tenantSlug,
  outletId: d.outletId || null,
  outletName: d.outletName || '',
  outletCode: d.outletCode || '',
  serialNo: d.serialNo || '',
  createdAt: d.createdAt,
  lastEventAt: d.lastEventAt || null,
  lastEventEmployeeNo: d.lastEventEmployeeNo || '',
  unmatchedCount: d.unmatchedCount || 0,
  revokedAt: d.revokedAt || null,
});

const validGraceMinutes = (value) => typeof value === 'number'
  && Number.isInteger(value) && value >= 0 && value <= 1440;
const graceValidationMessage = 'Grace period must be a whole number of minutes from 0 to 1440.';

// Public base for the webhook URL we hand to owners. Behind Heroku's proxy the
// original scheme/host arrive in x-forwarded-* headers. PUBLIC_API_URL wins if
// set (useful when the device must hit a different ingress than the app URL).
const buildApiBase = (req) => {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
};

const webhookUrlFor = (req, token) => `${buildApiBase(req)}/api/hikvision-terminals/event/${token}`;

// Every branch below that swallows an event logs why. During on-site
// commissioning "I scanned my face and nothing happened" is the only symptom
// an installer sees, so the log is the sole way to tell a firewall problem
// from a wrong token from an unexpected minor event code.
const describePayload = (req) => {
  const keys = Object.keys(req.body || {}).slice(0, 10).join(',') || 'none';
  const files = Array.isArray(req.files)
    ? req.files.map((f) => f.fieldname).slice(0, 10).join(',') || 'none'
    : 'none';
  return `contentType="${req.headers['content-type'] || ''}" bodyKeys=[${keys}] fileFields=[${files}]`;
};

// ─── PUBLIC: device event webhook ───────────────────────────────────────────────
// The device is configured (in its web UI → HTTP Listening / Alarm Host) to
// POST here. We always answer 200 for anything we can't act on so the device
// doesn't disable the host or retry-storm; only a bad token is rejected.
router.post('/event/:token', upload.any(), async (req, res) => {
  const token = req.params.token;
  const terminal = await HikvisionTerminalModel().findOne({
    tokenHash: hashToken(token),
    revokedAt: null,
  });
  if (!terminal) {
    // Almost always a mistyped/stale URL in the device's HTTP Listening host.
    logger.warn(`[HikEvent] rejected: unknown or revoked token (…${token.slice(-6)}) from ${req.ip}`);
    return res.status(401).json({ success: false, message: 'Invalid or revoked terminal token.' });
  }

  const logPrefix = `[HikEvent] tenant=${terminal.tenantSlug} terminal="${terminal.label || 'untitled'}"`;

  const tenant = await TenantModel().findOne({ slug: terminal.tenantSlug }).lean();
  if (!tenant || !isSubscriptionActive(tenant)) {
    // Ack so the device stops retrying; nothing we can record.
    logger.warn(`${logPrefix} → IGNORED (tenant missing or subscription inactive)`);
    return res.status(200).json({ success: true, ignored: 'tenant-inactive' });
  }
  const terminalOutlet = terminal.outletId || terminal.outletCode;
  if (!terminalOutlet || !isFeatureEnabledForOutlet(tenant, 'attendanceExternalDevice', terminalOutlet)
    || !isFeatureEnabledForOutlet(tenant, 'attendance', terminalOutlet)) {
    return res.status(200).json({ success: true, ignored: 'feature-disabled' });
  }

  const ev = evaluateAccessEvent(extractAccessEvent({ body: req.body, files: req.files }));
  if (!ev) {
    // The device reached us but we couldn't find an AccessControllerEvent —
    // usually a heartbeat/test POST, or an event format we don't parse yet.
    logger.warn(`${logPrefix} → IGNORED (no AccessControllerEvent found) ${describePayload(req)}`);
    return res.status(200).json({ success: true, ignored: 'no-access-event' });
  }

  const { employeeNo } = ev;
  // No person attached → stranger / failed auth / door-open event. Ignore.
  if (!employeeNo) {
    logger.info(`${logPrefix} → IGNORED (event ${ev.major}/${ev.minor} carries no employeeNo — stranger, failed auth or door event)`);
    return res.status(200).json({ success: true, ignored: 'no-employee' });
  }
  // Only act on a successful authentication.
  if (!ev.isSuccess) {
    // If a client's firmware reports face success under a minor we don't know,
    // this is the line that tells you which one to add to ACCEPTED_SUCCESS_MINORS.
    logger.warn(`${logPrefix} employeeNo=${employeeNo} → IGNORED (event ${ev.major}/${ev.minor} is not an accepted success code; add the minor to ACCEPTED_SUCCESS_MINORS in utils/hikEvent.js if this device reports face success as ${ev.minor})`);
    return res.status(200).json({ success: true, ignored: `event-${ev.major}-${ev.minor}` });
  }

  const capturedAt = ev.capturedAt || new Date();
  // AccessControllerEvent.serialNo is a rolling event sequence, not the
  // terminal's hardware serial. Prefer the serial registered by the owner so
  // attendance records remain tied to the physical device.
  const serialNo = terminal.serialNo || ev.serialNo || '';

  const conn = await getTenantConnectionFor(tenant.slug);

  const result = await runWithTenant({ conn, slug: tenant.slug }, async () => {
    // Primary mapping: the Device Person ID an owner set on the employee.
    // Fallback: the raw employeeNo used as our Mongo _id (power users who
    // enrolled the device with our IDs directly).
    let employee = await Employee.findOne({ deviceEmployeeNo: employeeNo, isActive: true })
      .select('_id name outlet shiftStart shiftEnd')
      .populate('outlet', 'code timezone businessDayStart businessDayEnd')
      .lean();
    if (!employee && mongoose.isValidObjectId(employeeNo)) {
      employee = await Employee.findOne({ _id: employeeNo, isActive: true })
        .select('_id name outlet shiftStart shiftEnd')
        .populate('outlet', 'code timezone businessDayStart businessDayEnd')
        .lean();
    }

    if (!employee) {
      return { matched: false };
    }

    const accessError = attendanceCaptureAccessError({
      tenant, employee, outletConstraints: [terminalOutlet], externalDevice: true,
    });
    if (accessError) return { matched: true, ignored: accessError.code };

    const { record: attendance, duplicate } = await recordAttendancePunch({
      employee,
      capturedAt,
      status: 'approved',
      recognitionMethod: 'device',
      deviceSerialNo: serialNo || null,
      deviceLabel: terminal.label || null,
      graceMinutes: terminal.graceMinutes ?? 0,
      graceTerminalId: String(terminal._id),
    });

    if (duplicate) return { matched: true, duplicate: true, employee, attendance };

    try {
      const io = getIo();
      if (io) {
        io.emit('attendance:created', {
          id: attendance._id,
          employeeId: employee._id,
          employeeName: employee.name,
          capturedAt: attendance.capturedAt,
          businessDate: attendance.businessDate,
          checkOutAt: attendance.checkOutAt,
          status: attendance.status,
          recognitionMethod: 'device',
          outlet: attendance.outlet || null,
        });
      }
    } catch (e) {
      logger.warn('Failed to emit attendance:created (device)', e);
    }

    return { matched: true, duplicate: false, employee, attendance };
  });

  // Best-effort terminal bookkeeping (platform DB, outside tenant context).
  const bookkeeping = { $set: { lastEventAt: new Date(), lastEventEmployeeNo: employeeNo } };
  if (!result.matched) bookkeeping.$inc = { unmatchedCount: 1 };
  HikvisionTerminalModel().updateOne({ _id: terminal._id }, bookkeeping).catch(() => {});

  if (result.ignored) {
    logger.warn(`${logPrefix} → IGNORED (${result.ignored})`);
    return res.status(200).json({ success: true, ignored: result.ignored });
  }

  if (!result.matched) {
    // The device is talking to us correctly — the Person ID just isn't mapped
    // to anyone. Log the exact value so it can be pasted into Device Person ID.
    logger.warn(`${logPrefix} employeeNo=${employeeNo} → NO MATCH (set an employee's Device Person ID to "${employeeNo}")`);
    return res.status(200).json({ success: true, matched: false });
  }
  if (result.duplicate) {
    logger.info(`${logPrefix} employee=${result.employee.name} → duplicate scan within five minutes, ignored`);
    return res.status(200).json({ success: true, matched: true, duplicate: true });
  }
  logger.info(`${logPrefix} employee=${result.employee.name} → attendance marked`);
  return res.status(201).json({ success: true, matched: true });
});

// ─── AUTHENTICATED: owners manage their Hikvision terminals ─────────────────────
router.use(protect, requireFeature('attendanceExternalDevice'), authorize('owner'));

router.get('/', async (req, res) => {
  const terminals = await HikvisionTerminalModel()
    .find({ tenantSlug: req.tenantSlug })
    .sort({ createdAt: -1 })
    .lean();
  return res.json({ success: true, terminals: terminals.map(sanitize) });
});

router.post('/', async (req, res) => {
  const label = String(req.body?.label || '').slice(0, 80);
  const serialNo = String(req.body?.serialNo || '').slice(0, 64).trim();
  const rawOutletId = req.body?.outletId ? String(req.body.outletId) : null;
  const graceMinutes = req.body?.graceMinutes ?? 0;
  if (!validGraceMinutes(graceMinutes)) {
    return res.status(422).json({ success: false, message: graceValidationMessage });
  }

  if (!rawOutletId) {
    return res.status(422).json({ success: false, message: 'Outlet is required for a face terminal.' });
  }
  if (!mongoose.isValidObjectId(rawOutletId)) {
    return res.status(422).json({ success: false, message: 'outletId is not a valid ObjectId.' });
  }
  const outletDoc = await Outlet.findById(rawOutletId).select('_id name code').lean();
  if (!outletDoc) {
    return res.status(422).json({ success: false, message: 'Outlet not found in this tenant.' });
  }

  const plainToken = crypto.randomBytes(32).toString('hex');
  const terminal = await HikvisionTerminalModel().create({
    tokenHash: hashToken(plainToken),
    tenantSlug: req.tenantSlug,
    label,
    serialNo,
    graceMinutes,
    outletId: String(outletDoc._id),
    outletName: outletDoc.name || '',
    outletCode: outletDoc.code || '',
    createdByEmail: req.user?.email || '',
  });

  logger.info(`Hikvision terminal created: tenant=${req.tenantSlug} label="${label}" outlet=${outletDoc.code} by=${req.user?.email}`);
  return res.status(201).json({
    success: true,
    terminal: sanitize(terminal.toObject()),
    // One-time secrets — shown once, then only their hash is stored.
    token: plainToken,
    webhookUrl: webhookUrlFor(req, plainToken),
  });
});

router.patch('/:id', async (req, res) => {
  const update = {};
  if (req.body?.graceMinutes !== undefined) {
    if (!validGraceMinutes(req.body.graceMinutes)) {
      return res.status(422).json({ success: false, message: graceValidationMessage });
    }
    update.graceMinutes = req.body.graceMinutes;
  }
  if (req.body?.label !== undefined) update.label = String(req.body.label).slice(0, 80);
  if (req.body?.serialNo !== undefined) update.serialNo = String(req.body.serialNo).slice(0, 64).trim();
  const terminal = await HikvisionTerminalModel().findOneAndUpdate(
    { _id: req.params.id, tenantSlug: req.tenantSlug },
    { $set: update },
    { returnDocument: 'after', runValidators: true }
  ).lean();
  if (!terminal) {
    return res.status(404).json({ success: false, message: 'Terminal not found.' });
  }
  return res.json({ success: true, terminal: sanitize(terminal) });
});

router.post('/:id/regenerate', async (req, res) => {
  const terminal = await HikvisionTerminalModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
  });
  if (!terminal) {
    return res.status(404).json({ success: false, message: 'Terminal not found.' });
  }
  if (terminal.revokedAt) {
    return res.status(400).json({ success: false, message: 'Cannot regenerate a revoked terminal.' });
  }

  const plainToken = crypto.randomBytes(32).toString('hex');
  terminal.tokenHash = hashToken(plainToken);
  terminal.lastEventAt = null;
  terminal.lastEventEmployeeNo = '';
  await terminal.save();

  logger.info(`Hikvision terminal token regenerated: id=${terminal._id} tenant=${req.tenantSlug} by=${req.user?.email}`);
  return res.json({
    success: true,
    terminal: sanitize(terminal.toObject()),
    token: plainToken,
    webhookUrl: webhookUrlFor(req, plainToken),
  });
});

router.delete('/:id', async (req, res) => {
  const terminal = await HikvisionTerminalModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
  });
  if (!terminal) {
    return res.status(404).json({ success: false, message: 'Terminal not found.' });
  }
  terminal.revokedAt = new Date();
  await terminal.save();
  logger.info(`Hikvision terminal revoked: id=${terminal._id} tenant=${req.tenantSlug}`);
  return res.json({ success: true });
});

export default router;
