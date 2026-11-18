import JournalEntry from '../models/JournalEntry.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SalaryAdvance from '../models/SalaryAdvance.js';
import SaleSession from '../models/SaleSession.js';
import Employee from '../models/Employee.js';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import AuditLog from '../models/AuditLog.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { authorizeEmployeeCredit, withEmployeeCreditLock } from './employeeCredit.service.js';

const id = (value) => String(value?._id ?? value ?? '');
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const PAYMENT_METHODS = ['cash', 'card', 'online-transfer', 'split', 'split-bill'];

export const validateOrderSalaryCharge = (entry, sale) => {
  if (!entry) fail('Journal entry not found.', 404);
  if (entry.sourceModule !== 'pos' || entry.status !== 'posted' || entry.reversedBy) {
    fail('Only an original, posted POS sale journal can be charged to salary.');
  }
  if (!sale || id(entry.sourceId) !== id(sale._id) || id(sale.journalEntryId) !== id(entry._id)) {
    fail('The journal is not linked to the original order.');
  }
  if (entry.salaryAdvance || sale.salaryAdvance || sale.paymentMethod === 'charge-to-salary') {
    fail('This order is already linked to a salary charge.');
  }
  if (sale.status !== 'completed' || sale.isRefund || sale.isVoidedAsWaste || sale.partiallyWasted) {
    fail('Only a completed order without refunds or waste adjustments can be charged to salary.');
  }
  if (!PAYMENT_METHODS.includes(sale.paymentMethod)) {
    fail('Only cash, card, online transfer or split-payment orders can be charged to salary.');
  }
  if (!Number.isFinite(Number(sale.totalAmount)) || Number(sale.totalAmount) < 1) {
    fail('The order amount must be at least Rs. 1.', 422);
  }
};

// Reclassify the saved payment, never the debit total (which includes discounts
// and redeemed points). Retain the original tax, discount, delivery and service
// postings; move item revenue to the same 4006 head used at POS checkout.
export const salaryChargeLines = (entry, sale, accounts, employeeName) => {
  for (const code of ['1001', '1102', '4001', '4006']) {
    if (!accounts[code] || accounts[code].isActive === false) {
      fail(`Required account ${code} is missing or inactive.`, 422);
    }
  }
  const cashLines = entry.lines.filter((line) => id(line.account) === id(accounts['1001']));
  const cashDebit = round2(cashLines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  if (!cashLines.length || cashLines.some((line) => Number(line.credit || 0) !== 0)
      || cashDebit !== round2(sale.totalAmount)) {
    fail('The saved cash/bank journal amount does not match the order. Correct the journal before charging salary.');
  }
  const lines = entry.lines.map((line) => {
    const result = { account: line.account, debit: line.debit, credit: line.credit, notes: line.notes };
    if (id(line.account) === id(accounts['1001'])) {
      result.account = accounts['1102']._id;
      result.notes = `Charged to salary — ${employeeName} — ${sale.transactionNumber}`;
    } else if (id(line.account) === id(accounts['4001'])) {
      result.account = accounts['4006']._id;
      result.notes = `Sale charged to salary — ${sale.transactionNumber}`;
    }
    return result;
  });
  const balance = lines.reduce((sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0), 0);
  if (Math.abs(balance) >= 0.001) fail('The saved journal is not balanced.');
  return lines;
};

export const loadOrderSalaryCharge = async (entryId, session = null) => {
  const entry = await JournalEntry.findById(entryId).session(session);
  if (!entry) fail('Journal entry not found.', 404);
  const sale = entry.sourceModule === 'pos' && entry.sourceId
    ? await SaleTransaction.findById(entry.sourceId).session(session) : null;
  validateOrderSalaryCharge(entry, sale);
  const existing = await SalaryAdvance.exists({
    $or: [{ saleTransaction: sale._id }, { journalEntryId: entry._id }, { type: 'cts', transactionRef: sale.transactionNumber }],
  }).session(session);
  if (existing) fail('A salary charge already exists for this order. Open it from Salaries.');
  return { entry, sale };
};

export const chargeOrderToSalary = async ({ entryId, employeeId, reason, creditLimitOverride, actor, ip }) =>
  withEmployeeCreditLock(employeeId, async () => {
    // The employee lock is shared with POS checkout and manual advances.
    const employee = await Employee.findOne({ _id: employeeId, isActive: true });
    if (!employee) fail('Active employee not found.', 422);
    const session = await getTenantConnection().startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const { entry, sale } = await loadOrderSalaryCharge(entryId, session);
        const decision = await authorizeEmployeeCredit({
          employee, amount: sale.totalAmount, type: 'cts', actor,
          overrideRequested: creditLimitOverride?.requested === true,
          overrideReason: creditLimitOverride?.reason || '', ownerOnlyOverride: true,
          allowOwnerCeilingOverride: true,
        });
        const rows = await ChartOfAccounts.find({ code: { $in: ['1001', '1102', '4001', '4006'] } }).session(session).lean();
        const accounts = Object.fromEntries(rows.map((account) => [account.code, account]));
        const lines = salaryChargeLines(entry, sale, accounts, employee.name);
        const before = { journal: entry.toObject(), sale: sale.toObject() };
        const [advance] = await SalaryAdvance.create([{
          employee: employee._id, type: 'cts', revenueAccount: accounts['4006']._id,
          amount: round2(sale.totalAmount), advanceDate: entry.date,
          businessDate: sale.businessDate || null,
          transactionRef: sale.transactionNumber,
          notes: `POS ${sale.transactionNumber} — ${reason}`,
          saleTransaction: sale._id, journalEntryId: entry._id,
          creditPolicySnapshot: decision.snapshot, createdBy: actor.id,
        }], { session });

        entry.lines = lines;
        entry.description = `POS sale charged to salary — ${sale.transactionNumber} — ${employee.name}`;
        entry.salaryAdvance = advance._id;
        entry.party = 'Salary Advance';
        entry.partyVendor = undefined;
        await entry.save({ session });

        sale.paymentMethod = 'charge-to-salary';
        sale.chargeToSalaryEmployee = employee._id;
        sale.chargeToSalaryEmployeeName = employee.name;
        sale.salaryAdvance = advance._id;
        sale.cashAmount = 0;
        sale.cardAmount = 0;
        sale.onlineTransferAmount = 0;
        sale.cashTendered = 0;
        sale.changeGiven = 0;
        sale.cardLast4 = null;
        sale.onlineTransferReference = null;
        sale.splitBill = { ways: 0, parts: [] };
        await sale.save({ session });

        // Open sessions aggregate their orders live; closed sessions also keep
        // a snapshot. Adjust only payment buckets, retaining sales and counts.
        if (sale.session) {
          await SaleSession.updateOne({ _id: sale.session, status: 'closed' }, { $inc: {
            'totals.cashSales': -Number(before.sale.cashAmount || 0),
            'totals.cardSales': -Number(before.sale.cardAmount || 0),
            'totals.onlineTransferSales': -Number(before.sale.onlineTransferAmount || 0),
            'totals.netCash': -Number(before.sale.cashAmount || 0),
            'totals.chargeToSalarySales': advance.amount,
            'totals.chargeToSalaryOrders': 1,
            'totals.splitBillOrders': ['split', 'split-bill'].includes(before.sale.paymentMethod) ? -1 : 0,
          } }, { session });
        }
        await AuditLog.create([{
          user: actor.id, actorName: actor.name, actorRole: actor.role,
          action: 'order_charged_to_salary', module: 'salaries', recordId: advance._id, ip,
          before,
          after: { journal: entry.toObject(), sale: sale.toObject(), employeeId: employee._id,
            amount: advance.amount, reason, creditPolicySnapshot: decision.snapshot },
        }], { session });
        result = { entry, sale, advance };
      });
      return result;
    } finally {
      await session.endSession();
    }
  });
