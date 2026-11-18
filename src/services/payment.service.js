// Shared settlement logic for posted purchases.
// Creates the payment, updates the purchase balance, and posts:
// DR Accounts Payable / CR Cash & Bank.

import Payment from '../models/Payment.js';
import JournalEntry from '../models/JournalEntry.js';
import { postPayment } from '../accounting/journalEngine.js';
import logger from '../utils/logger.js';

const round2 = (value) => Number((Number(value) || 0).toFixed(2));
const near = (left, right) => Math.abs(Number(left) - Number(right)) < 0.001;

const restoreDocument = (Model, snapshot) => Model.replaceOne(
  { _id: snapshot._id },
  snapshot,
  { upsert: true },
);

const paymentJournal = async (payment) => {
  const journalEntry = payment.journalEntryId
    ? await JournalEntry.findById(payment.journalEntryId)
    : await JournalEntry.findOne({ sourceModule: 'payment', sourceId: payment._id });
  if (!journalEntry) {
    throw Object.assign(
      new Error('A linked payment journal was not found, so the paid purchase was not reduced.'),
      { statusCode: 409 },
    );
  }
  if (
    journalEntry.sourceModule !== 'payment'
    || String(journalEntry.sourceId || '') !== String(payment._id)
    || journalEntry.reversedBy
  ) {
    throw Object.assign(
      new Error('A payment has an invalid or reversed journal, so the paid purchase was not reduced.'),
      { statusCode: 409 },
    );
  }
  const debit = round2(journalEntry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0));
  const credit = round2(journalEntry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0));
  if (!near(debit, payment.amount) || !near(credit, payment.amount)) {
    throw Object.assign(
      new Error('A payment amount does not match its journal, so the paid purchase was not reduced.'),
      { statusCode: 409 },
    );
  }
  return journalEntry;
};

const rescaleJournalSide = (lines, field, newTotal) => {
  const indexes = lines.reduce((result, line, index) => (
    Number(line[field] || 0) > 0 ? [...result, index] : result
  ), []);
  const oldTotal = indexes.reduce((sum, index) => sum + Number(lines[index][field] || 0), 0);
  let allocated = 0;
  indexes.forEach((index, position) => {
    const amount = position === indexes.length - 1
      ? round2(newTotal - allocated)
      : round2(newTotal * (Number(lines[index][field] || 0) / oldTotal));
    lines[index][field] = amount;
    allocated = round2(allocated + amount);
  });
};

const setPaymentJournalAmount = (journalEntry, amount) => {
  rescaleJournalSide(journalEntry.lines, 'debit', amount);
  rescaleJournalSide(journalEntry.lines, 'credit', amount);
};

// A fully paid purchase may be corrected downward because the original invoice
// value was entered incorrectly. Remove the overstatement from the newest
// payments first, updating their existing journals in place. A payment consumed
// entirely by the reduction is removed together with its journal; the caller
// stores the returned change summary on the purchase correction audit record.
export const reconcileFullyPaidPurchasePayments = async (
  purchaseId,
  { previousPaid, correctedPaid } = {},
) => {
  const expected = round2(previousPaid);
  const target = round2(correctedPaid);
  const payments = await Payment.find({
    purchase: purchaseId,
    status: { $ne: 'reversed' },
  }).sort({ paymentDate: -1, createdAt: -1 });
  const postedTotal = round2(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  if (!near(postedTotal, expected)) {
    throw Object.assign(
      new Error('Posted payment records do not match the purchase paid amount, so the correction was stopped.'),
      { statusCode: 409 },
    );
  }

  let reduction = round2(postedTotal - target);
  if (reduction <= 0) return { changes: [], rollback: async () => {} };
  const undo = [];
  const changes = [];
  const rollback = async () => {
    for (const restore of [...undo].reverse()) {
      try { await restore(); } catch (error) {
        logger.error(`[reconcileFullyPaidPurchasePayments] rollback failed: ${error.message}`);
      }
    }
  };

  try {
    for (const payment of payments) {
      if (reduction <= 0.001) break;
      const paymentBefore = payment.toObject();
      const journalEntry = await paymentJournal(payment);
      const journalBefore = journalEntry.toObject();
      const oldAmount = round2(payment.amount);

      if (reduction + 0.001 >= oldAmount) {
        const removedPayment = await Payment.deleteOne({ _id: payment._id, status: { $ne: 'reversed' } });
        if (removedPayment.deletedCount !== 1) throw new Error('The excess payment changed during correction.');
        try {
          const removedJournal = await JournalEntry.deleteOne({
            _id: journalEntry._id,
            sourceModule: 'payment',
            sourceId: payment._id,
          });
          if (removedJournal.deletedCount !== 1) throw new Error('The excess payment journal changed during correction.');
        } catch (error) {
          await restoreDocument(Payment, paymentBefore);
          throw error;
        }
        undo.push(async () => {
          await restoreDocument(JournalEntry, journalBefore);
          await restoreDocument(Payment, paymentBefore);
        });
        changes.push({
          payment: payment._id,
          journalEntry: journalEntry._id,
          entryNumber: journalEntry.entryNumber,
          action: 'removed',
          beforeAmount: oldAmount,
          afterAmount: 0,
          method: payment.method,
          paymentDate: payment.paymentDate,
        });
        reduction = round2(reduction - oldAmount);
        continue;
      }

      const newAmount = round2(oldAmount - reduction);
      setPaymentJournalAmount(journalEntry, newAmount);
      await journalEntry.save();
      try {
        payment.amount = newAmount;
        await payment.save();
      } catch (error) {
        await restoreDocument(JournalEntry, journalBefore);
        payment.amount = oldAmount;
        throw error;
      }
      undo.push(async () => {
        await restoreDocument(JournalEntry, journalBefore);
        await restoreDocument(Payment, paymentBefore);
      });
      changes.push({
        payment: payment._id,
        journalEntry: journalEntry._id,
        entryNumber: journalEntry.entryNumber,
        action: 'reduced',
        beforeAmount: oldAmount,
        afterAmount: newAmount,
        method: payment.method,
        paymentDate: payment.paymentDate,
      });
      reduction = 0;
    }
    if (reduction > 0.001) {
      throw new Error('The recorded payments could not be reduced to the corrected purchase total.');
    }
    return { changes, rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
};

// A payment inherits its accounting party from the purchase at the time it is
// recorded. If a posted purchase is later corrected to add/change/remove its
// vendor, keep every linked payment under the same party so the AP credit and
// its settling debit continue to offset one another in vendor aging/ledgers.
export const syncPurchasePaymentVendor = async (purchaseId, vendor) => {
  const payments = await Payment.find({ purchase: purchaseId })
    .select('_id vendor')
    .lean();

  if (!payments.length) return [];

  await Payment.updateMany(
    { purchase: purchaseId },
    { $set: { vendor: vendor || null } },
  );
  return payments;
};

export const restorePurchasePaymentVendors = async (payments = []) => {
  if (!payments.length) return;
  await Payment.bulkWrite(payments.map((payment) => ({
    updateOne: {
      filter: { _id: payment._id },
      update: { $set: { vendor: payment.vendor || null } },
    },
  })));
};

// Corrects editable details on the existing payment and its journal entry.
// This intentionally does not call reverseJournalEntry or postPayment: accounting
// keeps the same journal _id, entry number, and lines.
export const updatePurchasePaymentInPlace = async (payment, { paymentDate, method } = {}) => {
  const journalEntry = payment.journalEntryId
    ? await JournalEntry.findById(payment.journalEntryId)
    : await JournalEntry.findOne({ sourceModule: 'payment', sourceId: payment._id });

  if (!journalEntry) {
    throw Object.assign(
      new Error('The linked payment journal was not found, so the date was not changed.'),
      { statusCode: 409 },
    );
  }
  if (
    journalEntry.sourceModule !== 'payment'
    || String(journalEntry.sourceId || '') !== String(payment._id)
  ) {
    throw Object.assign(
      new Error('The linked journal does not belong to this payment, so the date was not changed.'),
      { statusCode: 409 },
    );
  }
  if (journalEntry.reversedBy || payment.status === 'reversed') {
    throw Object.assign(
      new Error('A reversed payment cannot be edited.'),
      { statusCode: 409 },
    );
  }

  const settlementLine = journalEntry.lines.find((line) => Number(line.credit || 0) > 0);
  if (!settlementLine) {
    throw Object.assign(
      new Error('The linked payment journal has no settlement line, so the payment was not changed.'),
      { statusCode: 409 },
    );
  }

  const previousPaymentDate = payment.paymentDate;
  const previousMethod = payment.method;
  const previousJournalDate = journalEntry.date;
  const previousSettlementNotes = settlementLine.notes;
  journalEntry.date = paymentDate;
  settlementLine.notes = `${method}${payment.reference ? ` — ${payment.reference}` : ''}`;
  await journalEntry.save();

  try {
    payment.paymentDate = paymentDate;
    payment.method = method;
    // Repair a legacy missing link while retaining the journal itself.
    if (!payment.journalEntryId) payment.journalEntryId = journalEntry._id;
    await payment.save();
  } catch (error) {
    journalEntry.date = previousJournalDate;
    settlementLine.notes = previousSettlementNotes;
    try {
      await journalEntry.save();
    } catch (rollbackError) {
      logger.error(`[updatePurchasePaymentDateInPlace] journal rollback failed: ${rollbackError.message}`);
    }
    payment.paymentDate = previousPaymentDate;
    payment.method = previousMethod;
    throw error;
  }

  return { payment, journalEntry };
};

// Backward-compatible helper retained for callers that only correct the date.
export const updatePurchasePaymentDateInPlace = (payment, paymentDate) => (
  updatePurchasePaymentInPlace(payment, { paymentDate, method: payment.method })
);

export const recordPurchasePayment = async (
  purchase,
  { amount, method = 'cash', reference, paymentDate, currency, notes, userId } = {},
) => {
  const amt = parseFloat(Number(amount).toFixed(2));
  const prevPaid = purchase.amountPaid || 0;
  const prevStatus = purchase.status;
  const undo = [];
  try {
    const payment = await Payment.create({
      purchase: purchase._id,
      vendor: purchase.vendor,
      amount: amt,
      method,
      reference,
      paymentDate: paymentDate || new Date(),
      currency: currency || purchase.currency,
      notes,
      recordedBy: userId || null,
    });
    undo.push(async () => Payment.deleteOne({ _id: payment._id }));

    const journalEntry = await postPayment(payment, userId || null, purchase);
    undo.push(async () => JournalEntry.deleteOne({ _id: journalEntry._id }));
    payment.journalEntryId = journalEntry._id;
    await payment.save();

    purchase.amountPaid = parseFloat((prevPaid + amt).toFixed(2));
    const balance = parseFloat((purchase.totalAmount - purchase.amountPaid).toFixed(2));
    purchase.status = balance <= 0.001 ? 'paid' : 'partiallyPaid';
    await purchase.save();
    return { payment, journalEntry };
  } catch (err) {
    purchase.amountPaid = prevPaid;
    purchase.status = prevStatus;
    for (const fn of undo.reverse()) {
      try { await fn(); } catch (rollbackErr) {
        logger.error(`[recordPurchasePayment] rollback failed: ${rollbackErr.message}`);
      }
    }
    throw err;
  }
};
