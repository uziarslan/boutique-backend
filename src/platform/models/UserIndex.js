import mongoose from 'mongoose';
import { getPlatformConnection } from '../../db/connections.js';

// Maps an email to the tenant that owns the user record. Used at login to
// resolve the right tenant DB before verifying credentials. Email is unique
// across the entire platform.
const userIndexSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    tenantSlug: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, default: 'owner' },
  },
  { timestamps: true }
);

userIndexSchema.index({ tenantSlug: 1 });

let cached = null;
export const UserIndexModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('UserIndex', userIndexSchema);
  return cached;
};
