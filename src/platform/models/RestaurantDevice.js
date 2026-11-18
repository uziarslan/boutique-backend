import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

// Outlet-bound credentials for staff order tablets and on-premise print
// stations. Plain tokens are shown once; only SHA-256 hashes are retained.
const restaurantDeviceSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    tenantSlug: { type: String, required: true, lowercase: true, trim: true, index: true },
    type: { type: String, enum: ['orderTablet', 'printStation'], required: true },
    label: { type: String, trim: true, default: '' },
    outletId: { type: String, required: true, trim: true },
    outletName: { type: String, trim: true, default: '' },
    outletCode: { type: String, trim: true, default: '' },
    // Order tablets can be routed to a specific on-premise print station.
    // Existing tablets without this field retain the legacy outlet-wide
    // fallback until a second station is created, when they are backfilled to
    // the original station.
    printStationId: { type: String, trim: true, default: '' },
    printStationLabel: { type: String, trim: true, default: '' },
    createdByEmail: { type: String, lowercase: true, trim: true, default: '' },
    lastUsedAt: { type: Date, default: null },
    lastIp: { type: String, trim: true, default: '' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

restaurantDeviceSchema.index({ tenantSlug: 1, type: 1, createdAt: -1 });

let cached = null;
export const RestaurantDeviceModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('RestaurantDevice', restaurantDeviceSchema);
  return cached;
};
