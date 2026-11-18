import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One sub-doc per direct cash/bank repayment. Tracking these individually
// (instead of just a recoveredAmount counter) lets us void a single repayment
// without affecting other recoveries.
const repaymentSchema = new mongoose.Schema(
    {
        amount: { type: Number, required: true, min: 0 },
        repaymentDate: { type: Date, required: true },
        paymentMode: {
            type: String,
            enum: ['cash', 'bank_transfer', 'cheque'],
        },
        transactionRef: { type: String, trim: true },
        notes: { type: String, trim: true },
        journalEntryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JournalEntry',
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        voidedAt: { type: Date },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        voidReason: { type: String, trim: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

const salaryAdvanceSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Employee',
            required: [true, 'Employee is required.'],
        },
        // 'cash' = cash/bank advance (CR Cash). 'cts' = charge-to-salary: staff
        // consumed food/goods, the bill is booked as a receivable and recovered
        // from salary exactly like an advance (CR the selected revenue head).
        type: {
            type: String,
            enum: ['cash', 'cts'],
            default: 'cash',
        },
        // For type 'cts' only — the revenue head the "sale" is punched to.
        revenueAccount: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'ChartOfAccounts',
            required: [function () { return this.type === 'cts'; }, 'Revenue account is required for a charge-to-salary.'],
        },
        amount: {
            type: Number,
            required: [true, 'Advance amount is required.'],
            min: [1, 'Advance amount must be greater than 0.'],
        },
        advanceDate: {
            type: Date,
            required: [true, 'Advance date is required.'],
        },
        // POS-issued advances and CTS charges carry the outlet operating date.
        // This remains stable across overnight shifts even when createdAt falls
        // on the next calendar day.
        businessDate: {
            type: String,
            match: [/^\d{4}-\d{2}-\d{2}$/, 'Business date must be YYYY-MM-DD.'],
            default: null,
        },
        // Required only for cash advances — a CTS charge involves no cash movement.
        paymentMode: {
            type: String,
            enum: ['cash', 'bank_transfer', 'cheque'],
            required: [function () { return this.type !== 'cts'; }, 'Payment mode is required.'],
        },
        transactionRef: {
            type: String,
            trim: true,
        },
        notes: {
            type: String,
            trim: true,
        },
        // Status of recovery
        status: {
            type: String,
            enum: ['pending', 'partially_recovered', 'recovered', 'voided'],
            default: 'pending',
        },
        recoveredAmount: {
            type: Number,
            default: 0,
            min: 0,
        },
        // Direct cash/bank repayments (NOT salary deductions). Salary
        // deductions are tracked on SalaryPayment.recoveryDetails so we can
        // void a payment cleanly.
        repayments: { type: [repaymentSchema], default: [] },
        journalEntryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JournalEntry',
        },
        // Populated when the charge originated at POS checkout. This keeps the
        // payroll receivable and the customer-facing transaction traceable in
        // both directions without changing the existing recovery workflow.
        saleTransaction: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'SaleTransaction',
            default: null,
        },
        // Immutable snapshot of the policy decision at issue time. Historical
        // records therefore remain explainable after an employee's limits or
        // salary are changed.
        creditPolicySnapshot: {
            salaryBasis: { type: Number, min: 0 },
            maxOutstandingPercent: { type: Number, min: 0, max: 60 },
            dailyLimitPercent: { type: Number, min: 0, max: 60 },
            rollingSevenDayLimitPercent: { type: Number, min: 0, max: 60 },
            outstandingBefore: { type: Number, min: 0 },
            issuedTodayBefore: { type: Number, min: 0 },
            issuedSevenDaysBefore: { type: Number, min: 0 },
            issuedCycleBefore: { type: Number, min: 0 },
            availableBefore: { type: Number, min: 0 },
            salaryCycleStart: { type: Date },
            salaryCycleEnd: { type: Date },
            overrideUsed: { type: Boolean, default: false },
            overriddenLimits: { type: [{ type: String, enum: ['daily', 'sevenDays', 'outstanding', 'cycle'] }], default: undefined },
            overrideReason: { type: String, trim: true },
            overriddenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        },
        // Soft-void on the advance itself. Only allowed when no recovery has
        // happened yet (no salary deductions, no direct repayments).
        voidedAt: { type: Date },
        voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        voidReason: { type: String, trim: true },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    { timestamps: true }
);

salaryAdvanceSchema.index({ employee: 1, status: 1 });
salaryAdvanceSchema.index({ employee: 1, createdAt: -1, status: 1 });
salaryAdvanceSchema.index({ businessDate: -1 });

const SalaryAdvance = defineModel('SalaryAdvance', salaryAdvanceSchema);
export default SalaryAdvance;
