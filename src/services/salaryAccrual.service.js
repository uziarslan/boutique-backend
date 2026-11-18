import JournalEntry from '../models/JournalEntry.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import { postSalaryAccrual } from '../accounting/journalEngine.js';
import { accrualDateFromPeriod, salaryAccrualAllocations, salaryAccrualFields } from '../utils/salaryAccrual.js';

// Corrections retain journal IDs/numbers. Removed month allocations are zeroed
// in place and retained on the payment; they can be reused by a later edit.
// No reversal journals are created, including during compensation on failure.
export const syncSalaryAccruals = async ({
    payment, employeeName, timezone, createdBy, rollback, originalPeriod = payment.period,
}) => {
    const allocations = salaryAccrualAllocations(payment);
    const references = (payment.accrualEntries || []).map((entry) => ({
        period: entry.period, journalEntryId: entry.journalEntryId,
    }));
    if (payment.accrualEntryId
        && !references.some((entry) => String(entry.journalEntryId) === String(payment.accrualEntryId))) {
        references.unshift({ period: originalPeriod, journalEntryId: payment.accrualEntryId });
    }
    if (new Set(references.map((entry) => entry.period)).size !== references.length
        || new Set(references.map((entry) => String(entry.journalEntryId))).size !== references.length) {
        throw Object.assign(new Error('Salary accrual references are inconsistent.'), { statusCode: 409 });
    }
    const existing = new Map();
    for (const reference of references) {
        const entry = await JournalEntry.findById(reference.journalEntryId);
        if (!entry || entry.reversedBy || entry.status !== 'posted'
            || entry.sourceModule !== 'salary' || String(entry.sourceId) !== String(payment._id)) {
            throw Object.assign(new Error('A salary accrual is missing, reversed, or belongs to another payment.'), { statusCode: 409 });
        }
        existing.set(reference.period, entry);
    }
    // Preserve the original primary journal when the selected period changes.
    if (!existing.has(payment.period) && existing.has(originalPeriod)
        && !allocations.some((item) => item.period === originalPeriod)) {
        existing.set(payment.period, existing.get(originalPeriod));
        existing.delete(originalPeriod);
    }
    const accounts = await ChartOfAccounts.find({ code: { $in: ['6003', '2100'] } }).lean();
    const byCode = Object.fromEntries(accounts.map((account) => [account.code, account._id]));
    if (existing.size && (!byCode['6003'] || !byCode['2100'])) {
        throw Object.assign(new Error('Payroll accounting accounts were not found.'), { statusCode: 409 });
    }
    const desired = new Map(allocations.map((allocation) => [allocation.period, allocation]));
    for (const period of existing.keys()) {
        if (!desired.has(period)) desired.set(period, { period, grossAmount: 0, penaltyDeducted: 0 });
    }
    const entries = [];
    for (const allocation of desired.values()) {
        const date = accrualDateFromPeriod(allocation.period, timezone);
        let entry = existing.get(allocation.period);
        if (entry) {
            const before = entry.toObject();
            Object.assign(entry, salaryAccrualFields(allocation, employeeName, date, byCode));
            await entry.save();
            rollback.push(() => JournalEntry.replaceOne({ _id: entry._id }, before));
        } else {
            entry = await postSalaryAccrual({ _id: payment._id, ...allocation }, employeeName, date, createdBy);
            rollback.push(() => JournalEntry.deleteOne({ _id: entry._id }));
        }
        entries.push({ ...allocation, journalEntryId: entry._id });
    }
    payment.accrualEntries = entries;
    payment.accrualEntryId = entries.find((entry) => entry.period === payment.period).journalEntryId;
    return entries;
};
