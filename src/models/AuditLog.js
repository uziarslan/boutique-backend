import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const auditLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    module: {
      type: String,
      required: true,
      trim: true,
    },
    recordId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    before: {
      type: mongoose.Schema.Types.Mixed,
    },
    after: {
      type: mongoose.Schema.Types.Mixed,
    },
    ip: {
      type: String,
      trim: true,
    },
    // Friendly device label (e.g. "Chrome on macOS") + coarse location + the
    // raw User-Agent, derived from the request for the audit viewer.
    device: { type: String, trim: true },
    location: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    // ── Auto-capture fields (set by the global audit middleware) ──────────────
    // Distinguishes how the entry was created and records HTTP context so the
    // owner audit log can show who did what, where, and the result.
    source: {
      type: String,
      enum: ['auto', 'action', 'auth'],
      default: 'action',
    },
    method: { type: String, trim: true },      // HTTP verb (POST/PUT/PATCH/DELETE)
    path: { type: String, trim: true },        // request path (no query string)
    statusCode: { type: Number },              // response status
    actorName: { type: String, trim: true },   // denormalised user name for display
    actorRole: { type: String, trim: true },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { versionKey: false }
);

auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ module: 1, timestamp: -1 });
auditLogSchema.index({ user: 1, timestamp: -1 });
auditLogSchema.index({ recordId: 1 });

const AuditLog = defineModel('AuditLog', auditLogSchema);

export default AuditLog;
