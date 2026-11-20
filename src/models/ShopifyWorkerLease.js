import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

export default defineModel('ShopifyWorkerLease', new mongoose.Schema({
  _id: { type: String },
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}));
