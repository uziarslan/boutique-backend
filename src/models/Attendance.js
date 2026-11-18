import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const attendancePunchSchema = new mongoose.Schema(
    {
        capturedAt: { type: Date, required: true },
        recognitionMethod: {
            type: String,
            enum: ['manual', 'faceid', 'device'],
            required: true,
        },
        deviceSerialNo: { type: String, trim: true, default: null },
        deviceLabel: { type: String, trim: true, default: null },
    },
    { _id: true }
);

const attendanceSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Employee',
            required: true,
            index: true,
        },
        outlet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Outlet',
            default: null,
            index: true,
        },
        capturedAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        // The outlet operating date. Unlike a calendar date, this remains the
        // same across midnight when the outlet day/employee shift is overnight.
        businessDate: {
            type: String,
            default: null,
            match: [/^\d{4}-\d{2}-\d{2}$/, 'Business date must be YYYY-MM-DD.'],
            index: true,
        },
        checkInAt: { type: Date, default: null },
        checkOutAt: { type: Date, default: null },
        // Snapshot the first terminal's policy for this attendance day. null
        // keeps historical and non-terminal records on their existing rules.
        graceMinutes: { type: Number, default: null, min: 0, max: 1440 },
        graceTerminalId: { type: String, default: null },
        attendanceState: {
            type: String,
            enum: ['present', 'absent', 'leave', 'off', 'incomplete'],
            default: 'present',
            index: true,
        },
        // Raw machine/Face ID punches are retained even when a manager applies
        // a manual correction. Effective check-in/out live above.
        punches: { type: [attendancePunchSchema], default: [] },
        selfieUrl: {
            type: String,
            default: null,
            trim: true,
        },
        selfiePublicId: {
            type: String,
            default: null,
            trim: true,
        },
        status: {
            type: String,
            enum: ['pending', 'approved'],
            default: 'pending',
            index: true,
        },
        approvedAt: {
            type: Date,
            default: null,
        },
        recognitionMethod: {
            type: String,
            // 'device' = recognized by an external Hikvision face terminal.
            enum: ['manual', 'faceid', 'device', 'mixed'],
            default: 'manual',
        },
        matchScore: {
            type: Number,
            default: null,
        },
        autoApproved: {
            type: Boolean,
            default: false,
        },
        // ─── External face terminal (Hikvision) ──────────────────────────────
        // Populated only for recognitionMethod === 'device'.
        deviceSerialNo: {
            type: String,
            trim: true,
            default: null,
        },
        deviceLabel: {
            type: String,
            trim: true,
            default: null,
        },
        // ─── Liveness (enhanced attendance) ──────────────────────────────────
        // Whether the client-side blink + head-turn challenge passed for this
        // camera check-in. null = not applicable (feature was off / device).
        livenessPassed: {
            type: Boolean,
            default: null,
        },
        livenessChallenge: {
            type: String,
            trim: true,
            default: null,
        },
        // store the employee's shift at the time of attendance (HH:MM 24-hour)
        shiftStart: {
            type: String,
            trim: true,
            default: null,
        },
        shiftEnd: {
            type: String,
            trim: true,
            default: null,
        },
        // Day-specific schedule corrections never rewrite the captured punches
        // or the employee's default shift. Retain each owner correction.
        shiftCorrections: {
            type: [new mongoose.Schema({
                previousStart: { type: String, default: null },
                previousEnd: { type: String, default: null },
                shiftStart: { type: String, required: true },
                shiftEnd: { type: String, required: true },
                source: { type: String, enum: ['employee', 'custom'], required: true },
                reason: { type: String, required: true, trim: true },
                correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
                correctedAt: { type: Date, required: true },
            }, { _id: false })],
            default: [],
        },
        timezone: { type: String, trim: true, default: null },
        businessDayStart: { type: String, trim: true, default: null },
        businessDayEnd: { type: String, trim: true, default: null },
        manualOverride: { type: Boolean, default: false, index: true },
        // null preserves compatibility with old manual records: an existing
        // effective time was manually entered; an empty field can take scans.
        manualCheckInLocked: { type: Boolean, default: null },
        manualCheckOutLocked: { type: Boolean, default: null },
        manualReason: { type: String, trim: true, default: null },
        manualNotes: { type: String, trim: true, default: null },
        manualUpdatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
        manualUpdatedAt: { type: Date, default: null },
        manualBatchId: { type: String, trim: true, default: null },
    },
    { timestamps: true }
);

attendanceSchema.index({ employee: 1, capturedAt: -1 });
attendanceSchema.index(
    { employee: 1, outlet: 1, businessDate: 1 },
    {
        unique: true,
        partialFilterExpression: { businessDate: { $type: 'string' } },
        name: 'attendance_employee_outlet_business_date_unique',
    }
);

const Attendance = defineModel('Attendance', attendanceSchema);
export default Attendance;
