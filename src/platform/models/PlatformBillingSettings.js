import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

const bankDetailsSchema = new mongoose.Schema({
  active: { type: Boolean, default: false },
  bankName: { type: String, trim: true, default: '' },
  accountTitle: { type: String, trim: true, default: '' },
  accountNumber: { type: String, trim: true, default: '' },
  iban: { type: String, trim: true, uppercase: true, default: '' },
  branchName: { type: String, trim: true, default: '' },
  branchCode: { type: String, trim: true, default: '' },
  swiftCode: { type: String, trim: true, uppercase: true, default: '' },
  currency: { type: String, trim: true, uppercase: true, default: 'PKR' },
  paymentNotes: { type: String, trim: true, default: '' },
}, { _id: false });

const platformBillingSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'platform-billing' },
  bankDetails: { type: bankDetailsSchema, default: () => ({}) },
  updatedBy: { type: String, trim: true, default: '' },
}, { timestamps: true });

let cached = null;
export const PlatformBillingSettingsModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('PlatformBillingSettings', platformBillingSettingsSchema);
  return cached;
};

export const getPlatformBillingSettings = () => PlatformBillingSettingsModel().findByIdAndUpdate(
  'platform-billing',
  { $setOnInsert: { bankDetails: {} } },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
);
