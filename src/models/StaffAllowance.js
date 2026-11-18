import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

/**
 * StaffAllowance — per-user monthly meal allowance ledger.
 *
 * One document per (user, period) pair. When a new period begins, the
 * allowance controller copies the monthlyLimit from the most-recent record
 * and creates a fresh record (usedAmount = 0, excessAmount = 0).
 *
 * Business rules (enforced in the sale controller + allowance controller):
 *   • No discount allowed on allowance orders.
 *   • Orders are never blocked — excess is tracked in excessAmount.
 *   • An owner can settle excess directly with payment details.
 */

const staffAllowanceSchema = new mongoose.Schema(
    {
        // Subject id — the person the allowance belongs to. Polymorphic: a
        // payroll Employee._id when subjectType='employee', or a User._id (the
        // owner) when subjectType='user'. Kept as the field name `user` so the
        // existing unique {user, period} index keeps working with no migration.
        // NEVER .populate() this — use subjectName for display.
        user: {
            type: mongoose.Schema.Types.ObjectId,
            required: [true, 'Subject is required.'],
        },
        subjectType: {
            type: String,
            enum: ['employee', 'user'],
            default: 'employee',
            required: true,
        },
        // Denormalised display name (employee/owner name at the time it was set).
        subjectName: { type: String, trim: true },
        // Master on/off switch. When false the subject is hidden from the POS
        // allowance picker and cannot charge, but limit & history are preserved.
        enabled: { type: Boolean, default: true },

        // Configured monthly ceiling (PKR). Set by owner/financeManager.
        monthlyLimit: {
            type: Number,
            required: [true, 'Monthly limit is required.'],
            min: [0, 'Monthly limit cannot be negative.'],
        },

        // YYYY-MM — one record per user per calendar month.
        period: {
            type: String,
            required: [true, 'Period is required.'],
            match: [/^\d{4}-\d{2}$/, 'Period must be YYYY-MM format.'],
        },

        // Running total consumed within the limit this period.
        usedAmount: { type: Number, default: 0, min: 0 },

        // Running total that exceeded the monthly limit this period.
        excessAmount: { type: Number, default: 0, min: 0 },

        // Portion of `excessAmount` already recovered — via direct settlement OR a
        // salary deduction. Outstanding excess = excessAmount − excessRecoveredAmount.
        excessRecoveredAmount: { type: Number, default: 0, min: 0 },

        // ── Settlement of excess ──────────────────────────────────────────────────
        excessSettled: { type: Boolean, default: false },
        excessSettledAt: { type: Date },
        excessSettledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

        settlementStatus: {
            type: String,
            enum: ['none', 'settled'],
            default: 'none',
        },

        // Payment details captured at settlement time
        settlementPaymentMode: {
            type: String,
            enum: ['cash', 'online_transfer'],
        },
        settlementTransactionId: { type: String, trim: true },   // mandatory for online_transfer
        settlementReceiverUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // employee who received

        settlementJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },

        notes: { type: String, trim: true },
    },
    { timestamps: true }
);

// Unique per user per period
staffAllowanceSchema.index({ user: 1, period: 1 }, { unique: true });
staffAllowanceSchema.index({ period: 1 });
staffAllowanceSchema.index({ excessAmount: 1, excessSettled: 1 });

// Virtual helpers
staffAllowanceSchema.virtual('remainingAmount').get(function () {
    return Math.max(0, this.monthlyLimit - this.usedAmount);
});
staffAllowanceSchema.virtual('totalUsed').get(function () {
    return this.usedAmount + this.excessAmount;
});

staffAllowanceSchema.set('toJSON', { virtuals: true });
staffAllowanceSchema.set('toObject', { virtuals: true });

const StaffAllowance = defineModel('StaffAllowance', staffAllowanceSchema);

export default StaffAllowance;
