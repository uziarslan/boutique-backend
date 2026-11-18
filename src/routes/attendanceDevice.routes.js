import { Router } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import protect from '../middleware/auth.middleware.js';
import authorize from '../middleware/role.middleware.js';
import logger from '../utils/logger.js';
import Outlet from '../models/Outlet.js';
import { AttendanceDeviceModel } from '../platform/models/AttendanceDevice.js';
import { TenantModel } from '../platform/models/Tenant.js';
import {
  hashToken,
  invalidateAttendanceDeviceCache,
  loadActiveAttendanceDevice,
} from '../middleware/attendanceDevice.middleware.js';
import { resolveOutletFeatures } from '../services/outletFeatures.service.js';

const router = Router();

const sanitize = (d) => ({
  id: d._id,
  label: d.label || '',
  tenantSlug: d.tenantSlug,
  outletId: d.outletId || null,
  outletName: d.outletName || '',
  outletCode: d.outletCode || '',
  createdAt: d.createdAt,
  lastUsedAt: d.lastUsedAt,
  revokedAt: d.revokedAt || null,
});

// PUBLIC — attendance frontend posts the token here right after pairing to
// confirm it's valid and learn which outlet it's bound to. Doesn't return
// the token; only verifies it.
router.post('/verify', async (req, res) => {
  const { token } = req.body || {};
  if (!token) {
    return res.status(400).json({ success: false, message: 'Token required.' });
  }
  const device = await loadActiveAttendanceDevice(token);
  if (!device) {
    return res.status(401).json({ success: false, message: 'Invalid or revoked token.' });
  }
  const tenant = await TenantModel().findOne({ slug: device.tenantSlug }).lean();
  if (!tenant) {
    return res.status(401).json({ success: false, message: 'Tenant for this device no longer exists.' });
  }
  // The tablet re-reads its outlet-specific behavior flags on each heartbeat,
  // so admin changes propagate without re-pairing.
  const features = resolveOutletFeatures(tenant, device.outletId || device.outletCode);
  return res.json({
    success: true,
    tenant: {
      slug: tenant.slug,
      outletName: tenant.outletName,
    },
    attendance: {
      liveness: features.attendanceLiveness === true,
      externalDevice: features.attendanceExternalDevice === true,
    },
    device: {
      id: device._id,
      label: device.label || '',
      outletId: device.outletId || null,
      outletName: device.outletName || '',
      outletCode: device.outletCode || '',
    },
  });
});

// AUTHENTICATED — owners manage their own attendance device tokens.
router.use(protect, authorize('owner'));

router.get('/', async (req, res) => {
  const devices = await AttendanceDeviceModel()
    .find({ tenantSlug: req.tenantSlug })
    .sort({ createdAt: -1 })
    .lean();
  return res.json({ success: true, devices: devices.map(sanitize) });
});

router.post('/', async (req, res) => {
  const label = String(req.body?.label || '').slice(0, 80);
  const rawOutletId = req.body?.outletId ? String(req.body.outletId) : null;

  // Outlet binding is required. Without it the device would match every
  // employee in the tenant, which defeats the whole point of per-terminal
  // scoping (and is slower).
  if (!rawOutletId) {
    return res.status(422).json({ success: false, message: 'Outlet is required for attendance devices.' });
  }
  if (!mongoose.isValidObjectId(rawOutletId)) {
    return res.status(422).json({ success: false, message: 'outletId is not a valid ObjectId.' });
  }
  const outletDoc = await Outlet.findById(rawOutletId).select('_id name code isActive').lean();
  if (!outletDoc) {
    return res.status(422).json({ success: false, message: 'Outlet not found in this tenant.' });
  }
  const outletId = String(outletDoc._id);
  const outletName = outletDoc.name || '';
  const outletCode = outletDoc.code || '';

  // 32 random bytes → 64 hex chars. The plain token is returned once and
  // never stored in cleartext; we keep only its SHA-256 hash.
  const plainToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(plainToken);

  const device = await AttendanceDeviceModel().create({
    tokenHash,
    tenantSlug: req.tenantSlug,
    label,
    outletId,
    outletName,
    outletCode,
    createdByEmail: req.user?.email || '',
  });

  logger.info(`Attendance device created: tenant=${req.tenantSlug} label="${label}" outlet=${outletCode || '(any)'} by=${req.user?.email}`);
  return res.status(201).json({
    success: true,
    device: sanitize(device.toObject()),
    // One-time view — copy now or revoke and recreate.
    token: plainToken,
  });
});

// PATCH /api/attendance-devices/:id — owner-only label rename. Outlet
// binding intentionally cannot be re-pointed: the right answer is to revoke
// and mint a new token, so the field stays an immutable claim.
router.patch('/:id', async (req, res) => {
  const label = String(req.body?.label ?? '').slice(0, 80);
  const device = await AttendanceDeviceModel().findOneAndUpdate(
    { _id: req.params.id, tenantSlug: req.tenantSlug },
    { $set: { label } },
    { returnDocument: 'after' }
  ).lean();
  if (!device) {
    return res.status(404).json({ success: false, message: 'Device not found.' });
  }
  invalidateAttendanceDeviceCache(device.tokenHash);
  return res.json({ success: true, device: sanitize(device) });
});

// POST /api/attendance-devices/:id/regenerate — rotates the token for an
// existing device. The original plaintext is unrecoverable (we only store
// its hash), so this is the only way to "get the key back" if it was lost.
// Outlet binding and label are preserved; any tablet currently paired with
// the old token will fail its next request and bounce to /pair.
router.post('/:id/regenerate', async (req, res) => {
  const device = await AttendanceDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
  });
  if (!device) {
    return res.status(404).json({ success: false, message: 'Device not found.' });
  }
  if (device.revokedAt) {
    return res.status(400).json({ success: false, message: 'Cannot regenerate a revoked device.' });
  }

  const plainToken = crypto.randomBytes(32).toString('hex');
  const previousTokenHash = device.tokenHash;
  device.tokenHash = hashToken(plainToken);
  device.lastUsedAt = null; // a regenerated device hasn't been used yet
  await device.save();
  invalidateAttendanceDeviceCache(previousTokenHash);

  logger.info(`Attendance device token regenerated: id=${device._id} tenant=${req.tenantSlug} by=${req.user?.email}`);
  return res.json({
    success: true,
    device: sanitize(device.toObject()),
    token: plainToken,
  });
});

router.delete('/:id', async (req, res) => {
  const device = await AttendanceDeviceModel().findOne({
    _id: req.params.id,
    tenantSlug: req.tenantSlug,
  });
  if (!device) {
    return res.status(404).json({ success: false, message: 'Device not found.' });
  }
  device.revokedAt = new Date();
  await device.save();
  invalidateAttendanceDeviceCache(device.tokenHash);
  logger.info(`Attendance device revoked: id=${device._id} tenant=${req.tenantSlug}`);
  return res.json({ success: true });
});

export default router;
