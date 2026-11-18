import crypto from 'crypto';
import { RestaurantDeviceModel } from '../platform/models/RestaurantDevice.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import { isSubscriptionActive } from './attendanceDevice.middleware.js';
import {
  cacheDel,
  cacheGet,
  cacheSet,
  TENANT_TTL_MS,
  tenantKey,
} from '../utils/requestCache.js';

const DEVICE_TTL_MS = 15 * 1000;
const DEVICE_TOUCH_TTL_MS = 60 * 1000;

export const hashRestaurantDeviceToken = (token) =>
  crypto.createHash('sha256').update(String(token || '')).digest('hex');

export const restaurantDeviceCacheKey = (tokenHash) => `restaurant-device:${tokenHash}`;

export const invalidateRestaurantDeviceCache = (tokenHash) => {
  if (tokenHash) cacheDel(restaurantDeviceCacheKey(tokenHash));
};

export const loadActiveRestaurantDevice = async (token, expectedType = null) => {
  const tokenHash = hashRestaurantDeviceToken(token);
  const key = restaurantDeviceCacheKey(tokenHash);
  let device = cacheGet(key);
  if (!device) {
    device = await RestaurantDeviceModel().findOne({
      tokenHash,
      revokedAt: null,
    }).lean();
    if (device) cacheSet(key, device, DEVICE_TTL_MS);
  }
  if (expectedType && device?.type !== expectedType) return null;
  return device || null;
};

export const attachRestaurantDevice = (expectedType) => async (req, res, next) => {
  const header = expectedType === 'printStation'
    ? req.headers['x-print-station-token']
    : req.headers['x-order-device-token'];
  if (!header) {
    return res.status(401).json({ success: false, message: 'Device token required.' });
  }

  const device = await loadActiveRestaurantDevice(header, expectedType);
  if (!device) {
    return res.status(401).json({ success: false, message: 'Invalid or revoked device token.' });
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
    return res.status(402).json({ success: false, code: 'SUBSCRIPTION_INACTIVE', message: 'Tenant subscription is inactive.' });
  }

  const touchKey = `restaurant-device-touch:${device._id}`;
  if (!cacheGet(touchKey)) {
    cacheSet(touchKey, true, DEVICE_TOUCH_TTL_MS);
    RestaurantDeviceModel().updateOne(
      { _id: device._id },
      { $set: { lastUsedAt: new Date(), lastIp: req.ip || '' } },
    ).catch(() => {});
  }

  req.tenant = tenant;
  req.tenantSlug = tenant.slug;
  req.restaurantDevice = {
    id: String(device._id),
    type: device.type,
    label: device.label || '',
    outletId: device.outletId,
    outletName: device.outletName || '',
    outletCode: device.outletCode || '',
    printStationId: device.printStationId || '',
    printStationLabel: device.printStationLabel || '',
  };
  const conn = await getTenantConnectionFor(tenant.slug);
  runWithTenant({ conn, slug: tenant.slug }, () => next());
};
