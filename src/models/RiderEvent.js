import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const riderEventSchema = new mongoose.Schema(
  {
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'RiderShift', default: null, index: true },
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryAssignment', default: null, index: true },
    type: {
      type: String,
      enum: [
        'shift_started', 'shift_ended', 'outlet_entered', 'outlet_exited',
        'tracking_started', 'tracking_stopped', 'tracking_gap', 'mock_location',
        'assignment_created', 'assignment_reassigned', 'delivery_status',
        'feature_disabled', 'device_registered', 'heartbeat',
      ],
      required: true,
      index: true,
    },
    at: { type: Date, required: true, default: Date.now, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true },
);

riderEventSchema.index({ outlet: 1, at: -1 });
riderEventSchema.index({ rider: 1, at: -1 });

export default defineModel('RiderEvent', riderEventSchema);
