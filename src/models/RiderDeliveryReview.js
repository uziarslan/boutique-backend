import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// Operational rider settlement/performance data only. Amounts stored here are
// deliberately not connected to journals, ledgers, or the chart of accounts.
const riderDeliveryReviewSchema = new mongoose.Schema(
  {
    saleTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SaleTransaction',
      required: true,
      unique: true,
      index: true,
    },
    assignment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DeliveryAssignment',
      default: null,
      index: true,
    },
    outlet: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
      required: true,
      index: true,
    },
    riderType: { type: String, enum: ['user', 'employee'], required: true },
    rider: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    riderName: { type: String, required: true, trim: true },
    orderNumber: { type: String, required: true, trim: true },
    behaviorRating: { type: Number, min: 1, max: 5, default: null },
    // Informational amount manually entered by staff. This is the rider/fuel
    // cost charged to the restaurant, not the customer-facing delivery fee.
    riderChargeAmount: { type: Number, min: 0, default: null },
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    pickedUpAt: { type: Date, default: null },
    customerDeliveredAt: { type: Date, default: null },
    returnedAt: { type: Date, required: true, index: true },
    deliveryDurationSeconds: { type: Number, min: 0, default: null },
    enteredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    enteredByName: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

riderDeliveryReviewSchema.index({ outlet: 1, returnedAt: -1 });
riderDeliveryReviewSchema.index({ outlet: 1, rider: 1, returnedAt: -1 });

export default defineModel('RiderDeliveryReview', riderDeliveryReviewSchema);
