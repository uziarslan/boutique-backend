import { endOfLocalDayUtc } from './timezone.js';

const invalid = (message) => {
    throw Object.assign(new Error(message), { statusCode: 400 });
};
const validPeriod = (period) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''));
const cents = (value) => Math.round(Number(value) * 100);

export const accrualDateFromPeriod = (period, timezone) => {
    if (!validPeriod(period)) invalid('Select a valid salary period.');
    const [year, month] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return endOfLocalDayUtc(`${period}-${lastDay}`, timezone);
};

// Use the saved payroll calculation, never today's employee salary/rates.
// Recoveries settle receivables; only penalties reduce payroll expense.
export const salaryAccrualAllocations = (payment) => {
    if (!validPeriod(payment.period)) invalid('Select a valid salary period.');
    const gross = cents(payment.grossAmount);
    const penalty = cents(payment.penaltyDeducted || 0);
    const attendance = payment.attendanceCalculation;
    const prepaid = cents(attendance?.prepaidPay || 0);
    if (![gross, penalty, prepaid].every(Number.isSafeInteger)
        || gross < 0 || penalty < 0 || penalty > gross || prepaid < 0 || prepaid > gross) {
        invalid('Salary amounts cannot be allocated to their months. Review the salary calculation.');
    }

    const amounts = [{ period: payment.period, gross }];
    if (prepaid > 0) {
        const [year, month] = payment.period.split('-').map(Number);
        const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
        const dates = attendance.prepaidDates || [];
        const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        if (attendance.prepaidPeriod !== next || !dates.length
            || new Set(dates).size !== dates.length
            || dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date)
                || date.slice(0, 7) !== next || Number(date.slice(8)) < 1
                || Number(date.slice(8)) > daysInMonth)) {
            invalid('Paid-ahead salary must have valid dates in the following month.');
        }
        const earned = cents(attendance.baseEarned || 0)
            + cents(attendance.holidayWorkPay || 0) + cents(attendance.overtimePay || 0);
        if (earned + prepaid !== gross) {
            invalid('The saved monthly salary breakdown does not match the gross amount. Review attendance before saving.');
        }
        amounts[0].gross -= prepaid;
        amounts.push({ period: next, gross: prepaid });
    }

    // A payslip penalty belongs to its selected salary period first. If it
    // exceeds that month's earnings, carry only the remainder to paid-ahead pay.
    let remainingPenalty = penalty;
    return amounts.map((amount) => {
        const deduction = Math.min(amount.gross, remainingPenalty);
        remainingPenalty -= deduction;
        return {
            period: amount.period,
            grossAmount: amount.gross / 100,
            penaltyDeducted: deduction / 100,
        };
    });
};

export const salaryAccrualEntryIds = (payment) => [...new Map([
    payment.accrualEntryId,
    ...(payment.accrualEntries || []).map((entry) => entry.journalEntryId),
].filter(Boolean).map((id) => [String(id), id])).values()];

export const salaryAccrualFields = (allocation, employeeName, date, accounts) => {
    const gross = allocation.grossAmount;
    const penalty = allocation.penaltyDeducted || 0;
    const lines = [{
        account: accounts['6003'], debit: gross, credit: 0,
        notes: `Payroll Expense — ${employeeName}`,
    }];
    if (penalty > 0) lines.push({
        account: accounts['6003'], debit: 0, credit: penalty,
        notes: `Salary penalty — ${employeeName}`,
    });
    lines.push({
        account: accounts['2100'], debit: 0, credit: (cents(gross) - cents(penalty)) / 100,
        notes: `Accrued — owed to ${employeeName} for ${allocation.period}`,
    });
    return { date, description: `Salary accrued — ${employeeName} (${allocation.period})`, lines };
};
