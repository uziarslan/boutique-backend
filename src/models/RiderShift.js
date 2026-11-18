import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const pointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (value) => Array.isArray(value)
          && value.length === 2
          && value.every(Number.isFinite),
        message: 'Location coordinates must be [longitude, latitude].',
      },
    },
  },
  { _id: false },
);

const locationSnapshotSchema = new mongoose.Schema(
  {
    location: { type: pointSchema, required: true },
    recordedAt: { type: Date, required: true },
    accuracy: { type: Number, min: 0, default: null },
    batteryLevel: { type: Number, min: 0, max: 100, default: null },
    isMock: { type: Boolean, default: false },
  },
  { _id: false },
);

const riderShiftSchema = new mongoose.Schema(
  {
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'ended', 'feature_disabled', 'admin_ended'],
      default: 'active',
      index: true,
    },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt: { type: Date, default: null },
    startLocation: { type: locationSnapshotSchema, default: undefined },
    endLocation: { type: locationSnapshotSchema, default: undefined },
    lastLocation: { type: locationSnapshotSchema, default: undefined },
    // Server receipt time is the liveness clock. lastLocation.recordedAt is a
    // device timestamp and remains the source of truth for route playback.
    lastLocationReceivedAt: { type: Date, default: null },
    pointCount: { type: Number, min: 0, default: 0 },
    distanceMeters: { type: Number, min: 0, default: 0 },
    inOutletGeofence: { type: Boolean, default: null },
    endReason: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { timestamps: true },
);

riderShiftSchema.index(
  { rider: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
riderShiftSchema.index({ outlet: 1, startedAt: -1 });
riderShiftSchema.index({ 'lastLocation.location': '2dsphere' });

export default defineModel('RiderShift', riderShiftSchema);
