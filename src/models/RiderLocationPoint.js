import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const riderLocationPointSchema = new mongoose.Schema(
  {
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'RiderShift', required: true, index: true },
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryAssignment', default: null, index: true },
    clientPointId: { type: String, required: true, trim: true, maxlength: 120 },
    location: {
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
    recordedAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    accuracy: { type: Number, min: 0, default: null },
    speed: { type: Number, min: 0, default: null },
    heading: { type: Number, min: 0, max: 360, default: null },
    altitude: { type: Number, default: null },
    batteryLevel: { type: Number, min: 0, max: 100, default: null },
    isMock: { type: Boolean, default: false },
    source: { type: String, enum: ['gps', 'network', 'passive', 'unknown'], default: 'unknown' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

riderLocationPointSchema.index({ rider: 1, clientPointId: 1 }, { unique: true });
riderLocationPointSchema.index({ shift: 1, recordedAt: 1 });
riderLocationPointSchema.index({ assignment: 1, recordedAt: 1 });
riderLocationPointSchema.index({ location: '2dsphere' });
riderLocationPointSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default defineModel('RiderLocationPoint', riderLocationPointSchema);
