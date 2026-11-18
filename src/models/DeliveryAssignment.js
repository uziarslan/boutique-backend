import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

export const RIDER_DELIVERY_STATUSES = [
  'assigned',
  'accepted',
  'picked_up',
  'delivered',
  'delivery_failed',
  'returned_to_restaurant',
  'reassigned',
  'cancelled',
];

const statusEventSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RIDER_DELIVERY_STATUSES, required: true },
    at: { type: Date, required: true, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, trim: true, default: '' },
    reason: { type: String, trim: true, maxlength: 500, default: '' },
    clientEventId: { type: String, trim: true, maxlength: 120, default: '' },
    location: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      accuracy: { type: Number, min: 0, default: null },
    },
  },
  { _id: true },
);

const deliveryItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    name: { type: String, required: true, trim: true },
    variation: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: '' },
    },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, min: 0, default: 0 },
    lineTotal: { type: Number, min: 0, default: 0 },
    notes: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { _id: false },
);

const deliveryAssignmentSchema = new mongoose.Schema(
  {
    saleTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'SaleTransaction', required: true, index: true },
    kdsOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'KdsOrder', default: null, index: true },
    outlet: { type: mongoose.Schema.Types.ObjectId, ref: 'Outlet', required: true, index: true },
    rider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, required: true, default: Date.now },
    businessDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, default: null, index: true },
    orderNumber: { type: String, required: true, trim: true },
    customerName: { type: String, trim: true, default: '' },
    customerPhone: { type: String, trim: true, default: '' },
    deliveryAddress: {
      label: { type: String, trim: true, default: '' },
      street: { type: String, trim: true, default: '' },
      area: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    deliveryChargeAmount: { type: Number, min: 0, default: 0 },
    totalAmount: { type: Number, min: 0, default: 0 },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    items: { type: [deliveryItemSchema], default: [] },
    deliveryRunId: { type: String, trim: true, maxlength: 120, default: '', index: true },
    pickupState: {
      type: String,
      enum: ['queued_at_restaurant', 'ready_for_pickup', 'with_rider', 'delivery_stop_completed', 'completed'],
      default: 'queued_at_restaurant',
      index: true,
    },
    queuedAtRestaurantAt: { type: Date, default: null },
    readyForPickupAt: { type: Date, default: null },
    runStartedAt: { type: Date, default: null },
    routeSequence: { type: Number, min: 0, default: 0 },
    routeStartedAt: { type: Date, default: null },
    routeEndedAt: { type: Date, default: null },
    routePointCount: { type: Number, min: 0, default: 0 },
    routeDistanceMeters: { type: Number, min: 0, default: 0 },
    routeStartLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    routeEndLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
    },
    deliveryOutcome: {
      type: String,
      enum: ['', 'delivered', 'delivery_failed'],
      default: '',
      index: true,
    },
    runReturnedAt: { type: Date, default: null },
    status: { type: String, enum: RIDER_DELIVERY_STATUSES, default: 'assigned', index: true },
    active: { type: Boolean, default: true, index: true },
    statusHistory: { type: [statusEventSchema], default: [] },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

deliveryAssignmentSchema.index(
  { saleTransaction: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
deliveryAssignmentSchema.index({ rider: 1, active: 1, assignedAt: -1 });
deliveryAssignmentSchema.index({ rider: 1, businessDate: -1, assignedAt: -1 });
deliveryAssignmentSchema.index({ rider: 1, deliveryRunId: 1, routeSequence: 1 });
deliveryAssignmentSchema.index({ outlet: 1, active: 1, assignedAt: -1 });

export default defineModel('DeliveryAssignment', deliveryAssignmentSchema);
