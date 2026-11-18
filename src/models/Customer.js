import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const addressSchema = new mongoose.Schema(
    {
        label: { type: String, trim: true, default: 'Home' },
        street: { type: String, trim: true },
        area: { type: String, trim: true },
        city: { type: String, trim: true },
        isDefault: { type: Boolean, default: false },
    },
    { _id: true }
);

const customerSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            trim: true,
            maxlength: 120,
        },
        phone: {
            type: String,
            required: [true, 'Phone number is required.'],
            unique: true,
            trim: true,
            maxlength: 20,
        },
        email: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 120,
        },
        addresses: {
            type: [addressSchema],
            default: [],
        },

        // ── Membership / Rewards ──────────────────────────────────────────
        // All fields default to neutral values so existing customers are
        // unaffected; only relevant when the membershipRewards feature is on.
        pointsBalance: { type: Number, default: 0, min: 0 },
        lifetimePointsEarned: { type: Number, default: 0, min: 0 },
        lifetimePointsRedeemed: { type: Number, default: 0, min: 0 },
        membershipCardNumber: { type: String, trim: true, default: null },
        membershipCardIssuedAt: { type: Date, default: null },
        // Earliest expiry across the customer's outstanding earn batches.
        // Updated on every earn/redeem; drives the expiry cron and UI warnings.
        pointsExpireAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// `unique: true` on phone already creates the exact-phone index used by the
// login/dedup guard. Do not declare it a second time here.
// Unique only for customers who actually have a card. A *partial* index is
// required here, not `sparse`: sparse only skips documents where the field is
// absent, but cardless customers store `null` (the schema default) or '' — the
// field is present, so a sparse unique index would treat every cardless
// customer as a duplicate. `{ $gt: '' }` matches only non-empty strings, so
// null / '' / missing are excluded from the uniqueness constraint.
customerSchema.index(
    { membershipCardNumber: 1 },
    { unique: true, partialFilterExpression: { membershipCardNumber: { $gt: '' } } },
);

const Customer = defineModel('Customer', customerSchema);
export default Customer;
