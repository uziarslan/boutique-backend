import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Outlet from '../models/Outlet.js';
import SalaryPayment from '../models/SalaryPayment.js';
import SalaryAdvance from '../models/SalaryAdvance.js';
import SaleTransaction from '../models/SaleTransaction.js';
import StaffAllowance from '../models/StaffAllowance.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import AuditLog from '../models/AuditLog.js';
import {
    postSalarySettlement,
    postSalaryAdvance,
    postChargeToSalary,
    postAdvanceRepayment,
    reverseJournalEntry,
} from '../accounting/journalEngine.js';
import JournalEntry from '../models/JournalEntry.js';
import logger from '../utils/logger.js';
import { resolveTimezone, startOfLocalDayUtc, endOfLocalDayUtc } from '../utils/timezone.js';
import { calculateAttendanceAdjustedSalary } from '../utils/salaryAttendance.js';
import {
    authorizeEmployeeCredit,
    getEmployeeCreditSummary,
    normalizedEmployeeCreditLimits,
    withEmployeeCreditLock,
} from '../services/employeeCredit.service.js';
import { previewAdvanceDeletion, permanentlyDeleteAdvance } from '../services/advanceDeletion.service.js';
import { salaryPaymentDateContext } from '../utils/salaryPaymentDate.js';
import { salaryAccrualAllocations, salaryAccrualEntryIds } from '../utils/salaryAccrual.js';
import { syncSalaryAccruals } from '../services/salaryAccrual.service.js';
import {
    MAX_EMPLOYEE_IMPORT_ROWS,
    EMPLOYEE_IMPORT_FIELDS,
    EMPLOYEE_IMPORT_MODES,
    employeeImportCnicCandidates,
    employeeImportUpdate,
    prepareEmployeeImportRows,
    summarizeEmployeeImport,
} from '../services/employeeImport.service.js';

// Run an array of compensating undos in reverse order. Each undo swallows
// its own errors so a failed cleanup doesn't mask the original cause.
const runRollback = async (rollback, originalErr) => {
    logger.error(`[salary] failed mid-flight — rolling back ${rollback.length} step(s): ${originalErr.message}`);
    for (let i = rollback.length - 1; i >= 0; i--) {
        try { await rollback[i](); } catch (undoErr) {
            logger.error(`[salary] rollback step ${i} failed: ${undoErr.message}`);
        }
    }
};
import { averageDescriptors } from '../utils/faceMath.js';

const round2 = (n) => parseFloat(parseFloat(n).toFixed(2));

const isValidDescriptor = (descriptor) => {
    if (!Array.isArray(descriptor) || descriptor.length !== 128) return false;
    return descriptor.every((value) => Number.isFinite(Number(value)));
};

const validateSalaryCreditLimits = (raw, fallback = {}) => {
    const merged = {
        ...normalizedEmployeeCreditLimits({ salaryCreditLimits: fallback }),
        ...(raw || {}),
    };
    const limits = {
        cashAdvanceEnabled: merged.cashAdvanceEnabled !== false,
        chargeToSalaryEnabled: merged.chargeToSalaryEnabled !== false,
        maxOutstandingPercent: Number(merged.maxOutstandingPercent),
        dailyLimitPercent: Number(merged.dailyLimitPercent),
        rollingSevenDayLimitPercent: Number(merged.rollingSevenDayLimitPercent),
    };
    const percentages = [
        ['Maximum outstanding', merged.maxOutstandingPercent, limits.maxOutstandingPercent],
        ['Daily', merged.dailyLimitPercent, limits.dailyLimitPercent],
        ['Rolling seven-day', merged.rollingSevenDayLimitPercent, limits.rollingSevenDayLimitPercent],
    ];
    for (const [label, rawValue, value] of percentages) {
        if (rawValue === '' || rawValue === null || !Number.isFinite(value) || value < 0 || value > 60) {
            const error = new Error(`${label} credit limit must be between 0% and 60%.`);
            error.statusCode = 422;
            throw error;
        }
    }
    if (limits.dailyLimitPercent > limits.rollingSevenDayLimitPercent) {
        const error = new Error('Daily credit limit cannot be greater than the rolling seven-day limit.');
        error.statusCode = 422;
        throw error;
    }
    if (limits.rollingSevenDayLimitPercent > limits.maxOutstandingPercent) {
        const error = new Error('Rolling seven-day credit limit cannot be greater than the maximum outstanding limit.');
        error.statusCode = 422;
        throw error;
    }
    return limits;
};

// ─── EMPLOYEES ────────────────────────────────────────────────────────────────

// GET /api/salary/employees
export const listEmployees = async (req, res) => {
    const { active, outlet } = req.query;
    const filter = {};
    if (active === 'true') filter.isActive = true;
    if (active === 'false') filter.isActive = false;
    if (outlet && mongoose.isValidObjectId(outlet)) filter.outlet = new mongoose.Types.ObjectId(outlet);

    const employees = await Employee.find(filter)
        .select('-faceDescriptors')
        .populate('outlet', 'name code')
        .sort({ name: 1 })
        .lean();

    res.json({ success: true, data: employees });
};

// GET /api/salary/employees/:id
export const getEmployee = async (req, res) => {
    const employee = await Employee.findById(req.params.id).select('-faceDescriptors').lean();
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, data: employee });
};

// PUT /api/salary/employees/:id/face-enroll
export const enrollEmployeeFace = async (req, res) => {
    const { descriptors, angles = [] } = req.body;

    if (!Array.isArray(descriptors) || descriptors.length < 5) {
        return res.status(400).json({ success: false, message: 'At least 5 face descriptors are required.' });
    }

    const sanitizedDescriptors = descriptors.map((descriptor) => descriptor?.map((value) => Number(value)));
    if (!sanitizedDescriptors.every(isValidDescriptor)) {
        return res.status(400).json({ success: false, message: 'Each face descriptor must be a numeric array of length 128.' });
    }

    const employee = await Employee.findById(req.params.id);
    if (!employee || !employee.isActive) {
        return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    employee.faceDescriptors = sanitizedDescriptors;
    employee.faceAngles = Array.isArray(angles) ? angles.map((value) => String(value)) : [];
    // Precompute the centroid so matching can pre-filter in O(N) instead of
    // O(N×D). Stored as a 128-d vector — the element-wise mean of all
    // enrolled descriptors.
    employee.faceCentroid = averageDescriptors(sanitizedDescriptors);
    employee.isFaceEnrolled = true;
    employee.faceEnrolledAt = new Date();
    await employee.save();

    logger.info(`Face enrolled for employee ${employee.name} (${employee._id}) by user ${req.user?._id}`);

    res.json({
        success: true,
        data: {
            employeeId: employee._id,
            isFaceEnrolled: employee.isFaceEnrolled,
            faceEnrolledAt: employee.faceEnrolledAt,
        },
    });
};

// POST /api/salary/employees
export const createEmployee = async (req, res) => {
    const { name, cnic, phone, address, designation, department, joiningDate, salary, salaryDate, paidOffDutyDays, bankAccount, bankName, shiftStart, shiftEnd, outlet, deviceEmployeeNo } = req.body;

    // Outlet is required so attendance terminals (which scope candidates by
    // outlet at match time) can find the employee. Without it the record
    // would be invisible to any per-outlet attendance device.
    if (!outlet || !mongoose.isValidObjectId(outlet)) {
        return res.status(422).json({
            success: false,
            message: 'Outlet is required for every employee.',
        });
    }

    let salaryCreditLimits;
    try {
        salaryCreditLimits = validateSalaryCreditLimits(req.body.salaryCreditLimits);
    } catch (error) {
        return res.status(error.statusCode || 422).json({ success: false, message: error.message });
    }

    const employee = await Employee.create({
        name,
        cnic,
        phone,
        address,
        designation,
        department,
        joiningDate,
        salary,
        salaryDate,
        paidOffDutyDays,
        bankAccount,
        bankName,
        shiftStart,
        shiftEnd,
        outlet,
        salaryCreditLimits,
        // Optional external face-terminal (Hikvision) Person ID mapping.
        deviceEmployeeNo: deviceEmployeeNo ? String(deviceEmployeeNo).trim() : null,
        createdBy: req.user.id,
    });

    logger.info(`Employee created: ${employee.name} (${employee.cnic}) by user ${req.user._id}`);
    res.status(201).json({ success: true, data: employee });
};

const prepareBulkEmployeeImport = async (rawRows, duplicateMode) => {
    const outlets = await Outlet.find({ isActive: { $ne: false } })
        .select('_id name code')
        .lean();
    const candidates = employeeImportCnicCandidates(rawRows);
    const existingEmployees = candidates.length
        ? await Employee.find({ cnic: { $in: candidates } })
            .select(['cnic', 'updatedAt', ...Object.keys(EMPLOYEE_IMPORT_FIELDS)].join(' ')).lean()
        : [];
    const prepared = prepareEmployeeImportRows(rawRows, { outlets, existingEmployees, duplicateMode });
    const mappedRows = prepared.filter((row) => row.status === 'ready'
        || (row.status === 'update' && row.changes.some((change) => change.field === 'deviceEmployeeNo')));
    const ids = mappedRows.map((row) => row.data.deviceEmployeeNo).filter(Boolean);
    const owners = ids.length ? await Employee.find({ deviceEmployeeNo: { $in: ids } })
        .select('_id deviceEmployeeNo').lean() : [];
    for (const row of mappedRows) {
        const id = row.data.deviceEmployeeNo;
        if (!id) continue;
        const taken = owners.some((owner) => owner.deviceEmployeeNo === id
            && String(owner._id) !== String(row.existingEmployeeId));
        const repeated = ids.filter((candidate) => candidate === id).length > 1;
        if (taken || repeated) {
            row.status = 'invalid';
            row.errors.push(taken ? 'Device Person ID is already assigned to another employee.'
                : 'Device Person ID appears more than once in this file.');
        }
    }
    return prepared;
};

const importRequestRows = (req, res) => {
    if (!EMPLOYEE_IMPORT_MODES.includes(req.body?.duplicateMode ?? 'skip')) {
        res.status(422).json({ success: false, message: 'Choose a valid duplicate-handling option.' });
        return null;
    }
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
        res.status(422).json({ success: false, message: 'Upload at least one employee row.' });
        return null;
    }
    if (rows.length > MAX_EMPLOYEE_IMPORT_ROWS) {
        res.status(422).json({
            success: false,
            message: `A maximum of ${MAX_EMPLOYEE_IMPORT_ROWS} employees can be imported at once.`,
        });
        return null;
    }
    return rows;
};

// POST /api/salary/employees/bulk-import/preview
export const previewEmployeeBulkImport = async (req, res) => {
    const rows = importRequestRows(req, res);
    if (!rows) return;

    const prepared = await prepareBulkEmployeeImport(rows, req.body.duplicateMode ?? 'skip');
    res.json({
        success: true,
        data: prepared,
        summary: summarizeEmployeeImport(prepared),
        maxRows: MAX_EMPLOYEE_IMPORT_ROWS,
    });
};

const importWriteErrors = (error) => {
    if (error?.code === 11000) return [error.keyPattern?.deviceEmployeeNo || error.keyValue?.deviceEmployeeNo
        ? 'Device Person ID is already assigned to another employee. Choose a unique ID.'
        : 'An employee with this CNIC already exists.'];
    const validationErrors = Object.values(error?.errors || {})
        .map((item) => item?.message)
        .filter(Boolean);
    return validationErrors.length ? validationErrors : [error?.message || 'Employee could not be imported.'];
};

// POST /api/salary/employees/bulk-import
export const bulkImportEmployees = async (req, res) => {
    const rows = importRequestRows(req, res);
    if (!rows) return;

    // Re-run the complete validation and duplicate query at confirmation time.
    // A preview is advisory; this check is authoritative and closes the race
    // where another request creates the same CNIC after the file was previewed.
    const duplicateMode = req.body.duplicateMode ?? 'skip';
    const prepared = await prepareBulkEmployeeImport(rows, duplicateMode);
    const created = [];
    const updated = [];
    const unchanged = prepared.filter((row) => row.status === 'unchanged')
        .map((row) => ({ rowNumber: row.rowNumber, id: row.existingEmployeeId, name: row.data.name, cnic: row.data.cnic }));
    const skipped = prepared
        .filter((row) => ['duplicate', 'invalid'].includes(row.status))
        .map((row) => ({
            rowNumber: row.rowNumber,
            name: row.data.name,
            cnic: row.data.cnic,
            reasons: row.errors,
        }));

    for (const row of prepared.filter((item) => ['ready', 'update'].includes(item.status))) {
        try {
            const data = row.data;
            if (row.status === 'update') {
                const employee = await Employee.findOneAndUpdate(
                    { _id: row.existingEmployeeId, cnic: data.cnic, updatedAt: row.existingUpdatedAt ?? null },
                    { $set: employeeImportUpdate(row, duplicateMode) },
                    { returnDocument: 'after', runValidators: true }
                );
                if (!employee) throw new Error('This employee changed during import. Upload the file again to review the latest record.');
                updated.push({ id: employee._id, name: employee.name, cnic: employee.cnic });
                continue;
            }
            const employee = await Employee.create({
                name: data.name,
                cnic: data.cnic,
                phone: data.phone,
                address: data.address,
                designation: data.designation,
                department: data.department,
                joiningDate: data.joiningDate,
                salary: data.salary,
                salaryDate: data.salaryDate,
                paidOffDutyDays: data.paidOffDutyDays,
                bankAccount: data.bankAccount,
                bankName: data.bankName,
                shiftStart: data.shiftStart,
                shiftEnd: data.shiftEnd,
                outlet: data.outlet,
                salaryCreditLimits: data.salaryCreditLimits,
                deviceEmployeeNo: data.deviceEmployeeNo || null,
                createdBy: req.user.id,
            });
            created.push({ id: employee._id, name: employee.name, cnic: employee.cnic });
        } catch (error) {
            skipped.push({
                rowNumber: row.rowNumber,
                name: row.data.name,
                cnic: row.data.cnic,
                reasons: importWriteErrors(error),
            });
        }
    }

    logger.info(
        `Employee bulk import by ${req.user.email}: created=${created.length}, updated=${updated.length}, unchanged=${unchanged.length}, skipped=${skipped.length}`
    );
    res.status(created.length ? 201 : 200).json({
        success: true,
        data: { created, updated, unchanged, skipped },
        summary: {
            total: prepared.length,
            created: created.length,
            updated: updated.length,
            unchanged: unchanged.length,
            skipped: skipped.length,
        },
    });
};

// PUT /api/salary/employees/:id
export const updateEmployee = async (req, res) => {
    const { name, cnic, phone, address, designation, department, joiningDate, salary, salaryDate, paidOffDutyDays, bankAccount, bankName, shiftStart, shiftEnd, isActive, outlet, deviceEmployeeNo } = req.body;

    // If outlet is being touched, require a real value — same rationale as
    // createEmployee. Allow undefined (no change) but reject explicit null /
    // empty string so we can't accidentally orphan an employee from outlets.
    if (outlet !== undefined && (!outlet || !mongoose.isValidObjectId(outlet))) {
        return res.status(422).json({
            success: false,
            message: 'Outlet is required for every employee.',
        });
    }

    const existingEmployee = await Employee.findById(req.params.id).select('salaryCreditLimits');
    if (!existingEmployee) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const update = { name, cnic, phone, address, designation, department, joiningDate, salary, salaryDate, paidOffDutyDays, bankAccount, bankName, shiftStart, shiftEnd, isActive };
    if (outlet !== undefined) update.outlet = outlet;
    if (req.body.salaryCreditLimits !== undefined) {
        try {
            update.salaryCreditLimits = validateSalaryCreditLimits(
                req.body.salaryCreditLimits,
                existingEmployee.salaryCreditLimits?.toObject?.() || existingEmployee.salaryCreditLimits || {}
            );
        } catch (error) {
            return res.status(error.statusCode || 422).json({ success: false, message: error.message });
        }
    }
    // Allow clearing the mapping by sending an empty string.
    if (deviceEmployeeNo !== undefined) {
        update.deviceEmployeeNo = deviceEmployeeNo ? String(deviceEmployeeNo).trim() : null;
    }

    const employee = await Employee.findByIdAndUpdate(
        req.params.id,
        update,
        { returnDocument: 'after', runValidators: true }
    );

    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

    logger.info(`Employee updated: ${employee.name} by user ${req.user._id}`);
    res.json({ success: true, data: employee });
};

// DELETE /api/salary/employees/:id  (soft-delete)
export const deactivateEmployee = async (req, res) => {
    const employee = await Employee.findByIdAndUpdate(req.params.id, { isActive: false }, { returnDocument: 'after' });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    res.json({ success: true, message: 'Employee deactivated.' });
};

// ─── SALARY PAYMENTS ─────────────────────────────────────────────────────────

const escapeSearchRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const employeeIdsForSearch = async (search) => {
    const text = String(search || '').trim();
    if (!text) return [];
    const regex = new RegExp(escapeSearchRegex(text), 'i');
    const employees = await Employee.find({
        $or: [{ name: regex }, { cnic: regex }, { designation: regex }],
    }).select('_id').lean();
    return employees.map((employee) => employee._id);
};

const applyDateRange = (filter, field, from, to, timezone) => {
    if (!from && !to) return;
    const range = {};
    // Date inputs are outlet calendar days, not UTC calendar days. POS salary
    // advances are stored at the UTC instant of outlet midnight, so UTC-based
    // boundaries can place a visibly matching record on the previous UTC date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) {
        range.$gte = startOfLocalDayUtc(from, timezone);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
        range.$lte = endOfLocalDayUtc(to, timezone);
    }
    if (Object.keys(range).length) filter[field] = range;
};

const applyAmountRange = (filter, field, minAmount, maxAmount) => {
    const range = {};
    if (minAmount !== undefined && minAmount !== '') {
        const min = Number(minAmount);
        if (Number.isFinite(min) && min >= 0) range.$gte = min;
    }
    if (maxAmount !== undefined && maxAmount !== '') {
        const max = Number(maxAmount);
        if (Number.isFinite(max) && max >= 0) range.$lte = max;
    }
    if (Object.keys(range).length) filter[field] = range;
};

// GET /api/salary/payments
export const listSalaryPayments = async (req, res) => {
    const {
        employeeId, period, paymentMode, status, search,
        dateFrom, dateTo, minAmount, maxAmount, sort = 'newest',
    } = req.query;
    const filter = {};
    if (employeeId && mongoose.isValidObjectId(employeeId)) filter.employee = employeeId;
    if (period) filter.period = period;
    if (['cash', 'bank_transfer', 'cheque'].includes(paymentMode)) filter.paymentMode = paymentMode;
    if (status === 'paid') filter.voidedAt = { $exists: false };
    if (status === 'voided') filter.voidedAt = { $exists: true };
    const timezone = (dateFrom || dateTo) ? await resolveTimezone(req.query.outlet) : undefined;
    applyDateRange(filter, 'paymentDate', dateFrom, dateTo, timezone);
    applyAmountRange(filter, 'netAmount', minAmount, maxAmount);

    const searchText = String(search || '').trim();
    if (searchText) {
        const regex = new RegExp(escapeSearchRegex(searchText), 'i');
        const employeeIds = await employeeIdsForSearch(searchText);
        filter.$or = [
            { employee: { $in: employeeIds } },
            { transactionRef: regex },
            { notes: regex },
            { period: regex },
        ];
    }

    const sortBy = {
        oldest: { paymentDate: 1 },
        amountHigh: { netAmount: -1, paymentDate: -1 },
        amountLow: { netAmount: 1, paymentDate: -1 },
    }[sort] || { paymentDate: -1 };

    const payments = await SalaryPayment.find(filter)
        .populate('employee', 'name cnic designation')
        .populate('createdBy', 'name')
        .sort(sortBy)
        .lean();

    res.json({ success: true, data: payments });
};

const journalSnapshot = (entry) => ({
    date: entry.date,
    description: entry.description,
    lines: entry.lines.map((line) => ({
        account: line.account,
        debit: line.debit,
        credit: line.credit,
        notes: line.notes,
    })),
});

const restoreJournalSnapshot = async (entryId, snapshot) => {
    const entry = await JournalEntry.findById(entryId);
    if (!entry) return;
    entry.date = snapshot.date;
    entry.description = snapshot.description;
    entry.lines = snapshot.lines;
    await entry.save();
};

const ensureJournalCanBeCorrected = (entry) => {
    if (entry?.reversedBy) {
        const error = new Error(`Journal ${entry.entryNumber || entry._id} has already been reversed and cannot be edited.`);
        error.statusCode = 409;
        throw error;
    }
};

const updateSalaryJournalsInPlace = async (payment, employeeName, timezone, rollback, createdBy, originalPeriod) => {
    if (!payment.accrualEntryId && !payment.settlementEntryId && !payment.journalEntryId) {
        throw Object.assign(new Error('The salary journal entries were not found.'), { statusCode: 409 });
    }
    const accounts = await ChartOfAccounts.find({ code: { $in: ['6003', '2100', '1102', '1101', '1001'] } })
        .select('code').lean();
    const byCode = Object.fromEntries(accounts.map((account) => [account.code, account._id]));
    const gross = round2(payment.grossAmount);
    const penalty = round2(payment.penaltyDeducted || 0);
    const accrued = round2(gross - penalty);
    const net = round2(payment.netAmount);
    const advance = round2(payment.advanceDeducted || 0);
    const allowanceExcess = round2(payment.allowanceExcessDeducted || 0);
    const needsAccrual = salaryAccrualEntryIds(payment).length > 0
        || salaryAccrualAllocations(payment).length > 1;
    const isLegacy = !payment.settlementEntryId && !needsAccrual;
    const requiredCodes = isLegacy ? ['6003', '1001'] : ['6003', '2100', '1001'];
    if (advance > 0) requiredCodes.push('1102');
    if (allowanceExcess > 0) requiredCodes.push('1101');
    const missingCode = requiredCodes.find((code) => !byCode[code]);
    if (missingCode) {
        throw Object.assign(new Error(`System account ${missingCode} was not found.`), { statusCode: 409 });
    }

    if (needsAccrual) {
        await syncSalaryAccruals({ payment, employeeName, timezone, createdBy, rollback, originalPeriod });
    }

    const settlementId = payment.settlementEntryId || payment.journalEntryId;
    if (settlementId) {
        const entry = await JournalEntry.findById(settlementId);
        if (!entry) throw Object.assign(new Error('Salary settlement journal entry was not found.'), { statusCode: 409 });
        ensureJournalCanBeCorrected(entry);
        const before = journalSnapshot(entry);
        entry.date = payment.paymentDate;
        entry.lines = [{
            account: byCode[isLegacy ? '6003' : '2100'],
            debit: accrued,
            credit: 0,
            notes: isLegacy ? `Payroll Expense — ${employeeName}` : `Accrual cleared — ${employeeName}`,
        }];
        if (advance > 0) {
            entry.lines.push({ account: byCode['1102'], debit: 0, credit: advance, notes: `Advance recovered — ${employeeName}` });
        }
        if (allowanceExcess > 0) {
            entry.lines.push({ account: byCode['1101'], debit: 0, credit: allowanceExcess, notes: `Allowance excess recovered — ${employeeName}` });
        }
        entry.lines.push({ account: byCode['1001'], debit: 0, credit: net, notes: `Cash/Bank paid — ${employeeName}` });
        entry.description = `${isLegacy ? 'Salary paid' : 'Salary settled'} — ${employeeName} (${payment.period})`;
        await entry.save();
        rollback.push(() => restoreJournalSnapshot(entry._id, before));
        if (!isLegacy) payment.settlementEntryId = entry._id;
    }
};

const advanceRecoverySnapshot = (advance) => ({
    recoveredAmount: advance.recoveredAmount,
    status: advance.status,
});

const restoreAdvanceRecovery = async (advanceId, snapshot) => {
    const advance = await SalaryAdvance.findById(advanceId);
    if (!advance) return;
    advance.recoveredAmount = snapshot.recoveredAmount;
    advance.status = snapshot.status;
    await advance.save();
};

const allowanceRecoverySnapshot = (record) => ({
    excessRecoveredAmount: record.excessRecoveredAmount || 0,
    excessSettled: record.excessSettled,
    settlementStatus: record.settlementStatus,
    excessSettledAt: record.excessSettledAt,
    excessSettledBy: record.excessSettledBy,
    settlementJournalEntryId: record.settlementJournalEntryId,
});

const restoreAllowanceRecovery = async (allowanceId, snapshot) => {
    const record = await StaffAllowance.findById(allowanceId);
    if (!record) return;
    Object.assign(record, snapshot);
    await record.save();
};

// Remove this payrun's existing allocations before calculating its corrected
// FIFO allocations. This changes the same advance/allowance documents and is
// fully compensated if any later step fails.
const unapplySalaryRecoveries = async (payment, rollback) => {
    for (const detail of payment.recoveryDetails || []) {
        const advance = await SalaryAdvance.findById(detail.advance);
        if (!advance) {
            throw Object.assign(new Error('An advance recovery linked to this salary was not found.'), { statusCode: 409 });
        }
        const before = advanceRecoverySnapshot(advance);
        advance.recoveredAmount = round2(Math.max(0, Number(advance.recoveredAmount || 0) - Number(detail.amount || 0)));
        advance.status = advance.recoveredAmount <= 0
            ? 'pending'
            : advance.recoveredAmount >= advance.amount
                ? 'recovered'
                : 'partially_recovered';
        await advance.save();
        rollback.push(() => restoreAdvanceRecovery(advance._id, before));
    }

    for (const detail of payment.allowanceRecoveryDetails || []) {
        const record = await StaffAllowance.findById(detail.allowance);
        if (!record) {
            throw Object.assign(new Error('An allowance recovery linked to this salary was not found.'), { statusCode: 409 });
        }
        const before = allowanceRecoverySnapshot(record);
        record.excessRecoveredAmount = round2(Math.max(
            0,
            Number(record.excessRecoveredAmount || 0) - Number(detail.amount || 0),
        ));
        if (detail.settledNow) {
            record.excessSettled = false;
            record.settlementStatus = 'none';
            record.excessSettledAt = undefined;
            record.excessSettledBy = undefined;
            record.settlementJournalEntryId = undefined;
        }
        await record.save();
        rollback.push(() => restoreAllowanceRecovery(record._id, before));
    }
};

const planAdvanceRecovery = async (employeeId, amount, cutoff) => {
    if (amount <= 0) return [];
    const advances = await SalaryAdvance.find({
        employee: employeeId,
        status: { $in: ['pending', 'partially_recovered'] },
        voidedAt: null,
        advanceDate: { $lte: cutoff },
    }).sort({ advanceDate: 1, createdAt: 1 });
    const outstanding = round2(advances.reduce(
        (sum, advance) => sum + Math.max(0, Number(advance.amount || 0) - Number(advance.recoveredAmount || 0)),
        0,
    ));
    if (amount > outstanding) {
        throw Object.assign(
            new Error(`Advance deducted (${amount}) exceeds outstanding advance balance (${outstanding}).`),
            { statusCode: 400 },
        );
    }

    const plan = [];
    let remaining = amount;
    for (const advance of advances) {
        if (remaining <= 0) break;
        const available = round2(Math.max(0, advance.amount - advance.recoveredAmount));
        if (available <= 0) continue;
        const applied = round2(Math.min(available, remaining));
        plan.push({ advance, applied });
        remaining = round2(remaining - applied);
    }
    return plan;
};

const planAllowanceRecovery = async (employeeId, amount) => {
    if (amount <= 0) return [];
    const records = await StaffAllowance.find({
        user: employeeId,
        subjectType: 'employee',
        excessAmount: { $gt: 0 },
        excessSettled: { $ne: true },
    }).sort({ period: 1 });
    const outstanding = round2(records.reduce(
        (sum, record) => sum + Math.max(0, Number(record.excessAmount || 0) - Number(record.excessRecoveredAmount || 0)),
        0,
    ));
    if (amount > outstanding) {
        throw Object.assign(
            new Error(`Allowance excess deducted (${amount}) exceeds outstanding allowance excess (${outstanding}).`),
            { statusCode: 400 },
        );
    }

    const plan = [];
    let remaining = amount;
    for (const record of records) {
        if (remaining <= 0) break;
        const available = round2(Math.max(0, record.excessAmount - (record.excessRecoveredAmount || 0)));
        if (available <= 0) continue;
        const applied = round2(Math.min(available, remaining));
        const settledNow = round2((record.excessRecoveredAmount || 0) + applied) >= round2(record.excessAmount) - 0.001;
        plan.push({ record, applied, settledNow });
        remaining = round2(remaining - applied);
    }
    return plan;
};

const applySalaryRecoveries = async (advancePlan, allowancePlan, settlementEntryId, userId, rollback) => {
    for (const item of advancePlan) {
        const before = advanceRecoverySnapshot(item.advance);
        item.advance.recoveredAmount = round2(item.advance.recoveredAmount + item.applied);
        item.advance.status = item.advance.recoveredAmount >= item.advance.amount
            ? 'recovered'
            : 'partially_recovered';
        await item.advance.save();
        rollback.push(() => restoreAdvanceRecovery(item.advance._id, before));
    }

    for (const item of allowancePlan) {
        const before = allowanceRecoverySnapshot(item.record);
        item.record.excessRecoveredAmount = round2((item.record.excessRecoveredAmount || 0) + item.applied);
        if (item.settledNow) {
            item.record.excessSettled = true;
            item.record.settlementStatus = 'settled';
            item.record.excessSettledAt = new Date();
            item.record.excessSettledBy = userId;
            item.record.settlementJournalEntryId = settlementEntryId;
        }
        await item.record.save();
        rollback.push(() => restoreAllowanceRecovery(item.record._id, before));
    }
};

const salaryPaymentAuditSnapshot = (payment) => ({
    employee: payment.employee,
    period: payment.period,
    grossAmount: payment.grossAmount,
    attendanceCalculation: payment.attendanceCalculation,
    advanceDeducted: payment.advanceDeducted,
    allowanceExcessDeducted: payment.allowanceExcessDeducted,
    penaltyDeducted: payment.penaltyDeducted,
    netAmount: payment.netAmount,
    paymentDate: payment.paymentDate,
    paymentMode: payment.paymentMode,
    transactionRef: payment.transactionRef,
    notes: payment.notes,
    accrualEntries: payment.accrualEntries,
});

// PATCH /api/salary/payments/:id — owner-only correction. Existing journal
// entries are edited in place; new earned months get their own accrual only.
export const updateSalaryPayment = async (req, res) => {
    const { reason } = req.body;
    if (!reason || String(reason).trim().length < 5) {
        return res.status(400).json({ success: false, message: 'Enter a correction reason of at least 5 characters.' });
    }

    const payment = await SalaryPayment.findById(req.params.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Salary payment not found.' });
    if (payment.voidedAt) return res.status(409).json({ success: false, message: 'A voided salary payment cannot be edited.' });

    const employeeId = req.body.employeeId ?? payment.employee;
    const period = req.body.period ?? payment.period;
    const rawGross = req.body.grossAmount ?? payment.grossAmount;
    const advance = round2(req.body.advanceDeducted ?? payment.advanceDeducted ?? 0);
    const allowanceExcess = round2(req.body.allowanceExcessDeducted ?? payment.allowanceExcessDeducted ?? 0);
    const penalty = round2(req.body.penaltyDeducted ?? payment.penaltyDeducted ?? 0);
    const paymentMode = req.body.paymentMode ?? payment.paymentMode;
    const transactionRef = req.body.transactionRef ?? payment.transactionRef;
    const notes = req.body.notes ?? payment.notes;
    if (!mongoose.isValidObjectId(employeeId)) return res.status(400).json({ success: false, message: 'Select a valid employee.' });
    if (!/^\d{4}-\d{2}$/.test(String(period || ''))) {
        return res.status(400).json({ success: false, message: 'Select a valid salary period.' });
    }
    if (!['cash', 'bank_transfer', 'cheque'].includes(paymentMode)) {
        return res.status(400).json({ success: false, message: 'Select a valid payment mode.' });
    }
    if (![advance, allowanceExcess, penalty].every(Number.isFinite)
        || advance < 0 || allowanceExcess < 0 || penalty < 0) {
        return res.status(400).json({ success: false, message: 'Deductions and penalties must be valid non-negative amounts.' });
    }

    const employee = await Employee.findOne({ _id: employeeId, isActive: true });
    if (!employee) return res.status(404).json({ success: false, message: 'Active employee not found.' });

    const timezone = await resolveTimezone(employee.outlet);
    let paymentTiming;
    try {
        paymentTiming = salaryPaymentDateContext(req.body.paymentDate ?? payment.paymentDate, timezone);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    let attendanceResult;
    try {
        // Older correction clients only submitted a replacement gross amount.
        // Preserve the existing attendance snapshot for those requests; the new
        // full edit form submits a fresh, fully validated calculation.
        attendanceResult = Object.prototype.hasOwnProperty.call(req.body, 'attendanceCalculation')
            ? calculateAttendanceAdjustedSalary({
                period,
                grossAmount: rawGross,
                rawAttendanceCalculation: req.body.attendanceCalculation,
                employee,
            })
            : { gross: round2(rawGross), attendanceCalculation: payment.attendanceCalculation };
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
    const { gross, attendanceCalculation } = attendanceResult;
    if (!Number.isFinite(gross) || gross < 1) {
        return res.status(400).json({ success: false, message: 'Gross salary amount must be at least 1.' });
    }
    const net = round2(gross - advance - allowanceExcess - penalty);
    if (net < 0) {
        return res.status(400).json({ success: false, message: 'Deductions and penalties cannot exceed gross salary.' });
    }

    const duplicate = await SalaryPayment.exists({
        _id: { $ne: payment._id }, employee: employee._id, period, voidedAt: null,
    });
    if (duplicate) return res.status(409).json({ success: false, message: `Salary for ${period} already exists for this employee.` });

    const employeeChanged = String(payment.employee) !== String(employee._id);
    const advanceChanged = Math.abs(Number(payment.advanceDeducted || 0) - advance) >= 0.001;
    const allowanceChanged = Math.abs(Number(payment.allowanceExcessDeducted || 0) - allowanceExcess) >= 0.001;
    const paymentDateChanged = new Date(payment.paymentDate).getTime() !== paymentTiming.paymentDate.getTime();
    const recoveriesNeedReallocation = employeeChanged
        || advanceChanged
        || allowanceChanged
        || (advance > 0 && paymentDateChanged);
    if (recoveriesNeedReallocation
        && Number(payment.advanceDeducted || 0) > 0
        && (payment.recoveryDetails?.length || 0) === 0) {
        return res.status(409).json({
            success: false,
            message: 'This legacy salary does not contain advance allocation details. Its employee, payment date, or automatic deductions cannot be changed safely.',
        });
    }
    if (recoveriesNeedReallocation
        && Number(payment.allowanceExcessDeducted || 0) > 0
        && (payment.allowanceRecoveryDetails?.length || 0) === 0) {
        return res.status(409).json({
            success: false,
            message: 'This legacy salary does not contain allowance allocation details. Its employee or automatic deductions cannot be changed safely.',
        });
    }

    const beforePayment = payment.toObject();
    const rollback = [];
    try {
        let advancePlan = null;
        let allowancePlan = null;
        if (recoveriesNeedReallocation) {
            await unapplySalaryRecoveries(payment, rollback);
            advancePlan = await planAdvanceRecovery(employee._id, advance, paymentTiming.advanceCutoff);
            allowancePlan = await planAllowanceRecovery(employee._id, allowanceExcess);
        }

        payment.employee = employee._id;
        payment.period = period;
        payment.grossAmount = gross;
        payment.attendanceCalculation = attendanceCalculation;
        payment.advanceDeducted = advance;
        payment.allowanceExcessDeducted = allowanceExcess;
        payment.penaltyDeducted = penalty;
        payment.netAmount = net;
        payment.paymentDate = paymentTiming.paymentDate;
        payment.paymentMode = paymentMode;
        payment.transactionRef = transactionRef ? String(transactionRef).trim() : undefined;
        payment.notes = notes ? String(notes).trim() : undefined;
        if (recoveriesNeedReallocation) {
            payment.recoveryDetails = advancePlan.map((item) => ({ advance: item.advance._id, amount: item.applied }));
            payment.allowanceRecoveryDetails = allowancePlan.map((item) => ({
                allowance: item.record._id,
                amount: item.applied,
                settledNow: item.settledNow,
            }));
        }

        await updateSalaryJournalsInPlace(payment, employee.name, timezone, rollback, req.user.id, beforePayment.period);
        if (recoveriesNeedReallocation) {
            await applySalaryRecoveries(
                advancePlan,
                allowancePlan,
                payment.settlementEntryId || payment.journalEntryId,
                req.user.id,
                rollback,
            );
        }
        await payment.save();
        rollback.push(async () => { await SalaryPayment.replaceOne({ _id: payment._id }, beforePayment); });

        await AuditLog.create({
            user: req.user.id, actorName: req.user.name, actorRole: req.user.role,
            action: 'salary_payment_corrected', module: 'salaries', recordId: payment._id,
            before: salaryPaymentAuditSnapshot(beforePayment),
            after: {
                ...salaryPaymentAuditSnapshot(payment),
                employeeName: employee.name,
                reason: String(reason).trim(),
                journalsUpdatedInPlace: true,
            },
            ip: req.ip,
        });
        logger.info(`Salary payment corrected in place: ${payment._id} by owner ${req.user.email}`);
        return res.json({ success: true, data: await payment.populate('employee', 'name cnic designation') });
    } catch (error) {
        await runRollback(rollback, error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to edit salary payment.' });
    }
};

// POST /api/salary/payments
export const paySalary = async (req, res) => {
    const {
        employeeId,
        period,
        grossAmount,
        attendanceCalculation: rawAttendanceCalculation,
        advanceDeducted = 0,
        allowanceExcessDeducted = 0,
        penaltyDeducted = 0,
        paymentDate,
        paymentMode,
        transactionRef,
        notes,
    } = req.body;

    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const tz = await resolveTimezone(employee.outlet);
    let paymentTiming;
    try {
        paymentTiming = salaryPaymentDateContext(paymentDate, tz);
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    // Prevent duplicate active payment for the same period (voided ones don't block).
    const existing = await SalaryPayment.findOne({ employee: employeeId, period, voidedAt: null });
    if (existing) {
        return res.status(409).json({ success: false, message: `Salary for ${period} has already been paid for this employee.` });
    }

    let attendanceResult;
    try {
        attendanceResult = calculateAttendanceAdjustedSalary({
            period,
            grossAmount,
            rawAttendanceCalculation,
            employee,
        });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }
    const { gross, attendanceCalculation } = attendanceResult;

    const advance = round2(advanceDeducted);
    const allowanceExcess = round2(allowanceExcessDeducted);
    const penalty = round2(penaltyDeducted);
    const net = round2(gross - advance - allowanceExcess - penalty);

    if (![advance, allowanceExcess, penalty].every(Number.isFinite)
        || advance < 0 || allowanceExcess < 0 || penalty < 0) {
        return res.status(400).json({ success: false, message: 'Deductions and penalties must be valid non-negative amounts.' });
    }
    if (net < 0) {
        return res.status(400).json({ success: false, message: 'Deductions and penalties cannot exceed gross salary.' });
    }

    // Verify outstanding advance balance and pre-allocate the FIFO recovery
    // plan BEFORE writing anything. This way the JE will only post what we
    // can actually recover, and we know exactly which advances to roll back
    // on failure.
    let recoveryPlan = []; // [{ advance: doc, applied: amount, before: { recoveredAmount, status } }]
    if (advance > 0) {
        const pendingAdvances = await SalaryAdvance.find({
            employee: employeeId,
            status: { $in: ['pending', 'partially_recovered'] },
            voidedAt: null,
            advanceDate: { $lte: paymentTiming.advanceCutoff },
        }).sort({ advanceDate: 1, createdAt: 1 });

        const outstanding = pendingAdvances.reduce((sum, a) => sum + (a.amount - a.recoveredAmount), 0);
        if (advance > round2(outstanding)) {
            return res.status(400).json({ success: false, message: `Advance deducted (${advance}) exceeds outstanding advance balance (${round2(outstanding)}).` });
        }

        let remaining = advance;
        for (const adv of pendingAdvances) {
            if (remaining <= 0) break;
            const available = round2(adv.amount - adv.recoveredAmount);
            if (available <= 0) continue;
            const applied = round2(Math.min(available, remaining));
            recoveryPlan.push({
                advance: adv,
                applied,
                before: { recoveredAmount: adv.recoveredAmount, status: adv.status },
            });
            remaining = round2(remaining - applied);
        }
    }

    // Pre-allocate the allowance-excess recovery plan (FIFO across the employee's
    // unsettled allowance periods, oldest first). Same shape/idea as the advance
    // plan: only what we can actually recover is posted + rolled back.
    let allowancePlan = []; // [{ record, applied, settledNow, before: {...} }]
    if (allowanceExcess > 0) {
        const excessRecords = await StaffAllowance.find({
            user: employeeId,
            subjectType: 'employee',
            excessAmount: { $gt: 0 },
            excessSettled: { $ne: true },
        }).sort({ period: 1 });

        const outstandingExcess = round2(
            excessRecords.reduce((s, r) => s + Math.max(0, round2(r.excessAmount - (r.excessRecoveredAmount || 0))), 0),
        );
        if (allowanceExcess > outstandingExcess) {
            return res.status(400).json({ success: false, message: `Allowance excess deducted (${allowanceExcess}) exceeds outstanding allowance excess (${outstandingExcess}).` });
        }

        let remaining = allowanceExcess;
        for (const rec of excessRecords) {
            if (remaining <= 0) break;
            const available = round2(rec.excessAmount - (rec.excessRecoveredAmount || 0));
            if (available <= 0) continue;
            const applied = round2(Math.min(available, remaining));
            const settledNow = round2((rec.excessRecoveredAmount || 0) + applied) >= round2(rec.excessAmount) - 0.001;
            allowancePlan.push({
                record: rec,
                applied,
                settledNow,
                before: {
                    excessRecoveredAmount: rec.excessRecoveredAmount || 0,
                    excessSettled: rec.excessSettled,
                    settlementStatus: rec.settlementStatus,
                    excessSettledAt: rec.excessSettledAt,
                    excessSettledBy: rec.excessSettledBy,
                    settlementJournalEntryId: rec.settlementJournalEntryId,
                },
            });
            remaining = round2(remaining - applied);
        }
    }

    // Validate the saved calculation's month split before writing anything.
    try {
        salaryAccrualAllocations({ period, grossAmount: gross, penaltyDeducted: penalty, attendanceCalculation });
    } catch (error) {
        return res.status(error.statusCode || 400).json({ success: false, message: error.message });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SAGA — every side-effect pushes a compensating undo. On any error we
    // run the undos in reverse and re-throw so the books stay clean.
    // ═══════════════════════════════════════════════════════════════════════
    const rollback = [];
    let payment = null;

    try {
        payment = await SalaryPayment.create({
            employee: employeeId,
            period,
            grossAmount: gross,
            attendanceCalculation,
            advanceDeducted: advance,
            allowanceExcessDeducted: allowanceExcess,
            penaltyDeducted: penalty,
            netAmount: net,
            paymentDate: paymentTiming.paymentDate,
            paymentMode,
            transactionRef,
            notes,
            recoveryDetails: recoveryPlan.map((p) => ({ advance: p.advance._id, amount: p.applied })),
            allowanceRecoveryDetails: allowancePlan.map((p) => ({ allowance: p.record._id, amount: p.applied, settledNow: p.settledNow })),
            createdBy: req.user.id,
        });
        rollback.push(async () => { try { await SalaryPayment.deleteOne({ _id: payment._id }); } catch {} });

        // Recognise each earned month's expense on that month's closing date.
        await syncSalaryAccruals({ payment, employeeName: employee.name, timezone: tz, createdBy: req.user.id, rollback });

        // Settlement JE — clears the accrual, books cash out + advance recovery.
        const settlementEntry = await postSalarySettlement(payment, employee.name, req.user.id);
        rollback.push(() => JournalEntry.deleteOne({ _id: settlementEntry._id }));

        // Apply the FIFO advance recovery plan and remember how to undo it.
        for (const item of recoveryPlan) {
            const adv = item.advance;
            adv.recoveredAmount = round2(adv.recoveredAmount + item.applied);
            adv.status = adv.recoveredAmount >= adv.amount ? 'recovered' : 'partially_recovered';
            await adv.save();
            rollback.push(async () => {
                try {
                    const fresh = await SalaryAdvance.findById(adv._id);
                    if (!fresh) return;
                    fresh.recoveredAmount = item.before.recoveredAmount;
                    fresh.status = item.before.status;
                    await fresh.save();
                } catch {}
            });
        }

        // Apply the allowance-excess recovery plan and remember how to undo it.
        for (const item of allowancePlan) {
            const rec = item.record;
            rec.excessRecoveredAmount = round2((rec.excessRecoveredAmount || 0) + item.applied);
            if (item.settledNow) {
                rec.excessSettled = true;
                rec.settlementStatus = 'settled';
                rec.excessSettledAt = new Date();
                rec.excessSettledBy = req.user.id;
                rec.settlementJournalEntryId = settlementEntry._id;
            }
            await rec.save();
            rollback.push(async () => {
                try {
                    const fresh = await StaffAllowance.findById(rec._id);
                    if (!fresh) return;
                    fresh.excessRecoveredAmount = item.before.excessRecoveredAmount;
                    fresh.excessSettled = item.before.excessSettled;
                    fresh.settlementStatus = item.before.settlementStatus;
                    fresh.excessSettledAt = item.before.excessSettledAt;
                    fresh.excessSettledBy = item.before.excessSettledBy;
                    fresh.settlementJournalEntryId = item.before.settlementJournalEntryId;
                    await fresh.save();
                } catch {}
            });
        }

        // Persist final JE references on the payment.
        payment.settlementEntryId = settlementEntry._id;
        payment.journalEntryId = settlementEntry._id; // backwards-compat
        await payment.save();

        logger.info(`Salary paid: ${employee.name} | period: ${period} | gross: ${gross} | net: ${net}`);
        return res.status(201).json({ success: true, data: await payment.populate('employee', 'name cnic designation') });
    } catch (err) {
        await runRollback(rollback, err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to record salary payment.' });
    }
};

// POST /api/salary/payments/:id/void
// Reverses both journal entries (accrual + settlement) and restores the
// SalaryAdvance recoveredAmount/status to their pre-payment values.
export const voidSalaryPayment = async (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'A void reason is required.' });
    }

    const payment = await SalaryPayment.findById(req.params.id).populate('employee', 'name');
    if (!payment) return res.status(404).json({ success: false, message: 'Salary payment not found.' });
    if (payment.voidedAt) return res.status(409).json({ success: false, message: 'This payment has already been voided.' });

    const rollback = [];
    try {
        // Reverse JEs (settlement first, then accrual — though order doesn't
        // affect the math, it reads naturally in the GL).
        if (payment.settlementEntryId) {
            const reversal = await reverseJournalEntry(payment.settlementEntryId, req.user.id);
            rollback.push(async () => { try { await JournalEntry.deleteOne({ _id: reversal._id }); } catch {} });
        }
        for (const accrualEntryId of salaryAccrualEntryIds(payment)) {
            const reversal = await reverseJournalEntry(accrualEntryId, req.user.id);
            rollback.push(async () => { try { await JournalEntry.deleteOne({ _id: reversal._id }); } catch {} });
        }

        // Restore each touched advance.
        for (const item of payment.recoveryDetails || []) {
            const adv = await SalaryAdvance.findById(item.advance);
            if (!adv) continue;
            const before = { recoveredAmount: adv.recoveredAmount, status: adv.status };
            adv.recoveredAmount = round2(Math.max(0, adv.recoveredAmount - item.amount));
            adv.status = adv.recoveredAmount === 0
                ? 'pending'
                : adv.recoveredAmount >= adv.amount
                    ? 'recovered'
                    : 'partially_recovered';
            await adv.save();
            rollback.push(async () => {
                try {
                    const fresh = await SalaryAdvance.findById(adv._id);
                    if (!fresh) return;
                    fresh.recoveredAmount = before.recoveredAmount;
                    fresh.status = before.status;
                    await fresh.save();
                } catch {}
            });
        }

        // Restore each touched allowance record's excess recovery.
        for (const item of payment.allowanceRecoveryDetails || []) {
            const rec = await StaffAllowance.findById(item.allowance);
            if (!rec) continue;
            const before = {
                excessRecoveredAmount: rec.excessRecoveredAmount || 0,
                excessSettled: rec.excessSettled,
                settlementStatus: rec.settlementStatus,
                excessSettledAt: rec.excessSettledAt,
                excessSettledBy: rec.excessSettledBy,
                settlementJournalEntryId: rec.settlementJournalEntryId,
            };
            rec.excessRecoveredAmount = round2(Math.max(0, (rec.excessRecoveredAmount || 0) - item.amount));
            if (item.settledNow) {
                rec.excessSettled = false;
                rec.settlementStatus = 'none';
                rec.excessSettledAt = undefined;
                rec.excessSettledBy = undefined;
                rec.settlementJournalEntryId = undefined;
            }
            await rec.save();
            rollback.push(async () => {
                try {
                    const fresh = await StaffAllowance.findById(rec._id);
                    if (!fresh) return;
                    fresh.excessRecoveredAmount = before.excessRecoveredAmount;
                    fresh.excessSettled = before.excessSettled;
                    fresh.settlementStatus = before.settlementStatus;
                    fresh.excessSettledAt = before.excessSettledAt;
                    fresh.excessSettledBy = before.excessSettledBy;
                    fresh.settlementJournalEntryId = before.settlementJournalEntryId;
                    await fresh.save();
                } catch {}
            });
        }

        payment.voidedAt = new Date();
        payment.voidedBy = req.user.id;
        payment.voidReason = reason.trim();
        await payment.save();

        logger.info(`Salary payment voided: ${payment.employee?.name} | period: ${payment.period} | reason: ${payment.voidReason}`);
        return res.json({ success: true, data: payment });
    } catch (err) {
        await runRollback(rollback, err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to void salary payment.' });
    }
};

// ─── SALARY ADVANCES ─────────────────────────────────────────────────────────

const SALE_DETAIL_FIELDS = [
    'transactionNumber',
    'businessDate',
    'cashier',
    'items',
    'subtotal',
    'taxAmount',
    'effectiveTaxRate',
    'serviceChargeAmount',
    'deliveryChargeAmount',
    'discountAmount',
    'totalAmount',
    'paymentMethod',
    'status',
    'orderType',
    'tableNumber',
    'notes',
    'createdAt',
].join(' ');

// GET /api/salary/advances
export const listAdvances = async (req, res) => {
    const {
        employeeId, status, type, paymentMode, overrideUsed, search,
        dateFrom, dateTo, minAmount, maxAmount, sort = 'newest',
    } = req.query;
    const filter = {};
    if (employeeId && mongoose.isValidObjectId(employeeId)) filter.employee = employeeId;
    if (['pending', 'partially_recovered', 'recovered', 'voided'].includes(status)) filter.status = status;
    if (['cash', 'cts'].includes(type)) filter.type = type;
    if (['cash', 'bank_transfer', 'cheque'].includes(paymentMode)) filter.paymentMode = paymentMode;
    if (overrideUsed === 'true') filter['creditPolicySnapshot.overrideUsed'] = true;
    if (overrideUsed === 'false') filter['creditPolicySnapshot.overrideUsed'] = { $ne: true };
    const timezone = (dateFrom || dateTo) ? await resolveTimezone(req.query.outlet) : undefined;
    applyDateRange(filter, 'advanceDate', dateFrom, dateTo, timezone);
    applyAmountRange(filter, 'amount', minAmount, maxAmount);

    const searchText = String(search || '').trim();
    if (searchText) {
        const regex = new RegExp(escapeSearchRegex(searchText), 'i');
        const employeeIds = await employeeIdsForSearch(searchText);
        filter.$or = [
            { employee: { $in: employeeIds } },
            { transactionRef: regex },
            { notes: regex },
            { voidReason: regex },
            { 'creditPolicySnapshot.overrideReason': regex },
        ];
    }

    const sortBy = {
        oldest: { advanceDate: 1 },
        amountHigh: { amount: -1, advanceDate: -1 },
        amountLow: { amount: 1, advanceDate: -1 },
    }[sort] || { advanceDate: -1 };

    const advances = await SalaryAdvance.find(filter)
        .populate('employee', 'name cnic designation')
        .populate('createdBy', 'name')
        .populate('revenueAccount', 'code name')
        .populate('creditPolicySnapshot.overriddenBy', 'name email role')
        .populate({
            path: 'saleTransaction',
            select: SALE_DETAIL_FIELDS,
            populate: { path: 'cashier', select: 'name email' },
        })
        .sort(sortBy)
        .lean();

    // Older POS charge-to-salary rows predate the explicit saleTransaction
    // link, but their transactionRef still contains the immutable POS number.
    // Resolve those records for the detail drawer without mutating history.
    const legacyRefs = advances
        .filter((advance) => advance.type === 'cts' && !advance.saleTransaction && advance.transactionRef)
        .map((advance) => advance.transactionRef);

    if (legacyRefs.length > 0) {
        const legacySales = await SaleTransaction.find({
            transactionNumber: { $in: legacyRefs },
            paymentMethod: 'charge-to-salary',
        })
            .select(SALE_DETAIL_FIELDS)
            .populate('cashier', 'name email')
            .lean();
        const salesByNumber = new Map(legacySales.map((sale) => [sale.transactionNumber, sale]));
        advances.forEach((advance) => {
            if (!advance.saleTransaction && advance.transactionRef) {
                advance.saleTransaction = salesByNumber.get(advance.transactionRef) || null;
            }
        });
    }

    res.json({ success: true, data: advances });
};

// GET /api/salary/advances/:id
// Exact lookup used by Journal Entries and Ledger source-detail drawers.
export const getAdvanceById = async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
        return res.status(400).json({ success: false, message: 'Invalid salary advance ID.' });
    }

    const advance = await SalaryAdvance.findById(id)
        .populate('employee', 'name cnic designation')
        .populate('createdBy', 'name')
        .populate('revenueAccount', 'code name')
        .populate('creditPolicySnapshot.overriddenBy', 'name email role')
        .populate({
            path: 'saleTransaction',
            select: SALE_DETAIL_FIELDS,
            populate: { path: 'cashier', select: 'name email' },
        })
        .lean();
    if (!advance) {
        return res.status(404).json({ success: false, message: 'Salary advance not found.' });
    }

    if (advance.type === 'cts' && !advance.saleTransaction && advance.transactionRef) {
        advance.saleTransaction = await SaleTransaction.findOne({
            transactionNumber: advance.transactionRef,
            paymentMethod: 'charge-to-salary',
        })
            .select(SALE_DETAIL_FIELDS)
            .populate('cashier', 'name email')
            .lean();
    }

    return res.json({ success: true, data: advance });
};

const updateAdvanceJournalInPlace = async (advance, employeeName, rollback) => {
    if (!advance.journalEntryId) {
        throw Object.assign(new Error('The advance journal entry was not found.'), { statusCode: 409 });
    }
    const entry = await JournalEntry.findById(advance.journalEntryId);
    if (!entry) throw Object.assign(new Error('The advance journal entry was not found.'), { statusCode: 409 });
    ensureJournalCanBeCorrected(entry);
    if (entry.salaryAdvance && advance.saleTransaction) {
        // Accounts conversions retain the order's tax/discount lines. The
        // two-line manual advance editor must not overwrite those amounts.
        const originalAdvance = await SalaryAdvance.findById(advance._id).select('amount').lean();
        if (round2(advance.amount) !== round2(originalAdvance?.amount)) {
            throw Object.assign(new Error('This charge retains the original order totals. Correct the POS order to change its amount.'), { statusCode: 409 });
        }
        const before = journalSnapshot(entry);
        const receivable = await ChartOfAccounts.findOne({ code: '1102' }).lean();
        for (const line of entry.lines) {
            if (String(line.account) === String(receivable?._id)) line.notes = `Charged to salary — ${employeeName} — ${advance.transactionRef}`;
        }
        entry.description = `POS sale charged to salary — ${advance.transactionRef} — ${employeeName}`;
        await entry.save();
        rollback.push(() => restoreJournalSnapshot(entry._id, before));
        return;
    }
    const debitLine = entry.lines.find((line) => Number(line.debit || 0) > 0);
    const creditLine = entry.lines.find((line) => Number(line.credit || 0) > 0);
    if (!debitLine || !creditLine) {
        throw Object.assign(new Error('The advance journal does not have the expected debit and credit lines.'), { statusCode: 409 });
    }
    const before = journalSnapshot(entry);
    const amount = round2(advance.amount);
    debitLine.debit = amount;
    debitLine.credit = 0;
    creditLine.debit = 0;
    creditLine.credit = amount;
    if (advance.type === 'cts') {
        entry.description = `Charge to salary — ${employeeName}`;
        debitLine.notes = `Charged to salary — ${employeeName}`;
        creditLine.notes = `Sale charged to salary — ${employeeName}`;
    } else {
        entry.description = `Salary advance — ${employeeName}`;
        debitLine.notes = `Advance given — ${employeeName}`;
        creditLine.notes = `Cash/Bank paid — ${employeeName}`;
    }
    await entry.save();
    rollback.push(() => restoreJournalSnapshot(entry._id, before));
};

// PATCH /api/salary/advances/:id — owner-only correction without a reversal JE.
export const updateAdvance = async (req, res) => {
    const { employeeId, amount: rawAmount, reason } = req.body;
    if (!reason || String(reason).trim().length < 5) {
        return res.status(400).json({ success: false, message: 'Enter a correction reason of at least 5 characters.' });
    }
    const amount = round2(rawAmount);
    if (!(amount >= 1)) return res.status(400).json({ success: false, message: 'Advance amount must be at least 1.' });
    if (!mongoose.isValidObjectId(employeeId)) return res.status(400).json({ success: false, message: 'Select a valid employee.' });

    const advance = await SalaryAdvance.findById(req.params.id);
    if (!advance) return res.status(404).json({ success: false, message: 'Advance not found.' });
    if (advance.voidedAt || advance.status === 'voided') {
        return res.status(409).json({ success: false, message: 'A voided advance cannot be edited.' });
    }
    const employee = await Employee.findOne({ _id: employeeId, isActive: true });
    if (!employee) return res.status(404).json({ success: false, message: 'Active employee not found.' });

    const employeeChanged = String(advance.employee) !== String(employee._id);
    const amountChanged = Math.abs(Number(advance.amount) - amount) > 0.001;
    if (employeeChanged && Number(advance.recoveredAmount || 0) > 0) {
        return res.status(409).json({ success: false, message: 'The employee cannot be changed after recovery activity has started.' });
    }
    if (amount < Number(advance.recoveredAmount || 0)) {
        return res.status(400).json({ success: false, message: `Amount cannot be below the recovered amount of ${advance.recoveredAmount}.` });
    }
    const beforeAdvance = advance.toObject();
    const rollback = [];
    try {
        advance.employee = employee._id;
        advance.amount = amount;
        advance.status = amount <= Number(advance.recoveredAmount || 0) ? 'recovered'
            : Number(advance.recoveredAmount || 0) > 0 ? 'partially_recovered' : 'pending';
        await updateAdvanceJournalInPlace(advance, employee.name, rollback);

        if (advance.saleTransaction && (employeeChanged || amountChanged)) {
            const sale = await SaleTransaction.findById(advance.saleTransaction);
            if (!sale) throw Object.assign(new Error('The linked POS transaction was not found.'), { statusCode: 409 });
            const beforeSale = {
                chargeToSalaryEmployee: sale.chargeToSalaryEmployee,
                chargeToSalaryEmployeeName: sale.chargeToSalaryEmployeeName,
                totalAmount: sale.totalAmount,
                ctsCorrection: sale.ctsCorrection?.toObject?.() || sale.ctsCorrection || null,
            };
            sale.chargeToSalaryEmployee = employee._id;
            sale.chargeToSalaryEmployeeName = employee.name;
            if (amountChanged) {
                sale.totalAmount = amount;
                sale.ctsCorrection = {
                    originalAmount: beforeSale.ctsCorrection?.originalAmount ?? beforeSale.totalAmount,
                    correctedAmount: amount,
                    reason: String(reason).trim(),
                    correctedAt: new Date(),
                    correctedBy: req.user.id,
                };
            }
            await sale.save();
            rollback.push(async () => {
                const restore = {
                    chargeToSalaryEmployee: beforeSale.chargeToSalaryEmployee,
                    chargeToSalaryEmployeeName: beforeSale.chargeToSalaryEmployeeName,
                    totalAmount: beforeSale.totalAmount,
                };
                if (beforeSale.ctsCorrection) {
                    await SaleTransaction.updateOne({ _id: sale._id }, { $set: { ...restore, ctsCorrection: beforeSale.ctsCorrection } });
                } else {
                    await SaleTransaction.updateOne({ _id: sale._id }, { $set: restore, $unset: { ctsCorrection: '' } });
                }
            });
        }

        await advance.save();
        rollback.push(async () => { await SalaryAdvance.replaceOne({ _id: advance._id }, beforeAdvance); });
        await AuditLog.create({
            user: req.user.id, actorName: req.user.name, actorRole: req.user.role,
            action: 'salary_advance_corrected', module: 'salaries', recordId: advance._id,
            before: { employee: beforeAdvance.employee, amount: beforeAdvance.amount },
            after: {
                employee: employee._id, employeeName: employee.name, amount: advance.amount,
                reason: String(reason).trim(), journalsUpdatedInPlace: true,
                linkedPosTransactionUpdated: Boolean(advance.saleTransaction),
            },
            ip: req.ip,
        });
        logger.info(`Salary advance corrected in place: ${advance._id} by owner ${req.user.email}`);
        return res.json({ success: true, data: await advance.populate('employee', 'name cnic designation') });
    } catch (error) {
        await runRollback(rollback, error);
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to edit advance.' });
    }
};

// GET /api/salary/advances/:id/deletion-preview — owner-only, read-only.
export const getAdvanceDeletionPreview = async (req, res) => {
    try {
        return res.json({ success: true, data: await previewAdvanceDeletion(req.params.id) });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Could not check this advance.' });
    }
};

// DELETE /api/salary/advances/:id — remove an unrecovered advance. Converted
// POS charges restore the original payment/journal instead of deleting the sale JE.
export const deleteAdvance = async (req, res) => {
    try {
        const result = await permanentlyDeleteAdvance({
            advanceId: req.params.id,
            reason: req.body?.reason,
            expectedMode: req.body?.expectedMode,
            actor: req.user,
            ip: req.ip,
        });
        logger.info(`Advance deleted (${result.mode}): ${req.params.id} by owner ${req.user.email}`);
        return res.json({ success: true, ...result });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ success: false, message: error.message || 'Failed to delete advance.' });
    }
};

// GET /api/salary/revenue-accounts
// Revenue heads for a charge-to-salary ("where to punch the sale"). Scoped to
// salaries.manage so a salary manager can pick a head without full CoA access.
export const getRevenueAccounts = async (req, res) => {
    // Only genuine (credit-normal) revenue heads — excludes contra-revenue like
    // Discounts (debit-normal), which must never be the target of a sale.
    const accounts = await ChartOfAccounts.find({ type: 'revenue', normalBalance: 'credit', isActive: { $ne: false } })
        .select('code name')
        .sort({ code: 1 })
        .lean();
    res.json({ success: true, data: accounts });
};

// POST /api/salary/advances
// Handles both a cash advance (type 'cash', CR Cash) and a charge-to-salary
// (type 'cts', CR the selected revenue head). Both create a 1102 receivable that
// is recovered from salary via the same machinery.
export const giveAdvance = async (req, res) => {
    const { employeeId, amount, advanceDate, paymentMode, transactionRef, notes, revenueAccount } = req.body;
    const type = req.body.type === 'cts' ? 'cts' : 'cash';
    const overrideRequested = req.body.creditLimitOverride?.requested === true;
    const overrideReason = req.body.creditLimitOverride?.reason || '';

    if (!(round2(amount) >= 1)) {
        return res.status(400).json({ success: false, message: 'Enter a valid amount (at least 1).' });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    if (!employee.isActive) {
        return res.status(422).json({ success: false, message: 'Credit cannot be issued to an inactive employee.' });
    }

    // Validate the branch-specific requirements up front.
    let revenue = null;
    if (type === 'cts') {
        if (!mongoose.isValidObjectId(revenueAccount)) {
            return res.status(400).json({ success: false, message: 'Select a revenue account to punch the sale to.' });
        }
        revenue = await ChartOfAccounts.findById(revenueAccount).lean();
        if (!revenue || revenue.isActive === false) {
            return res.status(400).json({ success: false, message: 'Revenue account not found or inactive.' });
        }
        if (revenue.type !== 'revenue') {
            return res.status(400).json({ success: false, message: 'Charge-to-salary must post to a revenue account.' });
        }
    } else if (!['cash', 'bank_transfer', 'cheque'].includes(paymentMode)) {
        return res.status(400).json({ success: false, message: 'Payment mode is required.' });
    }

    try {
        const result = await withEmployeeCreditLock(employee._id, async () => {
            const currentEmployee = await Employee.findById(employee._id);
            if (!currentEmployee || !currentEmployee.isActive) {
                const error = new Error('The employee is no longer active.');
                error.statusCode = 422;
                throw error;
            }
            const decision = await authorizeEmployeeCredit({
                employee: currentEmployee,
                amount: round2(amount),
                type,
                actor: req.user,
                overrideRequested,
                overrideReason,
                ownerOnlyOverride: true,
            });
            const rollback = [];
            let advance = null;
            try {
                advance = await SalaryAdvance.create({
                    employee: employeeId,
                    type,
                    revenueAccount: type === 'cts' ? revenue._id : undefined,
                    amount: round2(amount),
                    advanceDate: advanceDate ? new Date(advanceDate) : new Date(),
                    paymentMode: type === 'cts' ? undefined : paymentMode,
                    transactionRef,
                    notes,
                    creditPolicySnapshot: decision.snapshot,
                    createdBy: req.user.id,
                });
                rollback.push(async () => { try { await SalaryAdvance.deleteOne({ _id: advance._id }); } catch {} });

                const je = type === 'cts'
                    ? await postChargeToSalary(advance, currentEmployee.name, revenue._id, req.user.id)
                    : await postSalaryAdvance(advance, currentEmployee.name, req.user.id);
                rollback.push(async () => { try { await reverseJournalEntry(je._id, req.user.id); } catch {} });

                advance.journalEntryId = je._id;
                await advance.save();
                return { advance, decision, employee: currentEmployee };
            } catch (error) {
                await runRollback(rollback, error);
                throw error;
            }
        });

        if (result.decision.overrideUsed) {
            try {
                await AuditLog.create({
                    user: req.user.id,
                    actorName: req.user.name,
                    actorRole: req.user.role,
                    action: 'employee_credit_limit_overridden',
                    module: 'salaries',
                    recordId: result.advance._id,
                    after: {
                        employeeId: result.employee._id,
                        employeeName: result.employee.name,
                        type,
                        amount: result.advance.amount,
                        overriddenLimits: result.decision.overriddenLimits,
                        reason: result.decision.overrideReason,
                    },
                    ip: req.ip,
                });
            } catch (auditError) {
                logger.warn(`[salary] Failed to write employee credit override audit: ${auditError.message}`);
            }
        }

        logger.info(`Salary ${type === 'cts' ? 'charge-to-salary' : 'advance'} given: ${result.employee.name} | amount: ${result.advance.amount}`);
        return res.status(201).json({
            success: true,
            data: await result.advance.populate('employee', 'name cnic designation'),
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            code: err.code,
            message: err.message || 'Failed to record advance.',
            creditSummary: err.summary,
            reasons: err.reasons,
        });
    }
};

// POST /api/salary/advances/:id/void
// Voids an advance that hasn't been recovered yet. Reverses the original JE.
export const voidAdvance = async (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'A void reason is required.' });
    }

    const advance = await SalaryAdvance.findById(req.params.id).populate('employee', 'name');
    if (!advance) return res.status(404).json({ success: false, message: 'Advance not found.' });
    if (advance.saleTransaction && advance.journalEntryId
        && await JournalEntry.exists({ _id: advance.journalEntryId, salaryAdvance: advance._id })) {
        return res.status(409).json({ success: false, message: 'Cancel or refund the linked POS order to reverse this charge and its order totals together.' });
    }
    if (advance.voidedAt) return res.status(409).json({ success: false, message: 'This advance has already been voided.' });
    if (advance.recoveredAmount > 0) {
        return res.status(409).json({
            success: false,
            message: 'Cannot void an advance that has recovery activity. Void the related salary payments / repayments first.',
        });
    }

    const rollback = [];
    try {
        if (advance.journalEntryId) {
            const reversal = await reverseJournalEntry(advance.journalEntryId, req.user.id);
            rollback.push(async () => { try { await JournalEntry.deleteOne({ _id: reversal._id }); } catch {} });
        }

        advance.status = 'voided';
        advance.voidedAt = new Date();
        advance.voidedBy = req.user.id;
        advance.voidReason = reason.trim();
        await advance.save();

        logger.info(`Advance voided: ${advance.employee?.name} | amount: ${advance.amount} | reason: ${advance.voidReason}`);
        return res.json({ success: true, data: advance });
    } catch (err) {
        await runRollback(rollback, err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to void advance.' });
    }
};

// GET /api/salary/advances/outstanding/:employeeId
export const getOutstandingAdvance = async (req, res) => {
    const employee = await Employee.findById(req.params.employeeId);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const filter = {
        employee: req.params.employeeId,
        status: { $in: ['pending', 'partially_recovered'] },
        voidedAt: null,
    };
    if (req.query.asOf) {
        const tz = await resolveTimezone(employee.outlet);
        try {
            filter.advanceDate = { $lte: salaryPaymentDateContext(req.query.asOf, tz).advanceCutoff };
        } catch (error) {
            return res.status(error.statusCode || 400).json({ success: false, message: error.message });
        }
    }

    const advances = await SalaryAdvance.find(filter).sort({ advanceDate: 1, createdAt: 1 }).lean();

    const total = round2(advances.reduce((sum, a) => sum + (a.amount - a.recoveredAmount), 0));
    const creditSummary = await getEmployeeCreditSummary(employee);
    res.json({ success: true, data: { outstanding: total, records: advances, creditSummary } });
};

// GET /api/salary/allowance-excess/outstanding/:employeeId
// Unsettled allowance excess for an employee (across all periods) — folded into
// the salary deduction by the pay-salary form.
export const getOutstandingAllowanceExcess = async (req, res) => {
    const records = await StaffAllowance.find({
        user: req.params.employeeId,
        subjectType: 'employee',
        excessAmount: { $gt: 0 },
        excessSettled: { $ne: true },
    }).lean();

    const total = round2(records.reduce((sum, r) => sum + Math.max(0, round2(r.excessAmount - (r.excessRecoveredAmount || 0))), 0));
    res.json({ success: true, data: { outstanding: total, records } });
};

// POST /api/salary/advances/:id/repay
// Employee hands back cash (or transfers) — not deducted from salary.
export const repayAdvance = async (req, res) => {
    const { amount, repaymentDate, paymentMode, transactionRef, notes } = req.body;

    const advance = await SalaryAdvance.findById(req.params.id).populate('employee', 'name');
    if (!advance) return res.status(404).json({ success: false, message: 'Advance record not found.' });
    if (advance.voidedAt) {
        return res.status(400).json({ success: false, message: 'This advance has been voided.' });
    }
    if (advance.status === 'recovered') {
        return res.status(400).json({ success: false, message: 'This advance has already been fully recovered.' });
    }

    const outstanding = round2(advance.amount - advance.recoveredAmount);
    const repayAmt = round2(amount);

    if (repayAmt <= 0) return res.status(400).json({ success: false, message: 'Repayment amount must be greater than 0.' });
    if (repayAmt > outstanding) {
        return res.status(400).json({ success: false, message: `Repayment (${repayAmt}) exceeds outstanding balance (${outstanding}).` });
    }

    const rollback = [];
    const before = { recoveredAmount: advance.recoveredAmount, status: advance.status };
    const repaymentSubdoc = {
        amount: repayAmt,
        repaymentDate: repaymentDate ? new Date(repaymentDate) : new Date(),
        paymentMode,
        transactionRef,
        notes,
        createdBy: req.user.id,
    };

    try {
        // Apply state change first so the JE can reference the sub-doc id.
        advance.repayments.push(repaymentSubdoc);
        const newRepayment = advance.repayments[advance.repayments.length - 1];
        advance.recoveredAmount = round2(advance.recoveredAmount + repayAmt);
        advance.status = advance.recoveredAmount >= advance.amount ? 'recovered' : 'partially_recovered';
        await advance.save();
        rollback.push(async () => {
            try {
                const fresh = await SalaryAdvance.findById(advance._id);
                if (!fresh) return;
                fresh.repayments = fresh.repayments.filter((r) => String(r._id) !== String(newRepayment._id));
                fresh.recoveredAmount = before.recoveredAmount;
                fresh.status = before.status;
                await fresh.save();
            } catch {}
        });

        const je = await postAdvanceRepayment({
            advanceId: advance._id,
            amount: repayAmt,
            repaymentDate: repaymentSubdoc.repaymentDate,
            employeeName: advance.employee?.name ?? 'Unknown',
            createdBy: req.user.id,
        });
        rollback.push(async () => { try { await reverseJournalEntry(je._id, req.user.id); } catch {} });

        // Stamp the JE id onto the sub-doc so the void endpoint can find it.
        const fresh = await SalaryAdvance.findById(advance._id);
        const sub = fresh.repayments.id(newRepayment._id);
        if (sub) {
            sub.journalEntryId = je._id;
            await fresh.save();
        }

        logger.info(`Advance repayment: ${advance.employee?.name} | advance ${advance._id} | repaid: ${repayAmt} | status: ${fresh.status}`);
        return res.json({ success: true, data: fresh });
    } catch (err) {
        await runRollback(rollback, err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to record repayment.' });
    }
};

// POST /api/salary/advances/:advanceId/repayments/:repaymentId/void
// Voids one direct repayment, reversing its JE and decreasing recoveredAmount.
export const voidRepayment = async (req, res) => {
    const { reason } = req.body;
    if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, message: 'A void reason is required.' });
    }

    const advance = await SalaryAdvance.findById(req.params.advanceId).populate('employee', 'name');
    if (!advance) return res.status(404).json({ success: false, message: 'Advance not found.' });

    const sub = advance.repayments.id(req.params.repaymentId);
    if (!sub) return res.status(404).json({ success: false, message: 'Repayment not found on this advance.' });
    if (sub.voidedAt) return res.status(409).json({ success: false, message: 'This repayment has already been voided.' });

    const rollback = [];
    const before = { recoveredAmount: advance.recoveredAmount, status: advance.status };
    try {
        if (sub.journalEntryId) {
            const reversal = await reverseJournalEntry(sub.journalEntryId, req.user.id);
            rollback.push(async () => { try { await JournalEntry.deleteOne({ _id: reversal._id }); } catch {} });
        }

        advance.recoveredAmount = round2(Math.max(0, advance.recoveredAmount - sub.amount));
        advance.status = advance.recoveredAmount === 0
            ? 'pending'
            : advance.recoveredAmount >= advance.amount
                ? 'recovered'
                : 'partially_recovered';
        sub.voidedAt = new Date();
        sub.voidedBy = req.user.id;
        sub.voidReason = reason.trim();
        await advance.save();
        rollback.push(async () => {
            try {
                const fresh = await SalaryAdvance.findById(advance._id);
                if (!fresh) return;
                fresh.recoveredAmount = before.recoveredAmount;
                fresh.status = before.status;
                const s = fresh.repayments.id(req.params.repaymentId);
                if (s) {
                    s.voidedAt = undefined;
                    s.voidedBy = undefined;
                    s.voidReason = undefined;
                }
                await fresh.save();
            } catch {}
        });

        logger.info(`Repayment voided: advance ${advance._id} | repayment ${sub._id} | amount: ${sub.amount} | reason: ${sub.voidReason}`);
        return res.json({ success: true, data: advance });
    } catch (err) {
        await runRollback(rollback, err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to void repayment.' });
    }
};
