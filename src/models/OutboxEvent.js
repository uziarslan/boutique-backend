import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const outboxEventSchema = new mongoose.Schema(
  {
    eventKey: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    type: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    aggregateType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    aggregateId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    // Payloads intentionally contain identifiers only. Workers reload the
    // authoritative tenant document rather than copying financial or personal
    // data into Redis.
    payload: {
      saleId: { type: String, required: true, trim: true, maxlength: 100 },
      action: { type: String, enum: ['sale', 'credit'], default: 'sale' },
    },
    status: {
      type: String,
      enum: ['pending', 'publishing', 'published', 'completed'],
      default: 'pending',
      required: true,
    },
    publishAttempts: { type: Number, default: 0, min: 0 },
    availableAt: { type: Date, default: Date.now },
    leaseUntil: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 1000 },
  },
  { timestamps: true },
);

outboxEventSchema.index({ eventKey: 1 }, { unique: true });
outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
outboxEventSchema.index({ aggregateType: 1, aggregateId: 1 });

const OutboxEvent = defineModel('OutboxEvent', outboxEventSchema);

export default OutboxEvent;
