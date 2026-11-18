import { normalizeDevicePersonId, assertUniqueDevicePersonId } from '../utils/employeeDeviceId.js';
import mongoose from 'mongoose';
import { defineModel } from '../db/defineModel.js';

const employeeSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: [true, 'Employee name is required.'],
            trim: true,
        },
        cnic: {
            type: String,
            required: [true, 'CNIC is required.'],
            unique: true,
            trim: true,
            match: [/^\d{5}-\d{7}-\d{1}$/, 'CNIC must be in format XXXXX-XXXXXXX-X.'],
        },
        phone: {
            type: String,
            trim: true,
        },
        address: {
            type: String,
            trim: true,
        },
        designation: {
            type: String,
            trim: true,
        },
        department: {
            type: String,
            trim: true,
        },
        joiningDate: {
            type: Date,
        },
        salary: {
            type: Number,
            required: [true, 'Salary amount is required.'],
            min: [0, 'Salary cannot be negative.'],
        },
        // Day of month salary is due (1–28)
        salaryDate: {
            type: Number,
            required: [true, 'Salary date is required.'],
            min: [1, 'Salary date must be between 1 and 28.'],
            max: [28, 'Salary date must be between 1 and 28.'],
        },
        // Paid monthly rest-day entitlement. Payroll spreads the monthly
        // salary over the remaining calendar days and pays days worked above
        // that threshold as holiday work.
        paidOffDutyDays: {
            type: Number,
            default: 4,
            min: [0, 'Paid off-duty days cannot be negative.'],
            max: [15, 'Paid off-duty days cannot exceed 15 per month.'],
            validate: {
                validator: Number.isInteger,
                message: 'Paid off-duty days must be a whole number.',
            },
        },
        // Cash advances and POS Charge to Salary share one credit facility.
        // Percentages are employee-specific, while the absolute company ceiling
        // remains 60% so a bad configuration can never expose more salary.
        salaryCreditLimits: {
            cashAdvanceEnabled: { type: Boolean, default: true },
            chargeToSalaryEnabled: { type: Boolean, default: true },
            maxOutstandingPercent: {
                type: Number,
                default: 60,
                min: [0, 'Maximum outstanding percentage cannot be negative.'],
                max: [60, 'Maximum outstanding percentage cannot exceed 60%.'],
            },
            dailyLimitPercent: {
                type: Number,
                default: 10,
                min: [0, 'Daily limit percentage cannot be negative.'],
                max: [60, 'Daily limit percentage cannot exceed 60%.'],
            },
            rollingSevenDayLimitPercent: {
                type: Number,
                default: 25,
                min: [0, 'Seven-day limit percentage cannot be negative.'],
                max: [60, 'Seven-day limit percentage cannot exceed 60%.'],
            },
        },
        // Internal short-lived mutex used while an advance/CTS limit is checked
        // and committed. Hidden from normal employee queries and API responses.
        _salaryCreditLock: {
            type: new mongoose.Schema(
                {
                    token: { type: String, required: true },
                    expiresAt: { type: Date, required: true },
                },
                { _id: false }
            ),
            default: undefined,
            select: false,
        },
        bankAccount: {
            type: String,
            trim: true,
        },
        bankName: {
            type: String,
            trim: true,
        },
        // Shift hours in HH:MM format (24-hour)
        shiftStart: {
            type: String,
            trim: true,
        },
        shiftEnd: {
            type: String,
            trim: true,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        outlet: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Outlet',
            default: null,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        faceDescriptors: {
            type: [[Number]],
            default: [],
        },
        faceAngles: {
            type: [String],
            default: [],
        },
        // Element-wise mean of `faceDescriptors`. Acts as a sub-millisecond
        // pre-filter at match time: a probe whose distance to this centroid
        // exceeds the bail threshold can't possibly match this employee, so
        // we skip the full per-descriptor scoring. Recomputed on every
        // enrollment.
        faceCentroid: {
            type: [Number],
            default: null,
        },
        isFaceEnrolled: {
            type: Boolean,
            default: false,
            index: true,
        },
        faceEnrolledAt: {
            type: Date,
            default: null,
        },
        // External face terminal (Hikvision) mapping. The Person/Employee ID
        // configured on the physical device for this staff member. The device
        // sends this value as `employeeNoString` when it recognizes someone;
        // the attendance webhook maps it back to this employee. Optional —
        // only used by tenants with the `attendanceExternalDevice` feature.
        deviceEmployeeNo: {
            type: String,
            trim: true,
            maxlength: 64,
            set: normalizeDevicePersonId,
            default: null,
        },
    },
    { timestamps: true }
);

employeeSchema.index({ isActive: 1 });
// Keep blank mappings optional; the database also blocks concurrent requests.
// A distinct name permits this to coexist with the legacy non-unique index.
employeeSchema.index({ deviceEmployeeNo: 1 }, {
    name: 'unique_device_person_id',
    unique: true,
    partialFilterExpression: { deviceEmployeeNo: { $type: 'string', $gt: '' } },
});

employeeSchema.pre('validate', async function () {
    if (this.isModified('deviceEmployeeNo')) {
        await assertUniqueDevicePersonId(this.constructor, this.deviceEmployeeNo, this._id);
    }
});

for (const operation of ['findOneAndUpdate', 'updateOne']) {
    employeeSchema.pre(operation, async function () {
        const update = this.getUpdate() || {};
        // Mongoose timestamps can add $set beside a plain update payload.
        // Check both shapes so ordinary employee edits cannot bypass validation.
        const targets = [update, update.$set].filter((fields) => fields?.deviceEmployeeNo !== undefined);
        if (!targets.length) return;
        const current = await this.model.findOne(this.getFilter()).select('_id').lean();
        for (const fields of targets) {
            fields.deviceEmployeeNo = normalizeDevicePersonId(fields.deviceEmployeeNo);
            await assertUniqueDevicePersonId(this.model, fields.deviceEmployeeNo, current?._id);
        }
    });
}

employeeSchema.pre('validate', function () {
    const limits = this.salaryCreditLimits;
    if (!limits) return;
    if (Number(limits.dailyLimitPercent) > Number(limits.rollingSevenDayLimitPercent)) {
        this.invalidate(
            'salaryCreditLimits.dailyLimitPercent',
            'Daily credit limit cannot be greater than the rolling seven-day limit.'
        );
    }
    if (Number(limits.rollingSevenDayLimitPercent) > Number(limits.maxOutstandingPercent)) {
        this.invalidate(
            'salaryCreditLimits.rollingSevenDayLimitPercent',
            'Rolling seven-day credit limit cannot be greater than the maximum outstanding limit.'
        );
    }
});

const Employee = defineModel('Employee', employeeSchema);
export default Employee;
