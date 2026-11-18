import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPlatformConnection } from '../../db/connections.js';
import { ACCESS_TOKEN_EXPIRES_IN } from '../../config/authTokens.js';

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    isActive: { type: Boolean, default: true },
    refreshToken: { type: String, select: false },
  },
  { timestamps: true }
);

adminSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

adminSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

adminSchema.methods.generateAccessToken = function () {
  return jwt.sign(
    { id: this._id, email: this.email, isPlatformAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
};

adminSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { id: this._id, isPlatformAdmin: true },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN }
  );
};

let cached = null;
export const PlatformAdminModel = () => {
  if (cached) return cached;
  cached = getPlatformConnection().model('PlatformAdmin', adminSchema);
  return cached;
};
