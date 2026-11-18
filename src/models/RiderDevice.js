import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const riderDeviceSchema = new mongoose.Schema(
  {
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true, trim: true, maxlength: 200 },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    platform: { type: String, enum: ['android'], default: 'android' },
    manufacturer: { type: String, trim: true, maxlength: 100, default: '' },
    model: { type: String, trim: true, maxlength: 100, default: '' },
    osVersion: { type: String, trim: true, maxlength: 40, default: '' },
    appVersion: { type: String, trim: true, maxlength: 40, default: '' },
    pushToken: { type: String, trim: true, maxlength: 500, default: '' },
    pushTokenUpdatedAt: { type: Date, default: null },
    pushRegistrationError: { type: String, trim: true, maxlength: 500, default: '' },
    lastSeenAt: { type: Date, default: null },
    lastLocationReceivedAt: { type: Date, default: null },
    lastTaskCallbackAt: { type: Date, default: null },
    lastWatchdogAt: { type: Date, default: null },
    lastUploadAt: { type: Date, default: null },
    lastTrackingError: { type: String, trim: true, maxlength: 500, default: '' },
    locationQueueDepth: { type: Number, min: 0, max: 1000, default: 0 },
    trackingMode: { type: String, enum: ['background', 'foreground', 'stopped', 'unknown'], default: 'unknown' },
    backgroundLocationGranted: { type: Boolean, default: null },
    batteryOptimizationEnabled: { type: Boolean, default: null },
    lowPowerMode: { type: Boolean, default: null },
    consecutiveUploadFailures: { type: Number, min: 0, max: 10_000, default: 0 },
    batteryLevel: { type: Number, min: 0, max: 100, default: null },
    locationPermission: { type: String, enum: ['precise', 'approximate', 'denied', 'unknown'], default: 'unknown' },
    notificationsEnabled: { type: Boolean, default: null },
    trackingEnabled: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

riderDeviceSchema.index({ rider: 1, deviceId: 1 }, { unique: true });
riderDeviceSchema.index({ pushToken: 1 }, { sparse: true });

export default defineModel('RiderDevice', riderDeviceSchema);
