import crypto from 'crypto';
import SalaryAdvance from '../models/SalaryAdvance.js';
import Employee from '../models/Employee.js';
import { localDateStr, resolveTimezone, startOfLocalDayUtc } from '../utils/timezone.js';
import { canOverrideEmployeeCreditLimits } from '../utils/employeeCreditOverride.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS = Object.freeze({
    cashAdvanceEnabled: true,
    chargeToSalaryEnabled: true,
    maxOutstandingPercent: 60,
    dailyLimitPercent: 10,
    rollingSevenDayLimitPercent: 25,
});

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const capPercent = (value, fallback, maximum = 60) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(0, parsed));
};

export class EmployeeCreditLimitError extends Error {
    constructor(message, summary, reasons = []) {
        super(message);
        this.name = 'EmployeeCreditLimitError';
        this.statusCode = 422;
        this.code = 'EMPLOYEE_CREDIT_LIMIT';
        this.summary = summary;
        this.reasons = reasons;
    }
}

export const normalizedEmployeeCreditLimits = (employee) => {
    const raw = employee?.salaryCreditLimits || {};
    const maxOutstandingPercent = capPercent(
        raw.maxOutstandingPercent,
        DEFAULT_LIMITS.maxOutstandingPercent
    );
    const dailyLimitPercent = Math.min(
        maxOutstandingPercent,
        capPercent(raw.dailyLimitPercent, DEFAULT_LIMITS.dailyLimitPercent)
    );
    const rollingSevenDayLimitPercent = Math.min(
        maxOutstandingPercent,
        Math.max(
            dailyLimitPercent,
            capPercent(raw.rollingSevenDayLimitPercent, DEFAULT_LIMITS.rollingSevenDayLimitPercent)
        )
    );
    return {
        cashAdvanceEnabled: raw.cashAdvanceEnabled !== false,
        chargeToSalaryEnabled: raw.chargeToSalaryEnabled !== false,
        maxOutstandingPercent,
        dailyLimitPercent,
        rollingSevenDayLimitPercent,
    };
};

const salaryCycleBounds = (now, salaryDay, timezone) => {
    const [year, month, day] = localDateStr(now, timezone).split('-').map(Number);
    const safeSalaryDay = Math.min(28, Math.max(1, Number(salaryDay) || 1));
    const cycleMonth = day >= safeSalaryDay ? month - 1 : month - 2;
    const cycleStartUtcParts = new Date(Date.UTC(year, cycleMonth, safeSalaryDay));
    const nextCycleUtcParts = new Date(Date.UTC(
        cycleStartUtcParts.getUTCFullYear(),
        cycleStartUtcParts.getUTCMonth() + 1,
        safeSalaryDay
    ));
    const toDateString = (date) => [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
    return {
        start: startOfLocalDayUtc(toDateString(cycleStartUtcParts), timezone),
        end: startOfLocalDayUtc(toDateString(nextCycleUtcParts), timezone),
    };
};

const sumIssued = async (employeeId, createdAt) => {
    const result = await SalaryAdvance.aggregate([
        {
            $match: {
                employee: employeeId,
                status: { $ne: 'voided' },
                createdAt,
            },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return round2(result[0]?.total || 0);
};

const sumOutstanding = async (employeeId) => {
    const result = await SalaryAdvance.aggregate([
        {
            $match: {
                employee: employeeId,
                status: { $in: ['pending', 'partially_recovered'] },
            },
        },
        {
            $group: {
                _id: null,
                total: {
                    $sum: {
                        $cond: [
                            { $gt: ['$amount', { $ifNull: ['$recoveredAmount', 0] }] },
                            { $subtract: ['$amount', { $ifNull: ['$recoveredAmount', 0] }] },
                            0,
                        ],
                    },
                },
            },
        },
    ]);
    return round2(result[0]?.total || 0);
};

export const getEmployeeCreditSummary = async (employee, options = {}) => {
    const now = options.now instanceof Date ? options.now : new Date();
    const timezone = options.timezone || await resolveTimezone(employee?.outlet);
    const limits = normalizedEmployeeCreditLimits(employee);
    const salaryBasis = round2(employee?.salary || 0);
    const todayStart = startOfLocalDayUtc(localDateStr(now, timezone), timezone);
    // Exactly 168 hours: crossing a midnight does not prematurely release usage.
    const sevenDayStart = new Date(now.getTime() - (7 * DAY_MS));
    const cycle = salaryCycleBounds(now, employee?.salaryDate, timezone);

    const [outstanding, issuedToday, issuedSevenDays, issuedCycle] = await Promise.all([
        sumOutstanding(employee._id),
        sumIssued(employee._id, { $gte: todayStart, $lte: now }),
        sumIssued(employee._id, { $gte: sevenDayStart, $lte: now }),
        sumIssued(employee._id, { $gte: cycle.start, $lt: cycle.end, $lte: now }),
    ]);

    const maximums = {
        outstanding: round2(salaryBasis * limits.maxOutstandingPercent / 100),
        daily: round2(salaryBasis * limits.dailyLimitPercent / 100),
        sevenDays: round2(salaryBasis * limits.rollingSevenDayLimitPercent / 100),
        cycle: round2(salaryBasis * limits.maxOutstandingPercent / 100),
    };
    const remaining = {
        outstanding: round2(Math.max(0, maximums.outstanding - outstanding)),
        daily: round2(Math.max(0, maximums.daily - issuedToday)),
        sevenDays: round2(Math.max(0, maximums.sevenDays - issuedSevenDays)),
        cycle: round2(Math.max(0, maximums.cycle - issuedCycle)),
    };

    return {
        employeeId: String(employee._id),
        employeeName: employee.name,
        salaryDay: employee.salaryDate,
        limits,
        usage: { outstanding, issuedToday, issuedSevenDays, issuedCycle },
        maximums,
        remaining,
        available: round2(Math.min(...Object.values(remaining))),
        availableWithOverride: round2(Math.min(remaining.outstanding, remaining.cycle)),
        salaryCycle: {
            start: cycle.start,
            end: cycle.end,
        },
        asOf: now,
        timezone,
    };
};

const reasonLabel = (reason) => {
    if (reason === 'disabled') return 'This credit type is disabled for the employee.';
    if (reason === 'outstanding') return 'The employee has reached the configured combined outstanding ceiling.';
    if (reason === 'daily') return 'The employee has reached today’s combined credit limit.';
    if (reason === 'sevenDays') return 'The employee has reached the rolling seven-day combined credit limit.';
    if (reason === 'cycle') return 'The employee has reached the current salary-cycle credit limit.';
    return 'The employee credit limit has been reached.';
};

export const authorizeEmployeeCredit = async ({
    employee,
    amount,
    type,
    actor,
    overrideRequested = false,
    overrideReason = '',
    ownerOnlyOverride = false,
    // Trusted callers may allow owners to correct an already-posted order
    // above the outstanding/cycle ceilings. POS and manual advances retain
    // their existing daily/seven-day-only override by default.
    allowOwnerCeilingOverride = false,
    now = new Date(),
}) => {
    const requestedAmount = round2(amount);
    const summary = await getEmployeeCreditSummary(employee, { now });
    const enabled = type === 'cts'
        ? summary.limits.chargeToSalaryEnabled
        : summary.limits.cashAdvanceEnabled;
    const reasons = [];
    if (!enabled) reasons.push('disabled');
    if (requestedAmount > summary.remaining.outstanding + 0.001) reasons.push('outstanding');
    if (requestedAmount > summary.remaining.daily + 0.001) reasons.push('daily');
    if (requestedAmount > summary.remaining.sevenDays + 0.001) reasons.push('sevenDays');
    if (requestedAmount > summary.remaining.cycle + 0.001) reasons.push('cycle');

    const canOverride = canOverrideEmployeeCreditLimits(actor, { ownerOnly: ownerOnlyOverride || allowOwnerCeilingOverride });
    const overridableLimits = allowOwnerCeilingOverride && actor?.role === 'owner'
        ? ['daily', 'sevenDays', 'outstanding', 'cycle']
        : ['daily', 'sevenDays'];
    const bypassable = reasons.filter((reason) => overridableLimits.includes(reason));
    const hardBlocks = reasons.filter((reason) => !overridableLimits.includes(reason));
    const wantsOverride = Boolean(overrideRequested && bypassable.length);

    if (allowOwnerCeilingOverride && overrideRequested && !canOverride) {
        throw new EmployeeCreditLimitError('Only an owner can override credit limits for an order charged from accounts.', summary, reasons);
    }
    if (hardBlocks.length) {
        throw new EmployeeCreditLimitError(reasonLabel(hardBlocks[0]), summary, reasons);
    }
    if (bypassable.length && !wantsOverride) {
        throw new EmployeeCreditLimitError(reasonLabel(bypassable[0]), summary, reasons);
    }
    if (wantsOverride && !canOverride) {
        throw new EmployeeCreditLimitError(
            ownerOnlyOverride
                ? 'Only an owner can override employee daily or seven-day credit limits from management.'
                : 'You do not have access to override employee daily or seven-day credit limits.',
            summary,
            reasons
        );
    }
    if (wantsOverride && String(overrideReason || '').trim().length < 5) {
        throw new EmployeeCreditLimitError(
            'Enter an override reason of at least 5 characters.',
            summary,
            reasons
        );
    }

    return {
        summary,
        overrideUsed: wantsOverride,
        overriddenLimits: wantsOverride ? bypassable : [],
        overrideReason: wantsOverride ? String(overrideReason).trim() : undefined,
        snapshot: {
            salaryBasis: round2(employee.salary),
            maxOutstandingPercent: summary.limits.maxOutstandingPercent,
            dailyLimitPercent: summary.limits.dailyLimitPercent,
            rollingSevenDayLimitPercent: summary.limits.rollingSevenDayLimitPercent,
            outstandingBefore: summary.usage.outstanding,
            issuedTodayBefore: summary.usage.issuedToday,
            issuedSevenDaysBefore: summary.usage.issuedSevenDays,
            issuedCycleBefore: summary.usage.issuedCycle,
            availableBefore: summary.available,
            salaryCycleStart: summary.salaryCycle.start,
            salaryCycleEnd: summary.salaryCycle.end,
            overrideUsed: wantsOverride,
            overriddenLimits: wantsOverride ? bypassable : [],
            overrideReason: wantsOverride ? String(overrideReason).trim() : undefined,
            overriddenBy: wantsOverride ? actor.id : undefined,
        },
    };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const withEmployeeCreditLock = async (employeeId, callback) => {
    const token = crypto.randomUUID();
    const attempts = 20;
    let acquired = false;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const now = new Date();
        try {
            const lock = await Employee.findOneAndUpdate(
                {
                    _id: employeeId,
                    $or: [
                        { '_salaryCreditLock.expiresAt': { $lte: now } },
                        { _salaryCreditLock: { $exists: false } },
                        { '_salaryCreditLock.token': token },
                    ],
                },
                {
                    $set: {
                        _salaryCreditLock: {
                            token,
                            expiresAt: new Date(now.getTime() + 120_000),
                        },
                    },
                },
                { returnDocument: 'after' }
            ).select('+_salaryCreditLock').lean();
            acquired = lock?._salaryCreditLock?.token === token;
        } catch (error) {
            throw error;
        }
        if (acquired) break;
        await wait(50 + attempt * 10);
    }

    if (!acquired) {
        const error = new Error('Another credit transaction is being processed for this employee. Please try again.');
        error.statusCode = 409;
        error.code = 'EMPLOYEE_CREDIT_BUSY';
        throw error;
    }

    try {
        return await callback();
    } finally {
        await Employee.updateOne(
            { _id: employeeId, '_salaryCreditLock.token': token },
            { $unset: { _salaryCreditLock: '' } }
        ).catch(() => {});
    }
};
