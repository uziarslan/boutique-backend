import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

// Bound to a specific tenant slug. The plain token is shown once on creation
// and never re-displayed; we store the SHA-256 hash and match it on
// X-Attendance-Token header reads.
const attendanceDeviceSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    tenantSlug: { type: String, required: true, lowercase: true, trim: true, index: true },
    label: { type: String, default: '', trim: true },
    // Optional outlet binding. The outletId is a Mongo ObjectId that lives
    // inside the tenant DB — we store it as a string here because the
    // platform DB has no Outlet model. outletName/outletCode are
    // denormalized at creation so /verify can return them without crossing
    // tenants. If null, the device matches across all outlets in the tenant.
    outletId: { type: String, default: null },
    outletName: { type: String, default: '', trim: true },
    outletCode: { type: String, default: '', trim: true },
    createdByEmail: { type: String, default: '', lowercase: true, trim: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

let cached = null;
export const AttendanceDeviceModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('AttendanceDevice', attendanceDeviceSchema);
  return cached;
};
