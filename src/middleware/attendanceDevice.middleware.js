import crypto from 'crypto';
import { AttendanceDeviceModel } from '../platform/models/AttendanceDevice.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import {
  cacheDel,
  cacheGet,
  cacheSet,
  TENANT_TTL_MS,
  tenantKey,
} from '../utils/requestCache.js';

const DEVICE_TTL_MS = 15 * 1000;
const DEVICE_TOUCH_TTL_MS = 60 * 1000;

export const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex');

export const attendanceDeviceCacheKey = (tokenHash) => `attendance-device:${tokenHash}`;

export const invalidateAttendanceDeviceCache = (tokenHash) => {
  if (tokenHash) cacheDel(attendanceDeviceCacheKey(tokenHash));
};

export const loadActiveAttendanceDevice = async (token) => {
  const tokenHash = hashToken(token);
  const key = attendanceDeviceCacheKey(tokenHash);
  let device = cacheGet(key);
  if (!device) {
    device = await AttendanceDeviceModel().findOne({ tokenHash, revokedAt: null }).lean();
    if (device) cacheSet(key, device, DEVICE_TTL_MS);
  }
  return device || null;
};

export const isSubscriptionActive = (tenant) => {
  if (!tenant) return false;
  if (tenant.status === 'suspended') return false;
  if (!tenant.accessUntil) return false;
  return new Date(tenant.accessUntil).getTime() > Date.now();
};

/**
 * Resolves a tenant from the `X-Attendance-Token` header. If a token is
 * present and valid, attaches `req.tenant` and `req.tenantSlug` and runs the
 * rest of the chain inside that tenant's ALS context. If no header is
 * present, falls through (the next middleware can take over — typically
 * `optionalProtect` for JWT-based access).
 */
export const attachTenantViaDeviceOrUser = (next401 = false) => async (req, res, next) => {
  const headerToken = req.headers['x-attendance-token'];
  if (!headerToken) {
    if (next401 && !req.headers.authorization) {
      return res.status(401).json({ success: false, message: 'No attendance token or auth.' });
    }
    return next();
  }

  const device = await loadActiveAttendanceDevice(headerToken);
  if (!device) {
    return res.status(401).json({ success: false, message: 'Invalid attendance device token.' });
  }
  let tenant = cacheGet(tenantKey(device.tenantSlug));
  if (!tenant) {
    tenant = await TenantModel().findOne({ slug: device.tenantSlug }).lean();
    if (tenant) cacheSet(tenantKey(device.tenantSlug), tenant, TENANT_TTL_MS);
  }
  if (!tenant) {
    return res.status(401).json({ success: false, message: 'Tenant for this device no longer exists.' });
  }
  if (!isSubscriptionActive(tenant)) {
    return res.status(402).json({
      success: false,
      code: 'SUBSCRIPTION_INACTIVE',
      message: 'Tenant subscription is inactive.',
    });
  }

  // Best-effort lastUsedAt update — don't await
  const touchKey = `attendance-device-touch:${device._id}`;
  if (!cacheGet(touchKey)) {
    cacheSet(touchKey, true, DEVICE_TOUCH_TTL_MS);
    AttendanceDeviceModel()
      .updateOne({ _id: device._id }, { $set: { lastUsedAt: new Date() } })
      .catch(() => {});
  }

  req.tenant = tenant;
  req.tenantSlug = tenant.slug;
  req.attendanceDevice = {
    id: device._id,
    label: device.label,
    outletId: device.outletId || null,
    outletName: device.outletName || '',
    outletCode: device.outletCode || '',
  };

  const conn = await getTenantConnectionFor(tenant.slug);
  runWithTenant({ conn, slug: tenant.slug }, () => next());
};

export default attachTenantViaDeviceOrUser;
