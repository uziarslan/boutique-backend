import mongoose from 'mongoose';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import StaffAllowance from '../models/StaffAllowance.js';
import { postAllowanceSettlement } from '../accounting/journalEngine.js';
import logger from '../utils/logger.js';

const round2 = (n) => parseFloat(n.toFixed(2));

const currentPeriod = () => new Date().toISOString().slice(0, 7); // YYYY-MM

// ── Subjects ────────────────────────────────────────────────────────────────
// An allowance "subject" is whoever can be charged: every active payroll
// Employee, plus every active owner (a User with role 'owner'). The two are
// distinguished by subjectType so the same id space can never collide.
const listSubjects = async (nameQuery) => {
    const empFilter = { isActive: true };
    const userFilter = { isActive: true, role: 'owner' };
    if (nameQuery) {
        const re = { $regex: nameQuery, $options: 'i' };
        empFilter.name = re;
        userFilter.name = re;
    }
    const [employees, owners] = await Promise.all([
        Employee.find(empFilter).select('_id name designation').sort({ name: 1 }).lean(),
        User.find(userFilter).select('_id name email role').sort({ name: 1 }).lean(),
    ]);
    return [
        ...owners.map((u) => ({ subjectType: 'user', id: u._id, name: u.name || u.email, sub: 'Owner' })),
        ...employees.map((e) => ({ subjectType: 'employee', id: e._id, name: e.name, sub: e.designation || 'Employee' })),
    ];
};

// Resolve a single subject's display name; null when it doesn't exist / inactive.
const resolveSubject = async (subjectType, id) => {
    if (subjectType === 'user') {
        const u = await User.findById(id).select('name email role').lean();
        return u ? { name: u.name || u.email, sub: 'Owner' } : null;
    }
    const e = await Employee.findById(id).select('name designation').lean();
    return e ? { name: e.name, sub: e.designation || 'Employee' } : null;
};

/**
 * Get or create the current-period record for a subject.
 * Returns null when the subject has never had an allowance configured.
 */
const getOrCreatePeriodRecord = async (subjectId, period) => {
    let record = await StaffAllowance.findOne({ user: subjectId, period });
    if (record) return record;

    const prev = await StaffAllowance.findOne({ user: subjectId }).sort({ period: -1 }).lean();
    // Carry forward any ENABLED allowance — including a zero-limit one (staff can
    // still charge to their account; the whole amount becomes a receivable).
    if (!prev || prev.enabled === false) return null;

    return StaffAllowance.create({
        user: subjectId,
        subjectType: prev.subjectType || 'employee',
        subjectName: prev.subjectName,
        enabled: prev.enabled !== false,
        period,
        monthlyLimit: prev.monthlyLimit,
        usedAmount: 0,
        excessAmount: 0,
    });
};

// ─── GET /api/allowances ──────────────────────────────────────────────────────
// List every allowance subject (employees + owners) with their current-period
// allowance summary. Role: owner, financeManager
export const listAllowances = async (req, res) => {
    const period = req.query.period || currentPeriod();

    const subjects = await listSubjects();
    const ids = subjects.map((s) => s.id);
    const records = await StaffAllowance.find({ user: { $in: ids }, period }).lean();
    const byId = Object.fromEntries(records.map((r) => [r.user.toString(), r]));

    const result = subjects.map((s) => {
        const rec = byId[s.id.toString()];
        return {
            subjectType: s.subjectType,
            subjectId: s.id,
            name: s.name,
            sub: s.sub,
            period,
            monthlyLimit: rec?.monthlyLimit ?? 0,
            usedAmount: rec?.usedAmount ?? 0,
            excessAmount: rec?.excessAmount ?? 0,
            remainingAmount: rec ? Math.max(0, rec.monthlyLimit - rec.usedAmount) : 0,
            // No record yet → allowance is effectively off.
            enabled: rec ? rec.enabled !== false : false,
            excessSettled: rec?.excessSettled ?? false,
            settlementStatus: rec?.settlementStatus ?? 'none',
            allowanceId: rec?._id ?? null,
        };
    });

    res.json({ success: true, data: { period, allowances: result } });
};

// ─── GET /api/allowances/excess ───────────────────────────────────────────────
// Subjects with unsettled excess — used in AgingReport. Role: owner, financeManager
export const getExcessReport = async (req, res) => {
    const records = await StaffAllowance.find({ excessAmount: { $gt: 0 } })
        .populate('excessSettledBy', 'name')
        .populate('settlementReceiverUser', 'name email')
        .sort({ period: -1 })
        .lean();

    const result = records.map((r) => ({
        allowanceId: r._id,
        subjectType: r.subjectType,
        subjectId: r.user,
        name: r.subjectName || 'Unknown',
        period: r.period,
        monthlyLimit: r.monthlyLimit,
        usedAmount: r.usedAmount,
        excessAmount: r.excessAmount,
        excessSettled: !!r.excessSettled,
        settlementStatus: r.settlementStatus,
        excessSettledAt: r.excessSettledAt,
        excessSettledBy: r.excessSettledBy,
        settlementPaymentMode: r.settlementPaymentMode,
        settlementTransactionId: r.settlementTransactionId,
        settlementReceiverUser: r.settlementReceiverUser,
    }));

    res.json({ success: true, data: { excess: result } });
};

// ─── GET /api/allowances/user/:userId?subjectType= ────────────────────────────
// Get a specific subject's current-period allowance (used by POS + admin).
export const getUserAllowance = async (req, res) => {
    const subjectId = req.params.userId;
    const subjectType = req.query.subjectType === 'user' ? 'user' : 'employee';
    const period = req.query.period || currentPeriod();

    if (!mongoose.Types.ObjectId.isValid(subjectId)) {
        return res.status(400).json({ success: false, message: 'Invalid subject id.' });
    }

    const subject = await resolveSubject(subjectType, subjectId);
    if (!subject) return res.status(404).json({ success: false, message: 'Subject not found.' });

    const record = await getOrCreatePeriodRecord(subjectId, period);

    const base = { subjectType, subjectId, name: subject.name, period };
    if (!record || record.enabled === false) {
        return res.json({
            success: true,
            data: { ...base, monthlyLimit: 0, usedAmount: 0, excessAmount: 0, remainingAmount: 0, hasAllowance: false, enabled: record ? record.enabled !== false : false },
        });
    }

    res.json({
        success: true,
        data: {
            ...base,
            allowanceId: record._id,
            monthlyLimit: record.monthlyLimit,
            usedAmount: record.usedAmount,
            excessAmount: record.excessAmount,
            remainingAmount: Math.max(0, record.monthlyLimit - record.usedAmount),
            excessSettled: record.excessSettled,
            settlementStatus: record.settlementStatus,
            enabled: record.enabled !== false,
            // Enabled → chargeable to allowance even at a zero limit (anything
            // above the limit becomes a Staff Allowance Receivable).
            hasAllowance: true,
        },
    });
};

// ─── POST /api/allowances/user/:userId ────────────────────────────────────────
// Set a subject's monthly allowance limit and/or toggle it on/off.
// Body: { subjectType, monthlyLimit?, enabled?, notes? }. Role: owner, financeManager
export const setUserAllowanceLimit = async (req, res) => {
    const subjectId = req.params.userId;
    const { subjectType: rawType, monthlyLimit, enabled, notes } = req.body;
    const subjectType = rawType === 'user' ? 'user' : 'employee';

    if (!mongoose.Types.ObjectId.isValid(subjectId)) {
        return res.status(400).json({ success: false, message: 'Invalid subject id.' });
    }
    if (monthlyLimit !== undefined && (typeof monthlyLimit !== 'number' || monthlyLimit < 0)) {
        return res.status(400).json({ success: false, message: 'monthlyLimit must be a non-negative number.' });
    }

    const subject = await resolveSubject(subjectType, subjectId);
    if (!subject) return res.status(404).json({ success: false, message: 'Subject not found.' });

    const period = currentPeriod();

    const set = { subjectType, subjectName: subject.name };
    if (monthlyLimit !== undefined) set.monthlyLimit = round2(monthlyLimit);
    if (enabled !== undefined) set.enabled = Boolean(enabled);
    if (notes) set.notes = notes;

    const record = await StaffAllowance.findOneAndUpdate(
        { user: subjectId, period },
        {
            $set: set,
            $setOnInsert: {
                usedAmount: 0,
                excessAmount: 0,
                period,
                user: subjectId,
                // Default the limit to 0 on insert if the caller only toggled enabled.
                ...(monthlyLimit === undefined ? { monthlyLimit: 0 } : {}),
            },
        },
        { upsert: true, returnDocument: 'after', runValidators: true }
    );

    logger.info(`Allowance set: subject=${subjectType}:${subjectId} period=${period} limit=${record.monthlyLimit} enabled=${record.enabled} by ${req.user.email}`);

    res.json({
        success: true,
        message: 'Allowance updated.',
        data: {
            allowanceId: record._id,
            subjectType,
            subjectId,
            name: subject.name,
            period,
            monthlyLimit: record.monthlyLimit,
            enabled: record.enabled !== false,
            usedAmount: record.usedAmount,
            remainingAmount: Math.max(0, record.monthlyLimit - record.usedAmount),
        },
    });
};

// ─── GET /api/allowances/search?q= ────────────────────────────────────────────
// Search subjects (employees + owners) for the POS allowance picker. Returns
// ONLY subjects that have an ENABLED allowance with a positive limit for the
// current period — so the cashier never sees a profile without an allowance set.
export const searchUsersForAllowance = async (req, res) => {
    const q = (req.query.q || '').trim();
    const period = currentPeriod();

    const subjects = await listSubjects(q);
    const ids = subjects.map((s) => s.id);
    // Any ENABLED allowance is chargeable — including a zero-limit one (the whole
    // order becomes excess → Staff Allowance Receivable). Don't require a positive
    // limit, or the cashier could never punch to a zero-limit staff account.
    const records = await StaffAllowance.find({
        user: { $in: ids },
        period,
        enabled: { $ne: false },
    }).lean();
    const byId = Object.fromEntries(records.map((r) => [r.user.toString(), r]));

    const result = subjects
        .filter((s) => byId[s.id.toString()])
        .slice(0, 20)
        .map((s) => {
            const rec = byId[s.id.toString()];
            return {
                // `userId` kept for payload compatibility — it's the subject id.
                userId: s.id,
                subjectType: s.subjectType,
                subjectId: s.id,
                name: s.name,
                sub: s.sub,
                monthlyLimit: rec.monthlyLimit,
                usedAmount: rec.usedAmount,
                remainingAmount: Math.max(0, rec.monthlyLimit - rec.usedAmount),
                hasAllowance: true,
            };
        });

    res.json({ success: true, data: { users: result } });
};

// ─── POST /api/allowances/:allowanceId/settle ────────────────────────────────
// Owner settles excess directly. Body: { paymentMode, transactionId?, receiverUserId }
export const settleExcess = async (req, res) => {
    const { allowanceId } = req.params;
    const { paymentMode, transactionId, receiverUserId } = req.body;

    if (!paymentMode) {
        return res.status(400).json({ success: false, message: 'Payment mode is required.' });
    }
    if (paymentMode === 'online_transfer' && !transactionId?.trim()) {
        return res.status(400).json({ success: false, message: 'Transaction ID is required for online transfers.' });
    }
    if (!receiverUserId) {
        return res.status(400).json({ success: false, message: 'Receiver is required.' });
    }
    if (!mongoose.Types.ObjectId.isValid(receiverUserId)) {
        return res.status(400).json({ success: false, message: 'Invalid receiver id.' });
    }

    const record = await StaffAllowance.findById(allowanceId);
    if (!record) return res.status(404).json({ success: false, message: 'Allowance record not found.' });
    if (record.excessAmount <= 0) {
        return res.status(400).json({ success: false, message: 'No excess amount to settle.' });
    }
    if (record.excessSettled) {
        return res.status(400).json({ success: false, message: 'Excess already settled.' });
    }

    // A payrun may have already recovered part of this excess against 1101.
    // Only settle (and post) the remaining un-recovered portion — settling the
    // full excessAmount would double-credit 1101.
    const remaining = round2(record.excessAmount - (record.excessRecoveredAmount || 0));
    if (remaining <= 0) {
        return res.status(400).json({ success: false, message: 'Excess already recovered via payroll.' });
    }

    const journalEntry = await postAllowanceSettlement({
        allowanceId: record._id,
        amount: remaining,
        settledBy: req.user.id,
    });

    record.settlementStatus = 'settled';
    record.excessSettled = true;
    record.excessRecoveredAmount = record.excessAmount;
    record.excessSettledAt = new Date();
    record.excessSettledBy = req.user.id;
    record.settlementPaymentMode = paymentMode;
    record.settlementTransactionId = transactionId?.trim() || undefined;
    record.settlementReceiverUser = receiverUserId;
    record.settlementJournalEntryId = journalEntry._id;
    await record.save();

    logger.info(`Allowance excess settled: record=${record._id} amount=${remaining} mode=${paymentMode} by user=${req.user.id}`);

    const populated = await StaffAllowance.findById(record._id)
        .populate('excessSettledBy', 'name')
        .populate('settlementReceiverUser', 'name email')
        .lean();

    return res.json({ success: true, message: 'Settlement recorded and posted.', data: { record: populated } });
};
