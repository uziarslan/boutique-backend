import mongoose from 'mongoose';
import SalaryAdvance from '../models/SalaryAdvance.js';
import SalaryPayment from '../models/SalaryPayment.js';
import SaleTransaction from '../models/SaleTransaction.js';
import SaleSession from '../models/SaleSession.js';
import JournalEntry from '../models/JournalEntry.js';
import AuditLog from '../models/AuditLog.js';
import { getTenantConnection } from '../db/tenantContext.js';
import { getAdvanceDeletionBlockReason } from '../utils/advanceDeletion.js';

const id = (value) => String(value?._id ?? value ?? '');
const fail = (message, statusCode = 409) => { throw Object.assign(new Error(message), { statusCode }); };
const plain = (doc) => doc?.toObject({ depopulate: true }) || null;
const paymentFields = [
  'paymentMethod', 'cashAmount', 'cardAmount', 'onlineTransferAmount',
  'cashTendered', 'changeGiven', 'cardLast4', 'onlineTransferReference', 'splitBill',
  'chargeToSalaryEmployee', 'chargeToSalaryEmployeeName', 'salaryAdvance',
];
const journalFields = ['lines', 'description', 'party', 'partyVendor', 'salaryAdvance'];
const paymentLabels = { cash: 'cash', card: 'card', 'online-transfer': 'online transfer', split: 'split payment', 'split-bill': 'split bill' };
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const financialLines = (entry) => (entry?.lines || []).map((line) => ({
  account: id(line.account), debit: Number(line.debit || 0), credit: Number(line.credit || 0),
}));
const validLines = (entry) => {
  const lines = financialLines(entry);
  return lines.length >= 2
    && lines.every((line) => line.account && Number.isFinite(line.debit) && Number.isFinite(line.credit) && line.debit >= 0 && line.credit >= 0)
    && lines.some((line) => line.debit > 0)
    && Math.abs(lines.reduce((sum, line) => sum + line.debit - line.credit, 0)) < 0.001;
};

// Restore only fields changed by chargeOrderToSalary. Never replace entire
// documents: receipt, kitchen and other unrelated updates must survive.
export const convertedCtsRestorePlan = (advance, journal, sale, audit) => {
  if (advance.type !== 'cts' || !sale
      || id(advance.saleTransaction) !== id(sale._id)
      || id(journal.sourceId) !== id(sale._id) || journal.sourceModule !== 'pos'
      || id(journal.salaryAdvance) !== id(advance._id)
      || id(sale.salaryAdvance) !== id(advance._id)
      || id(sale.journalEntryId) !== id(journal._id)
      || sale.paymentMethod !== 'charge-to-salary') {
    fail('The POS order, salary charge and journal links do not match. Review the linked order before deleting this charge.');
  }
  if (sale.status !== 'completed' || sale.isRefund || sale.isVoidedAsWaste || sale.partiallyWasted || sale.voidedAt) {
    fail('This POS order has refund, cancellation or waste activity. Its salary charge cannot be removed here.');
  }
  const before = audit?.before;
  const after = audit?.after;
  if (audit?.action !== 'order_charged_to_salary' || id(audit.recordId) !== id(advance._id)
      || !before?.journal || !before?.sale || !after?.journal || !after?.sale
      || [before.journal, after.journal].some((entry) => id(entry._id) !== id(journal._id) || entry.sourceModule !== 'pos' || id(entry.sourceId) !== id(sale._id))
      || [before.sale, after.sale].some((order) => id(order._id) !== id(sale._id) || id(order.journalEntryId) !== id(journal._id))
      || before.journal.salaryAdvance || before.sale.salaryAdvance
      || id(after.journal.salaryAdvance) !== id(advance._id) || id(after.sale.salaryAdvance) !== id(advance._id)
      || !paymentLabels[before.sale.paymentMethod]
      || before.journal.status !== 'posted' || before.journal.reversedBy
      || !validLines(before.journal) || !validLines(after.journal)) {
    fail('The original POS payment and journal history is missing or incomplete. This charge cannot be safely removed automatically.');
  }
  // Employee corrections change descriptions/line notes, but must not change
  // amounts, accounts or the saved order totals. Allow those name corrections.
  const moneyFields = ['subtotal', 'taxAmount', 'effectiveTaxRate', 'serviceChargeAmount', 'deliveryChargeAmount', 'discountAmount', 'totalAmount'];
  const orderChanged = moneyFields.some((field) => Number(sale[field] || 0) !== Number(after.sale[field] || 0)
      || Number(before.sale[field] || 0) !== Number(after.sale[field] || 0))
    || ['session', 'outlet', 'businessDate', 'transactionNumber'].some((field) => id(sale[field]) !== id(after.sale[field]) || id(before.sale[field]) !== id(after.sale[field]))
    || !same(sale.items, after.sale.items)
    || paymentFields.filter((field) => !['chargeToSalaryEmployee', 'chargeToSalaryEmployeeName'].includes(field))
      .some((field) => !same(sale[field], after.sale[field]));
  if (journal.status !== 'posted' || journal.reversedBy
      || !same(financialLines(journal), financialLines(after.journal))
      || !same(journal.date, after.journal.date) || id(journal.outlet) !== id(after.journal.outlet)
      || Number(advance.amount) !== Number(before.sale.totalAmount) || orderChanged) {
    fail('The POS order or journal has changed since it was charged to salary. Review those changes before removing this charge.');
  }
  const paid = ['cashAmount', 'cardAmount', 'onlineTransferAmount'].reduce((sum, field) => sum + Number(before.sale[field] || 0), 0);
  if (!Number.isFinite(paid) || Math.abs(paid - Number(before.sale.totalAmount)) >= 0.001) {
    fail('The saved original payment does not match the order total. Review the POS payment history before removing this charge.');
  }
  return {
    original: before,
    sessionAdjustment: {
      'totals.cashSales': Number(before.sale.cashAmount || 0),
      'totals.cardSales': Number(before.sale.cardAmount || 0),
      'totals.onlineTransferSales': Number(before.sale.onlineTransferAmount || 0),
      'totals.netCash': Number(before.sale.cashAmount || 0),
      'totals.chargeToSalarySales': -Number(advance.amount),
      'totals.chargeToSalaryOrders': -1,
      'totals.splitBillOrders': ['split', 'split-bill'].includes(before.sale.paymentMethod) ? 1 : 0,
    },
  };
};

const loadDeletion = async (advanceId, session = null) => {
  if (!mongoose.isValidObjectId(advanceId)) fail('Invalid salary advance ID.', 400);
  const advance = await SalaryAdvance.findById(advanceId).session(session);
  if (!advance) fail('Advance not found.', 404);
  const recovered = await SalaryPayment.exists({ 'recoveryDetails.advance': advance._id }).session(session);
  const blocked = getAdvanceDeletionBlockReason(advance, Boolean(recovered));
  if (blocked) fail(blocked);
  if (advance.status !== 'pending') fail('Only an unrecovered, pending advance can be deleted.');
  const journal = advance.journalEntryId ? await JournalEntry.findById(advance.journalEntryId).session(session) : null;
  const sale = advance.saleTransaction
    ? await SaleTransaction.findById(advance.saleTransaction).session(session)
    : advance.type === 'cts' && advance.transactionRef
      ? await SaleTransaction.findOne({ transactionNumber: advance.transactionRef, paymentMethod: 'charge-to-salary' }).session(session) : null;
  if (advance.saleTransaction && !sale) fail('The linked POS order was not found. Review its history before deleting this charge.');
  if (sale && !journal) fail('The linked POS journal was not found. Review its history before deleting this charge.');
  if (journal?.reversedBy || (journal && await JournalEntry.exists({ reversedBy: journal._id }).session(session))) {
    fail('The linked journal has reversal history and cannot be permanently deleted.');
  }
  if (sale && ((sale.salaryAdvance && id(sale.salaryAdvance) !== id(advance._id))
      || (sale.journalEntryId && id(sale.journalEntryId) !== id(advance.journalEntryId)))) {
    fail('The linked POS order belongs to a different advance or journal. Review the order before deleting this charge.');
  }
  if (journal) {
    const otherAdvance = await SalaryAdvance.exists({ _id: { $ne: advance._id }, journalEntryId: journal._id }).session(session);
    const otherSale = await SaleTransaction.exists({ _id: { $ne: sale?._id || null }, journalEntryId: journal._id }).session(session);
    if (otherAdvance || otherSale) fail('The linked journal is also used by another record and cannot be changed by deleting this advance.');
  }

  let restore = null;
  if (journal?.sourceModule === 'pos') {
    const audit = await AuditLog.findOne({ action: 'order_charged_to_salary', recordId: advance._id }).sort({ timestamp: -1 }).session(session).lean();
    restore = convertedCtsRestorePlan(plain(advance), plain(journal), plain(sale), audit);
  } else if (journal && (journal.sourceModule !== 'salaryAdvance' || id(journal.sourceId) !== id(advance._id)
      || (journal.salaryAdvance && id(journal.salaryAdvance) !== id(advance._id)))) {
    fail('The linked journal does not belong exclusively to this advance and cannot be deleted.');
  }
  const mode = restore ? 'restore-pos' : 'delete';
  const preview = restore ? {
    mode,
    summary: 'This removes the salary charge and restores the original POS payment',
    confirmLabel: 'Remove CTS & Restore Order',
    consequences: [
      'The salary charge will be permanently removed from the employee’s advances.',
      `Order ${sale.transactionNumber} will return to its original ${paymentLabels[restore.original.sale.paymentMethod]} payment.`,
      'The existing POS journal will be restored in place, including its original tax and discount lines. No reversal entry will be created.',
      'The order stays in history and its payment totals will be updated.',
    ],
  } : {
    mode,
    summary: journal ? 'This removes the advance and its journal entry' : 'This removes the advance record',
    confirmLabel: 'Delete Permanently',
    consequences: [
      'The advance record will be permanently deleted.',
      journal ? 'Its linked journal entry will be deleted directly; no reversal entry will be created.' : 'There is no linked journal entry to delete.',
      ...(sale ? ['The POS order will remain in history, but its advance and journal links will be cleared.'] : []),
    ],
  };
  return { advance, journal, sale, restore, preview };
};

export const previewAdvanceDeletion = async (advanceId) => (await loadDeletion(advanceId)).preview;

export const permanentlyDeleteAdvance = async ({ advanceId, reason, expectedMode, actor, ip }) => {
  if (String(reason || '').trim().length < 5) fail('Enter a deletion reason of at least 5 characters.', 400);
  const session = await getTenantConnection().startSession();
  try {
    return await session.withTransaction(async () => {
      // Re-read all guards inside the transaction: a preview is never authority
      // to delete a record that has since been recovered, edited or reversed.
      const { advance, journal, sale, restore, preview } = await loadDeletion(advanceId, session);
      // Older clients promise journal deletion, so require the restore preview
      // explicitly before allowing them to change a POS payment instead.
      if ((expectedMode || restore) && expectedMode !== preview.mode) fail('The deletion action has changed. Refresh the page and review it again.');
      const before = { advance: plain(advance), journal: plain(journal), sale: plain(sale) };
      if (restore) {
        for (const field of journalFields) journal.set(field, restore.original.journal[field]);
        for (const field of paymentFields) sale.set(field, restore.original.sale[field]);
        await journal.save({ session });
        await sale.save({ session });
        if (sale.session) {
          await SaleSession.updateOne({ _id: sale.session, status: 'closed' }, { $inc: restore.sessionAdjustment }, { session });
        }
      } else {
        if (sale) {
          if (id(sale.salaryAdvance) === id(advance._id)) sale.salaryAdvance = null;
          if (journal && id(sale.journalEntryId) === id(journal._id)) sale.journalEntryId = null;
          await sale.save({ session });
        }
        if (journal) await JournalEntry.deleteOne({ _id: journal._id }, { session });
      }
      const deleted = await SalaryAdvance.deleteOne({ _id: advance._id, recoveredAmount: 0, status: 'pending', 'repayments.0': { $exists: false } }, { session });
      if (deleted.deletedCount !== 1) fail('The advance changed before deletion. Refresh and try again.');
      await AuditLog.create([{
        user: actor.id, actorName: actor.name, actorRole: actor.role,
        action: 'salary_advance_deleted', module: 'salaries', recordId: advance._id,
        before,
        after: {
          reason: String(reason).trim(), journalDeleted: Boolean(journal) && !restore,
          reversalCreated: false, originalPosRestored: Boolean(restore),
          ...(restore ? { journal: plain(journal), sale: plain(sale) } : {}),
        }, ip,
      }], { session });
      return { mode: preview.mode, message: restore
        ? 'Salary charge removed. The original POS payment and journal have been restored.'
        : journal ? 'Advance and linked journal entry permanently deleted.' : 'Advance permanently deleted; no linked journal entry existed.' };
    });
  } finally {
    await session.endSession();
  }
};
