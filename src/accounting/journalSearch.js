const TEXT_FIELDS = [
  'entryNumber',
  'description',
  'lines.notes',
  'sourceModule',
  'sourcePath',
  'itemSummary',
  'sourceNumber',
  'legacyDescription',
  'party',
  'status',
];

// Some module names are stored as implementation keys but shown with friendlier
// labels in the Journal Entries table/filter. Searching the visible label should
// find the same entries as searching the stored key.
const MODULE_LABELS = {
  manual: 'Manual',
  purchase: 'Purchase',
  purchaseAdjustment: 'Purchase correction',
  payment: 'Payment',
  inventory: 'Kitchen',
  waste: 'Waste',
  pos: 'POS',
  stockCount: 'Stock Count',
  salary: 'Salary',
  salaryAdvance: 'Salary Advance',
  allowance: 'Allowance',
  loyalty: 'Loyalty',
  cashDrawer: 'Cash Drawer',
  assetAcquisition: 'Asset acquisition',
  assetDepreciation: 'Asset depreciation',
  assetAuditAdjustment: 'Asset audit adjustment',
  assetDisposal: 'Asset disposal',
};

const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4],
  ['may', 5], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

export const escapeJournalSearchTerm = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Amount searches are exact (to the paisa) and accept the same punctuation a
// user sees in the table, e.g. "12,500.00", "Rs. 12,500", or "PKR 12500".
export const parseJournalSearchAmount = (value) => {
  const normalized = String(value ?? '')
    .trim()
    .replace(/^(?:rs\.?|pkr|₨)\s*/i, '')
    .replaceAll(',', '')
    .trim();

  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
};

const validCalendarDate = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const asDateString = (year, month, day) => {
  if (!validCalendarDate(year, month, day)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// The table displays `dd MMM yyyy`; ISO and common numeric day-first forms are
// accepted too so dates participate in the same all-details search.
export const parseJournalSearchDate = (value) => {
  const term = String(value ?? '').trim();
  let match = term.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return asDateString(Number(match[1]), Number(match[2]), Number(match[3]));

  match = term.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return asDateString(Number(match[3]), Number(match[2]), Number(match[1]));

  match = term.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})$/i);
  if (!match) return null;
  const month = MONTHS.get(match[2].slice(0, 3).toLowerCase());
  return month ? asDateString(Number(match[3]), month, Number(match[1])) : null;
};

/**
 * Build the journal-side portion of the Mongo search. Reference IDs are looked
 * up by the controller first because account/user/vendor/outlet names live in
 * their own collections rather than on the JournalEntry document.
 */
export const buildJournalSearchClauses = (value, {
  accountIds = [],
  creatorIds = [],
  vendorIds = [],
  outletIds = [],
  objectId = null,
  dateRange = null,
} = {}) => {
  const term = String(value ?? '').trim();
  if (!term) return [];

  const rx = new RegExp(escapeJournalSearchTerm(term), 'i');
  const clauses = TEXT_FIELDS.map((field) => ({ [field]: rx }));

  if (accountIds.length) clauses.push({ 'lines.account': { $in: accountIds } });
  if (creatorIds.length) clauses.push({ createdBy: { $in: creatorIds } });
  if (vendorIds.length) clauses.push({ partyVendor: { $in: vendorIds } });
  if (outletIds.length) clauses.push({ outlet: { $in: outletIds } });
  if (dateRange) clauses.push({ date: dateRange });

  if (objectId) {
    clauses.push(
      { _id: objectId },
      { sourceId: objectId },
      { outlet: objectId },
      { partyVendor: objectId },
      { reversedBy: objectId },
      { createdBy: objectId },
      { 'lines._id': objectId },
      { 'lines.account': objectId },
    );
  }

  const amount = parseJournalSearchAmount(term);
  if (amount !== null) {
    // A zero-valued opposite side exists on almost every line, so only match a
    // zero when the entry total is genuinely zero. Positive values can match an
    // individual line or the total shown in the table.
    if (amount > 0) {
      clauses.push({ 'lines.debit': amount }, { 'lines.credit': amount });
    }
    clauses.push({
      $expr: {
        $or: [
          { $eq: [{ $round: [{ $sum: '$lines.debit' }, 2] }, amount] },
          { $eq: [{ $round: [{ $sum: '$lines.credit' }, 2] }, amount] },
        ],
      },
    });
  }

  const normalized = term.toLowerCase();
  const matchingModules = Object.entries(MODULE_LABELS)
    .filter(([, label]) => label.toLowerCase().includes(normalized))
    .map(([module]) => module);
  if (matchingModules.length) clauses.push({ sourceModule: { $in: matchingModules } });

  if (normalized === 'balanced') clauses.push({ isBalanced: true });
  if (normalized === 'unbalanced') clauses.push({ isBalanced: false });
  if (normalized === 'reversed' || normalized === 'reversal') {
    clauses.push({ reversedBy: { $ne: null } });
  }

  return clauses;
};

