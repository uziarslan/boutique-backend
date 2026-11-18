import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_EXPIRES_IN } from '../config/authTokens.js';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required.'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required.'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required.'],
      minlength: [8, 'Password must be at least 8 characters.'],
      select: false,
    },
    role: {
      type: String,
      enum: ['owner', 'financeManager', 'purchaseManager', 'receivingStaff', 'cashier', 'rider'],
      default: 'receivingStaff',
    },
    // Legacy string field — kept for backward compatibility with StockItem queries
    // that use outlet as a plain string (outlet code).
    // New code should prefer outletRef where a typed reference is needed.
    // Migration note: run a one-off script to set outletRef from Outlet.findOne({code: user.outlet})
    // once all outlets have been created in the Outlet collection.
    outlet: {
      type: String,
      trim: true,
    },
    // Typed reference to the Outlet document — populated for cashier users.
    outletRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Outlet',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    refreshToken: {
      type: String,
      select: false,
    },
    // The refresh token that was just replaced by rotation. Kept valid for a
    // short grace window so concurrent refreshes (multiple tabs, or the
    // proactive timer firing alongside a reactive 401) don't trip reuse
    // detection and force a spurious logout.
    previousRefreshToken: {
      type: String,
      select: false,
    },
    refreshTokenRotatedAt: {
      type: Date,
      select: false,
    },
    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpires: {
      type: Date,
      select: false,
    },
    // Per-user sidebar preferences — lets each user hide tabs they don't want
    // cluttering the sidebar (independent of permissions; permissions still gate access).
    sidebarPreferences: {
      hiddenTabs: { type: [String], default: [] },
    },
    // Per-user permission overrides (map of permissionKey -> boolean)
    permissions: {
      type: Map,
      of: Boolean,
      default: {},
      // sanitize keys before saving to Mongo (dots are not allowed in keys)
      set: (perms) => {
        if (!perms || typeof perms !== 'object') return perms;
        const out = {};
        Object.entries(perms).forEach(([k, v]) => {
          const safe = String(k).replaceAll('.', '___');
          out[safe] = !!v;
        });
        return out;
      },
    },
    // Maximum manual discount this user may apply in POS. This is kept
    // separate from the Boolean permission map because it is a numeric policy.
    // Existing users default to 100% so granting pos.discount keeps its legacy
    // behaviour until an owner chooses a tighter limit in Role Settings.
    posDiscountLimitPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 100,
    },
  },
  { timestamps: true }
);

// ─── Pre-save: hash password if modified ─────────────────────────────────────

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// ─── Pre-save: outlet-bound operational roles need an outlet ─────────────────

userSchema.pre('save', function () {
  if (['cashier', 'rider'].includes(this.role) && !this.outlet && !this.outletRef) {
    throw new Error(`${this.role === 'rider' ? 'Rider' : 'Cashier'} users must have an outlet assigned.`);
  }
});

// ─── Instance methods ─────────────────────────────────────────────────────────

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.generateAccessToken = function () {
  const payload = { id: this._id, name: this.name, email: this.email, role: this.role };
  // Include outlet code in JWT so POS middleware can resolve the outlet without a DB lookup
  if (['cashier', 'rider'].includes(this.role) && this.outlet) {
    payload.outletCode = this.outlet;
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
};

userSchema.methods.generateRefreshToken = function () {
  return jwt.sign(
    { id: this._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN }
  );
};

// NOTE: Model compilation will be done after transforms are attached below.

// Restore dotted permission keys when converting docs to JSON/object
const restoreKey = (k) => String(k).replaceAll('___', '.');
const restorePermissionsForResponse = (perms) => {
  if (!perms) return perms;
  const out = {};
  // perms may be a Map or plain object. Handle both.
  if (perms instanceof Map) {
    for (const [k, v] of perms.entries()) {
      out[restoreKey(k)] = !!v;
    }
    return out;
  }

  try {
    const entries = Object.entries(perms);
    entries.forEach(([k, v]) => {
      out[restoreKey(k)] = !!v;
    });
  } catch (e) {
    return perms;
  }
  return out;
};

// Add transforms so all JSON/Object outputs restore permission keys
userSchema.set('toJSON', {
  transform(doc, ret) {
    if (ret.permissions) ret.permissions = restorePermissionsForResponse(ret.permissions);
    // remove sensitive fields if present
    delete ret.password;
    delete ret.refreshToken;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    return ret;
  },
});
userSchema.set('toObject', {
  transform(doc, ret) {
    if (ret.permissions) ret.permissions = restorePermissionsForResponse(ret.permissions);
    delete ret.password;
    delete ret.refreshToken;
    delete ret.passwordResetToken;
    delete ret.passwordResetExpires;
    return ret;
  },
});

const User = defineModel('User', userSchema);

export default User;
