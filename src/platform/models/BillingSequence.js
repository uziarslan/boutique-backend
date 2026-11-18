import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

const billingSequenceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

let cached = null;
export const BillingSequenceModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('BillingSequence', billingSequenceSchema);
  return cached;
};
