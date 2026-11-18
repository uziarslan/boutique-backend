import JournalEntry from '../models/JournalEntry.js';
import { buildPurchaseJournalFields } from '../accounting/journalEngine.js';

const purchaseJournalForUpdate = async (purchase) => {
  if (!purchase.journalEntryId) {
    throw Object.assign(
      new Error('The linked purchase journal was not found, so the purchase was not changed.'),
      { statusCode: 409 },
    );
  }

  const journalEntry = await JournalEntry.findById(purchase.journalEntryId);
  if (!journalEntry) {
    throw Object.assign(
      new Error('The linked purchase journal was not found, so the purchase was not changed.'),
      { statusCode: 409 },
    );
  }
  if (
    journalEntry.sourceModule !== 'purchase'
    || String(journalEntry.sourceId || '') !== String(purchase._id)
  ) {
    throw Object.assign(
      new Error('The linked journal does not belong to this purchase, so the purchase was not changed.'),
      { statusCode: 409 },
    );
  }
  if (journalEntry.reversedBy) {
    throw Object.assign(
      new Error('The purchase journal has already been reversed and cannot be edited.'),
      { statusCode: 409 },
    );
  }
  return journalEntry;
};

// Keeps a posted purchase correction on the original journal record. This
// changes only the accounting date; it never posts a correction/reversal JE.
export const updatePurchaseJournalDateInPlace = async (purchase) => {
  const journalEntry = await purchaseJournalForUpdate(purchase);

  const previousJournalDate = journalEntry.date;
  journalEntry.date = purchase.purchaseDate;
  await journalEntry.save();
  return { journalEntry, previousJournalDate };
};

// Posted purchase corrections must remain a single purchase journal. Rebuild
// every source-controlled field from the corrected purchase while preserving
// the original JE identity/number and creator. The caller receives an exact
// snapshot for rollback if a later correction step fails.
export const updatePurchaseJournalInPlace = async (purchase) => {
  const journalEntry = await purchaseJournalForUpdate(purchase);
  const previousJournal = journalEntry.toObject();
  const fields = await buildPurchaseJournalFields(purchase);

  journalEntry.set(fields);
  await journalEntry.save();
  return { journalEntry, previousJournal };
};
