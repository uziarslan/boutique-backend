import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

// One row per advance touched by this payrun — captured at pay time so that
// voiding the salary can roll the advance receivables back exactly. Without
// this, a void would have to re-derive the recovery using FIFO, which can
// drift if other payruns ran in between.
const recoveryDetailSchema = new mongoose.Schema(
    {
        advance: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryAdvance', required: true },
        amount: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

// One row per StaffAllowance record whose excess this payrun recovered — so a
// void can roll each record's excessRecoveredAmount / settled flags back exactly.
const allowanceRecoveryDetailSchema = new mongoose.Schema(
    {
        allowance: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffAllowance', required: true },
        amount: { type: Number, required: true, min: 0 },
        // True when this payrun flipped the record to fully-settled (restore on void).
        settledNow: { type: Boolean, default: false },
    },
    { _id: false }
);

// Payroll attendance is snapshotted at pay time so a later device sync or
// attendance edit cannot silently change how a historical salary was derived.
// Manual overrides are payroll-only fallbacks; they do not create biometric
// Attendance records.
const manualAttendanceOverrideSchema = new mongoose.Schema(
    {
        date: {
            type: String,
            required: true,
            match: [/^\d{4}-\d{2}-\d{2}$/, 'Attendance override date must be YYYY-MM-DD.'],
        },
        present: { type: Boolean, required: true },
        // Payroll-only state selected from the salary calendar. `present`
        // remains for backwards compatibility and compact worked-day math.
        state: {
            type: String,
            enum: ['on_time', 'late', 'off', 'absent'],
        },
    },
    { _id: false }
);

const attendanceCalculationSchema = new mongoose.Schema(
    {
        calculationVersion: { type: Number, default: 1 },
        baseSalary: { type: Number, required: true, min: 0 },
        periodDays: { type: Number, required: true, min: 28, max: 31 },
        paidOffDutyDays: { type: Number, min: 0, max: 15 },
        paidOffDutyLimit: { type: Number, min: 0, max: 15 },
        workingDays: { type: Number, min: 1, max: 31 },
        devicePresentDays: { type: Number, required: true, min: 0, max: 31 },
        payableDays: { type: Number, required: true, min: 0, max: 31 },
        workedDays: { type: Number, min: 0, max: 31 },
        regularPaidDays: { type: Number, min: 0, max: 31 },
        holidayWorkedDays: { type: Number, min: 0, max: 15 },
        unpaidDays: { type: Number, required: true, min: 0, max: 31 },
        dailyRate: { type: Number, min: 0 },
        baseEarned: { type: Number, min: 0 },
        attendanceDeduction: { type: Number, required: true, min: 0 },
        holidayWorkPay: { type: Number, min: 0 },
        prepaidPeriod: {
            type: String,
            match: [/^\d{4}-\d{2}$/, 'Prepaid period must be YYYY-MM format.'],
        },
        prepaidDates: {
            type: [{ type: String, match: [/^\d{4}-\d{2}-\d{2}$/, 'Prepaid date must be YYYY-MM-DD.'] }],
            default: [],
        },
        prepaidDays: { type: Number, min: 0, max: 31 },
        prepaidDailyRate: { type: Number, min: 0 },
        prepaidPay: { type: Number, min: 0 },
        shiftHours: { type: Number, min: 0, max: 24 },
        hourlyRate: { type: Number, min: 0 },
        overtimeEnabled: { type: Boolean, default: false },
        overtimeMinutes: { type: Number, min: 0 },
        overtimePay: { type: Number, min: 0 },
        manualOverrides: { type: [manualAttendanceOverrideSchema], default: [] },
    },
    { _id: false }
);

const salaryPaymentSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Employee',
            required: [true, 'Employee is required.'],
        },
        // YYYY-MM — salary period this payment covers
        period: {
            type: String,
            required: [true, 'Period is required.'],
            match: [/^\d{4}-\d{2}$/, 'Period must be YYYY-MM format.'],
        },
        grossAmount: {
            type: Number,
            required: [true, 'Gross amount is required.'],
            min: [0, 'Gross amount cannot be negative.'],
        },
        attendanceCalculation: {
            type: attendanceCalculationSchema,
            default: undefined,
        },
        // Advance deducted from this payrun
        advanceDeducted: {
            type: Number,
            default: 0,
            min: [0, 'Advance deducted cannot be negative.'],
        },
        // Allowance excess recovered from this payrun (cleared against 1101).
        allowanceExcessDeducted: {
            type: Number,
            default: 0,
            min: [0, 'Allowance excess deducted cannot be negative.'],
        },
        // Manual disciplinary/operational penalty applied to this payslip.
        // Unlike an advance recovery, this reduces payroll expense and the
        // accrued amount owed to the employee.
        penaltyDeducted: {
            type: Number,
            default: 0,
            min: [0, 'Penalty cannot be negative.'],
        },
        netAmount: {
            type: Number,
            required: [true, 'Net amount is required.'],
            min: [0, 'Net amount cannot be negative.'],
        },
        paymentDate: {
            type: Date,
            required: [true, 'Payment date is required.'],
        },
        paymentMode: {
            type: String,
            enum: ['cash', 'bank_transfer', 'cheque'],
            required: [true, 'Payment mode is required.'],
        },
        transactionRef: {
            type: String,
            trim: true,
        },
        notes: {
            type: String,
            trim: true,
        },
        // Accrual entry — DR Payroll Expense / CR Accrued Expenses, dated to
        // the last day of the salary period. Recognises the expense in the
        // correct month even if cash leaves later.
        accrualEntryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JournalEntry',
        },
        // One expense accrual per earned month; accrualEntryId remains the
        // selected period's entry for compatibility with historical records.
        accrualEntries: {
            type: [new mongoose.Schema({
                period: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
                grossAmount: { type: Number, required: true, min: 0 },
                penaltyDeducted: { type: Number, default: 0, min: 0 },
                journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', required: true },
            }, { _id: false })],
            default: [],
        },
        // Settlement entry — DR Accrued Expenses / CR Cash + CR Advance Recv,
        // dated to paymentDate. Closes the accrual liability.
        settlementEntryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JournalEntry',
        },
        // Backwards-compat: kept pointing at the settlement entry so older UIs
        // and reports that read journalEntryId continue to work.
        journalEntryId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'JournalEntry',
        },
        // Per-advance breakdown of the deduction. Used by void to restore
        // SalaryAdvance.recoveredAmount exactly to its pre-payment value.
        recoveryDetails: { type: [recoveryDetailSchema], default: [] },
        // Per-allowance-record breakdown of the excess recovered this payrun.
        allowanceRecoveryDetails: { type: [allowanceRecoveryDetailSchema], default: [] },
        // Soft-void support — keeps the audit trail intact.
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

salaryPaymentSchema.index({ employee: 1, period: 1 });

const SalaryPayment = defineModel('SalaryPayment', salaryPaymentSchema);
export default SalaryPayment;
