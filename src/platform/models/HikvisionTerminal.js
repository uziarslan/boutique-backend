import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

// A registered Hikvision face-recognition terminal (e.g. DS-K1T320MFWX-B).
// Kept in the PLATFORM DB — like AttendanceDevice — because the public event
// webhook must resolve tenant + outlet from the token WITHOUT already being
// inside a tenant context. Deliberately a SEPARATE collection from
// AttendanceDevice so the production-critical tablet-pairing path is untouched.
//
// The device pushes recognition events to
//   POST /api/hikvision-terminals/event/<token>
// where <token> is the plaintext shown once at creation; we store only its
// SHA-256 hash (same scheme as AttendanceDevice.tokenHash).
const hikvisionTerminalSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    tenantSlug: { type: String, required: true, lowercase: true, trim: true, index: true },
    label: { type: String, default: '', trim: true },
    graceMinutes: { type: Number, default: 0, min: 0, max: 1440, validate: Number.isInteger },

    // Outlet binding is required (like attendance devices). The outletId is a
    // Mongo ObjectId inside the tenant DB — stored as a string here because the
    // platform DB has no Outlet model. outletName/outletCode are denormalized
    // so we never have to cross into the tenant DB just to display them.
    outletId: { type: String, default: null },
    outletName: { type: String, default: '', trim: true },
    outletCode: { type: String, default: '', trim: true },

    // Optional hardware serial (printed on the device, e.g. "FC6249195").
    serialNo: { type: String, default: '', trim: true },

    createdByEmail: { type: String, default: '', lowercase: true, trim: true },

    // Observability — updated by the webhook.
    lastEventAt: { type: Date, default: null },
    lastEventEmployeeNo: { type: String, default: '', trim: true },
    // Count of recognition events whose employeeNoString didn't map to any
    // employee. A high value usually means the Device Person IDs weren't set.
    unmatchedCount: { type: Number, default: 0 },

    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

let cached = null;
export const HikvisionTerminalModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('HikvisionTerminal', hikvisionTerminalSchema);
  return cached;
};
