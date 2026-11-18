import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import logger from '../utils/logger.js';
import { RestaurantDeviceModel } from '../platform/models/RestaurantDevice.js';
import { TenantModel } from '../platform/models/Tenant.js';
import { getTenantConnectionFor } from '../db/connections.js';
import { runWithTenant } from '../db/tenantContext.js';
import User from '../models/User.js';
import Outlet from '../models/Outlet.js';
import SaleSession from '../models/SaleSession.js';
import { allowedByDefault } from '../config/permissions.js';
import { isFeatureEnabledForOutlet } from '../services/outletFeatures.service.js';

const roomSegment = (value, maxLength = 128) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const segment = String(value).trim();
  if (!segment || segment.length > maxLength) return null;
  if (/[:\u0000-\u001f\u007f]/.test(segment)) return null;
  return segment;
};

export const createSocketAuthMiddleware = ({
  jwtSecret,
  verifyToken = jwt.verify,
  findOrderDevice = async (tokenHash) => (
    RestaurantDeviceModel().findOne({
      tokenHash,
      type: 'orderTablet',
      revokedAt: null,
    }).lean()
  ),
} = {}) => (socket, next) => {
  const token = socket.handshake?.auth?.token;
  if (token) {
    try {
      const decoded = verifyToken(token, jwtSecret);
      socket.data.tenantSlug = roomSegment(decoded?.tenantSlug, 48);
      socket.data.userId = decoded?.id || null;
    } catch {
      // Public QR clients intentionally connect without staff authentication.
      // An invalid staff token remains anonymous and therefore cannot enter any
      // authenticated room below.
      socket.data.tenantSlug = null;
      socket.data.userId = null;
    }
    return next();
  }

  const orderDeviceToken = socket.handshake?.auth?.orderDeviceToken;
  if (
    typeof orderDeviceToken !== 'string'
    || !orderDeviceToken
    || orderDeviceToken.length > 2048
  ) return next();

  const tokenHash = createHash('sha256').update(orderDeviceToken).digest('hex');
  return Promise.resolve(findOrderDevice(tokenHash))
    .then((device) => {
      if (device) {
        socket.data.tenantSlug = roomSegment(device.tenantSlug, 48);
        socket.data.deviceId = String(device._id);
        socket.data.deviceType = device.type;
        socket.data.outletId = String(device.outletId);
      }
      next();
    })
    .catch(() => {
      // Database/network failures do not grant a partially authenticated room.
      socket.data.tenantSlug = null;
      socket.data.deviceId = null;
      next();
    });
};

export const registerSocketHandlers = (io, socketLogger = logger) => {
  io.on('connection', (socket) => {
    socketLogger.info(`Socket connected: ${socket.id}`);

    // Cashier rooms are private. The tenant must always come from the verified
    // staff JWT; never trust a tenant supplied in an event payload.
    socket.on('qr:cashier:join', ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const outlet = roomSegment(outletId);
      if (tenantSlug && outlet) {
        socket.join(`qr:cashier:${tenantSlug}:${outlet}`);
      }
    });

    // Public QR customers may join only tightly scoped table/order rooms. These
    // identifiers are non-secret routing values from the scanned QR/order page.
    socket.on('qr:customer:joinTable', ({ tenantSlug, outletId, tableCode } = {}) => {
      const tenant = roomSegment(tenantSlug, 48);
      const outlet = roomSegment(outletId);
      const table = roomSegment(tableCode);
      if (tenant && outlet && table) {
        socket.join(`qr:table:${tenant}:${outlet}:${table}`);
      }
    });

    socket.on('qr:customer:joinOrder', ({ tenantSlug, orderNumber } = {}) => {
      const tenant = roomSegment(tenantSlug, 48);
      const order = roomSegment(orderNumber);
      if (tenant && order) {
        socket.join(`qr:order:${tenant}:${order}`);
      }
    });

    socket.on('ops:join', () => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      if (tenantSlug) socket.join(`ops:${tenantSlug}`);
    });

    socket.on('orders:join', ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const outlet = roomSegment(outletId);
      if (tenantSlug && outlet) {
        socket.join(`orders:${tenantSlug}:${outlet}`);
      }
    });

    // KDS rooms never accept an anonymous socket. REST endpoints remain the
    // authorization source of truth; this authenticated room only accelerates
    // already-permitted screens after their initial API load.
    socket.on('kds:join', async ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const userId = roomSegment(socket.data?.userId);
      const outlet = roomSegment(outletId);
      if (!tenantSlug || !userId || !outlet) return;
      try {
        const tenant = await TenantModel().findOne({ slug: tenantSlug }).lean();
        if (!tenant || !isFeatureEnabledForOutlet(tenant, 'kds', outlet)) return;
        const conn = await getTenantConnectionFor(tenantSlug);
        const permitted = await runWithTenant({ conn, slug: tenantSlug }, async () => {
          const [user, kdsOutlet] = await Promise.all([
            User.findById(userId)
              .select('role isActive outlet outletRef permissions')
              .lean({ transform: false }),
            Outlet.findById(outlet).select('kds.enabled').lean(),
          ]);
          if (!user?.isActive || kdsOutlet?.kds?.enabled !== true) return false;
          if (user.role !== 'owner') {
            let permittedOutlet = user.outletRef || null;
            if (!permittedOutlet && user.outlet) {
              permittedOutlet = (await Outlet.findOne({ code: user.outlet }).select('_id').lean())?._id || null;
            }
            if (!permittedOutlet) {
              permittedOutlet = (await SaleSession.findOne({ cashier: userId, status: 'open' }).select('outlet').lean())?.outlet || null;
            }
            if (!permittedOutlet || String(permittedOutlet) !== outlet) return false;
          }
          const rawPermissionEntries = user.permissions instanceof Map
            ? [...user.permissions.entries()]
            : Object.entries(user.permissions || {});
          const permissions = Object.fromEntries(rawPermissionEntries
            .map(([key, value]) => [String(key).replaceAll('___', '.'), Boolean(value)]));
          const can = (key) => user.role === 'owner'
            || (Object.prototype.hasOwnProperty.call(permissions, key)
              ? permissions[key]
              : allowedByDefault(key, user.role));
          return can('kds.view') || can('settings.kds');
        });
        if (permitted) socket.join(`kds:${tenantSlug}:${outlet}`);
      } catch (error) {
        socketLogger.warn(`KDS socket authorization failed: ${error.message}`);
      }
    });

    socket.on('kds:leave', ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const outlet = roomSegment(outletId);
      if (tenantSlug && outlet) socket.leave(`kds:${tenantSlug}:${outlet}`);
    });

    socket.on('tablet:orders:join', () => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const deviceId = roomSegment(socket.data?.deviceId);
      if (tenantSlug && deviceId && socket.data?.deviceType === 'orderTablet') {
        socket.join(`tablet-orders:${tenantSlug}:${deviceId}`);
      }
    });

    socket.on('rider:join', async () => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const userId = roomSegment(socket.data?.userId);
      if (!tenantSlug || !userId) return;
      try {
        const tenant = await TenantModel().findOne({ slug: tenantSlug }).lean();
        if (!tenant) return;
        const conn = await getTenantConnectionFor(tenantSlug);
        const rider = await runWithTenant({ conn, slug: tenantSlug }, () => (
          User.findOne({ _id: userId, role: 'rider', isActive: true })
            .select('outlet outletRef')
            .lean()
        ));
        const outlet = rider?.outletRef || rider?.outlet;
        if (!rider || !outlet || !isFeatureEnabledForOutlet(tenant, 'riderTracking', outlet)) return;
        socket.join(`rider:${tenantSlug}:${userId}`);
      } catch (error) {
        socketLogger.warn(`Rider socket authorization failed: ${error.message}`);
      }
    });

    socket.on('rider-dispatch:join', async ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const userId = roomSegment(socket.data?.userId);
      const outlet = roomSegment(outletId);
      if (!tenantSlug || !userId || !outlet) return;
      try {
        const tenant = await TenantModel().findOne({ slug: tenantSlug }).lean();
        if (!tenant || !isFeatureEnabledForOutlet(tenant, 'riderTracking', outlet)) return;
        const conn = await getTenantConnectionFor(tenantSlug);
        const permitted = await runWithTenant({ conn, slug: tenantSlug }, async () => {
          const user = await User.findById(userId)
            .select('role isActive outlet outletRef permissions')
            .lean({ transform: false });
          if (!user?.isActive || user.role === 'rider') return false;
          if (user.role !== 'owner') {
            let permittedOutlet = user.outletRef || null;
            if (!permittedOutlet && user.outlet) {
              permittedOutlet = (await Outlet.findOne({ code: user.outlet }).select('_id').lean())?._id || null;
            }
            if (!permittedOutlet) {
              permittedOutlet = (await SaleSession.findOne({ cashier: userId, status: 'open' }).select('outlet').lean())?.outlet || null;
            }
            if (!permittedOutlet || String(permittedOutlet) !== outlet) return false;
          }
          const rawEntries = user.permissions instanceof Map
            ? [...user.permissions.entries()]
            : Object.entries(user.permissions || {});
          const permissions = Object.fromEntries(rawEntries
            .map(([key, value]) => [String(key).replaceAll('___', '.'), Boolean(value)]));
          const can = (key) => user.role === 'owner'
            || (Object.prototype.hasOwnProperty.call(permissions, key)
              ? permissions[key]
              : allowedByDefault(key, user.role));
          return can('riderTracking.live') || can('riderTracking.assign');
        });
        if (permitted) socket.join(`rider-dispatch:${tenantSlug}:${outlet}`);
      } catch (error) {
        socketLogger.warn(`Rider dispatch socket authorization failed: ${error.message}`);
      }
    });

    socket.on('rider-dispatch:leave', ({ outletId } = {}) => {
      const tenantSlug = roomSegment(socket.data?.tenantSlug, 48);
      const outlet = roomSegment(outletId);
      if (tenantSlug && outlet) socket.leave(`rider-dispatch:${tenantSlug}:${outlet}`);
    });

    socket.on('disconnect', () => socketLogger.info(`Socket disconnected: ${socket.id}`));
  });
};

export default registerSocketHandlers;
