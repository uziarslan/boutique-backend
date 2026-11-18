import mongoose from 'mongoose';
import ChartOfAccounts  from '../models/ChartOfAccounts.js';
import JournalEntry     from '../models/JournalEntry.js';
import CustomParty      from '../models/CustomParty.js';
import Purchase         from '../models/Purchase.js';
import Payment          from '../models/Payment.js';
import User             from '../models/User.js';
import Vendor           from '../models/Vendor.js';
import Outlet           from '../models/Outlet.js';
import { postManual, updateManualEntry, reverseJournalEntry, deleteManualEntry } from '../accounting/journalEngine.js';
import getAccountLedger from '../accounting/ledger.js';
import {
  buildJournalSearchClauses,
  escapeJournalSearchTerm,
  parseJournalSearchDate,
} from '../accounting/journalSearch.js';
import {
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getPayablesAging,
  getReceivablesAging,
} from '../accounting/financialReports.js';
import logger from '../utils/logger.js';
import {
  resolveTimezone,
  localDateRange,
  startOfLocalDayUtc,
  endOfLocalDayUtc,
  localDateStr,
} from '../utils/timezone.js';
import { ensureSystemParties } from '../services/systemParties.service.js';

// Reject malformed date query params before they reach the tz helpers. An
// unparseable string (e.g. ?asOf=garbage or ?asOf=2026-13-99) would otherwise
// build an Invalid Date and surface as a 500 with a leaked stack in non-prod,
// instead of a clean 400. Empty/absent values are allowed (handlers default them).
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDateStr = (s) => {
  if (typeof s !== 'string' || !DATE_STR_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const badDate = (res, field) =>
  res.status(400).json({ success: false, message: `Invalid ${field} date; expected YYYY-MM-DD.` });

// ═══════════════════════════════════════════════════════════════════════════════
// Chart of Accounts
// ═══════════════════════════════════════════════════════════════════════════════

// ─── listAccounts ─────────────────────────────────────────────────────────────
// GET /api/accounting/chart-of-accounts

export const listAccounts = async (req, res) => {
  const { type, isActive } = req.query;

  const filter = {};
  if (type)     filter.type     = type;
  if (isActive !== undefined) filter.isActive = isActive === 'true';

  const accounts = await ChartOfAccounts.find(filter)
    .sort({ code: 1 })
    .populate('parentAccount', 'code name')
    .lean();

  return res.json({ success: true, data: accounts });
};

// ─── createAccount ────────────────────────────────────────────────────────────
// POST /api/accounting/chart-of-accounts

export const createAccount = async (req, res) => {
  const existing = await ChartOfAccounts.findOne({ code: req.body.code }).lean();
  if (existing) {
    return res.status(409).json({
      success: false,
      message: `Account code '${req.body.code}' is already in use.`,
    });
  }

  const account = await ChartOfAccounts.create(req.body);
  logger.info(`Account created: ${account.code} — ${account.name} by user ${req.user.id}`);

  return res.status(201).json({ success: true, data: account });
};

// ─── updateAccount ────────────────────────────────────────────────────────────
// PUT /api/accounting/chart-of-accounts/:id

export const updateAccount = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid account ID.' });
  }

  const account = await ChartOfAccounts.findById(id);
  if (!account) {
    return res.status(404).json({ success: false, message: 'Account not found.' });
  }

  if (account.isSystemAccount) {
    return res.status(403).json({
      success: false,
      message: 'System accounts cannot be modified.',
    });
  }

  const updated = await ChartOfAccounts.findByIdAndUpdate(id, req.body, {
    returnDocument: 'after',
    runValidators: true,
  }).lean();

  logger.info(`Account updated: ${updated.code} by user ${req.user.id}`);
  return res.json({ success: true, data: updated });
};

// ─── deleteAccount ────────────────────────────────────────────────────────────
// DELETE /api/accounting/chart-of-accounts/:id  (soft delete: isActive false)

export const deleteAccount = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid account ID.' });
  }

  const account = await ChartOfAccounts.findById(id);
  if (!account) {
    return res.status(404).json({ success: false, message: 'Account not found.' });
  }

  if (account.isSystemAccount) {
    return res.status(403).json({
      success: false,
      message: 'System accounts cannot be deleted.',
    });
  }

  account.isActive = false;
  await account.save();

  logger.info(`Account deactivated: ${account.code} by user ${req.user.id}`);
  return res.json({ success: true, message: 'Account deactivated.', data: account });
};

// ─── hardDeleteAccount ────────────────────────────────────────────────────────
// DELETE /api/accounting/chart-of-accounts/:id/permanent  (permanent removal)
// Distinct from the soft-delete/deactivate above. Refuses to delete an account
// that is a system account, is referenced by any journal entry line, or has
// sub-accounts — deleting any of those would corrupt the ledger or the tree.

export const hardDeleteAccount = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid account ID.' });
  }

  const account = await ChartOfAccounts.findById(id);
  if (!account) {
    return res.status(404).json({ success: false, message: 'Account not found.' });
  }

  if (account.isSystemAccount) {
    return res.status(403).json({ success: false, message: 'System accounts cannot be deleted.' });
  }

  const referenced = await JournalEntry.exists({ 'lines.account': id });
  if (referenced) {
    return res.status(409).json({
      success: false,
      message: 'This account is used by journal entries and cannot be permanently deleted. Deactivate it instead.',
    });
  }

  const hasChildren = await ChartOfAccounts.exists({ parentAccount: id });
  if (hasChildren) {
    return res.status(409).json({
      success: false,
      message: 'This account has sub-accounts. Remove or reassign them before deleting.',
    });
  }

  await ChartOfAccounts.deleteOne({ _id: id });

  // Snapshot for the audit trail (logged on response finish).
  req.auditBefore = account.toObject();

  logger.info(`Account permanently deleted: ${account.code} — ${account.name} by user ${req.user.id}`);
  return res.json({ success: true, message: `Account "${account.name}" permanently deleted.` });
};

// ═══════════════════════════════════════════════════════════════════════════════
// Journal Entries
// ═══════════════════════════════════════════════════════════════════════════════

// ─── listJournalEntries ───────────────────────────────────────────────────────
// GET /api/accounting/journal-entries

export const listJournalEntries = async (req, res) => {
  const {
    page = 1,
    limit = 20,
    sourceModule,
    status,
    from,
    to,
    search,
    party,
    sortOrder = 'desc',
  } = req.query;

  if (from && !isValidDateStr(from)) return badDate(res, 'from');
  if (to   && !isValidDateStr(to))   return badDate(res, 'to');

  const pageNum  = Math.max(1, parseInt(page, 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const skip     = (pageNum - 1) * pageSize;

  const filter = {};
  if (sourceModule) filter.sourceModule = sourceModule;
  if (status)       filter.status       = status;
  // Search every user-facing part of an entry, including nested line notes,
  // accounts, amounts, source metadata, parties, creator/outlet, and the date.
  // Reference labels are resolved to IDs first because populate runs only after
  // Mongo has selected the JournalEntry documents.
  if (search && String(search).trim()) {
    const term = String(search).trim();
    const rx = new RegExp(escapeJournalSearchTerm(term), 'i');
    const [accountIds, creatorIds, vendorIds, outletIds] = await Promise.all([
      ChartOfAccounts.find({
        $or: [
          { code: rx },
          { name: rx },
          { type: rx },
          { subType: rx },
          { normalBalance: rx },
          { description: rx },
        ],
      }).distinct('_id'),
      User.find({ $or: [{ name: rx }, { email: rx }, { role: rx }] }).distinct('_id'),
      Vendor.find({ $or: [{ name: rx }, { code: rx }] }).distinct('_id'),
      Outlet.find({ $or: [{ name: rx }, { code: rx }] }).distinct('_id'),
    ]);

    let dateRange = null;
    const searchDate = parseJournalSearchDate(term);
    if (searchDate) {
      const tz = await resolveTimezone();
      dateRange = localDateRange(searchDate, searchDate, tz);
    }

    filter.$or = buildJournalSearchClauses(term, {
      accountIds,
      creatorIds,
      vendorIds,
      outletIds,
      objectId: mongoose.isValidObjectId(term) ? new mongoose.Types.ObjectId(term) : null,
      dateRange,
    });
  }

  // Party filter (same keys as AP Aging / the Ledger). `v:<vendorId>` matches
  // manual entries tagged with that vendor AND every entry whose SOURCE doc
  // (invoice/payment/GRN) belongs to it; `n:<name>` matches manual free-text
  // tags (never vendor-linked entries). Combined with any other clause via
  // top-level $and so it AND's with search/date/etc.
  if (party && String(party).trim()) {
    const key = String(party).trim();
    const or  = [];
    if (key.startsWith('v:') && mongoose.isValidObjectId(key.slice(2))) {
      const vid = new mongoose.Types.ObjectId(key.slice(2));
      or.push({ partyVendor: vid });
      const [purchaseIds, payIds] = await Promise.all([
        Purchase.find({ vendor: vid }).distinct('_id'),
        Payment.find({ vendor: vid }).distinct('_id'),
      ]);
      // Compatibility for payments recorded while a purchase had no vendor:
      // include payments whose now-vendor-linked purchase owns the settlement.
      const inheritedPayIds = purchaseIds.length
        ? await Payment.find({ vendor: null, purchase: { $in: purchaseIds } }).distinct('_id')
        : [];
      payIds.push(...inheritedPayIds);
      if (purchaseIds.length) or.push({ sourceModule: 'purchase', sourceId: { $in: purchaseIds } });
      if (payIds.length) or.push({ sourceModule: 'payment', sourceId: { $in: payIds } });
    } else if (key.startsWith('n:')) {
      const esc = key.slice(2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx  = new RegExp(`^${esc}$`, 'i');
      or.push({ partyVendor: null, party: rx });
    }
    // A recognised key that resolves to nothing must yield an EMPTY result (not
    // "all entries"), so fall back to an unsatisfiable clause.
    if (key.startsWith('v:') || key.startsWith('n:')) {
      filter.$and = [or.length ? { $or: or } : { _id: null }];
    }
  }
  // Interpret the yyyy-MM-dd from/to bounds in the tenant-default outlet tz so
  // the `date` window matches local business days, not the server clock.
  // Stored journal `date`s remain UTC — only the range bounds are derived in tz.
  if (from || to) {
    const tz = await resolveTimezone();
    filter.date = localDateRange(from, to, tz);
  }

  const sortDir = sortOrder === 'asc' ? 1 : -1;

  const [entries, total] = await Promise.all([
    JournalEntry.find(filter)
      .sort({ date: sortDir, entryNumber: sortDir })
      .skip(skip)
      .limit(pageSize)
      .populate('lines.account', 'code name type normalBalance')
      .populate('createdBy',     'name email')
      .populate('reversedBy',    'entryNumber date')
      .lean(),
    JournalEntry.countDocuments(filter),
  ]);

  return res.json({
    success: true,
    data: { entries, total, page: pageNum, pages: Math.ceil(total / pageSize) },
  });
};

// ─── getJournalEntryById ──────────────────────────────────────────────────────
// GET /api/accounting/journal-entries/:id

export const getJournalEntryById = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }

  const entry = await JournalEntry.findById(id)
    .populate('lines.account', 'code name type normalBalance')
    .populate('createdBy',     'name email')
    .populate('reversedBy',    'entryNumber date description')
    .lean();

  if (!entry) {
    return res.status(404).json({ success: false, message: 'Journal entry not found.' });
  }

  return res.json({ success: true, data: entry });
};

// ─── createJournalEntry ───────────────────────────────────────────────────────
// POST /api/accounting/journal-entries  (manual only)

// Save a typed free-text party into the reusable CustomParty list (so it shows in
// the party dropdown next time). Only for custom parties — vendors already live in
// the vendor list, so a partyVendor-tagged entry is skipped. Best-effort.
const recordCustomParty = async (party, partyVendor, userId) => {
  const name = (party ?? '').toString().trim();
  if (!name || partyVendor) return;
  try {
    await CustomParty.updateOne(
      { nameLower: name.toLowerCase() },
      { $setOnInsert: { name, nameLower: name.toLowerCase(), createdBy: userId ?? null } },
      { upsert: true },
    );
  } catch (err) {
    logger.warn(`[customParty] upsert skipped for "${name}": ${err.message}`);
  }
};

// ─── listCustomParties ────────────────────────────────────────────────────────
// GET /api/accounting/custom-parties

export const listCustomParties = async (req, res) => {
  // Tenant models are request-scoped. Loading the shared picker both persists
  // its defaults and backfills any historical source journals once.
  await ensureSystemParties();
  const parties = await CustomParty.find({})
    .sort({ isSystem: -1, name: 1 })
    .select('name isSystem')
    .lean();
  return res.json({ success: true, data: parties });
};

// ─── deleteCustomParty ────────────────────────────────────────────────────────
// DELETE /api/accounting/custom-parties/:id
// Removes a saved party from the reusable dropdown ONLY. It does NOT touch any
// journal entry or its AP-aging grouping — a manual entry stores its party as
// text on the entry (grouped by `n:<lc name>`), independent of this list. So a
// deleted party simply won't be offered for reuse next time; it can be re-typed
// on any entry to recreate it.
export const deleteCustomParty = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid party ID.' });
  }
  const existing = await CustomParty.findById(id).select('name isSystem').lean();
  if (!existing) return res.status(404).json({ success: false, message: 'Custom party not found.' });
  if (existing.isSystem) {
    return res.status(409).json({ success: false, message: 'System parties cannot be removed.' });
  }
  await CustomParty.deleteOne({ _id: id });
  return res.json({ success: true, data: { _id: id } });
};

// ─── updateCustomParty ────────────────────────────────────────────────────────
// PUT /api/accounting/custom-parties/:id  { name }
// Renames a saved party AND re-tags the manual journal entries that used the old
// free-text name (party text is denormalised onto each entry, and AP Aging / the
// party-filtered Ledger group by it), so the rename shows up end-to-end instead
// of orphaning the old-name group. Only free-text tags are touched — vendor-linked
// entries (partyVendor set) group under the vendor, never the text. A rename that
// collides (case-insensitively) with a different saved party is rejected so the
// unique `nameLower` key can't clash.
export const updateCustomParty = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid party ID.' });
  }
  const name = (req.body?.name ?? '').toString().trim();
  if (!name) return res.status(400).json({ success: false, message: 'Party name is required.' });

  const existing = await CustomParty.findById(id).lean();
  if (!existing) return res.status(404).json({ success: false, message: 'Custom party not found.' });
  if (existing.isSystem) {
    return res.status(409).json({ success: false, message: 'System parties cannot be renamed.' });
  }

  const nameLower = name.toLowerCase();
  const clash = await CustomParty.findOne({ nameLower, _id: { $ne: id } }).lean();
  if (clash) return res.status(409).json({ success: false, message: `A party named “${name}” already exists.` });

  const updated = await CustomParty.findByIdAndUpdate(
    id,
    { name, nameLower },
    { returnDocument: 'after' },
  ).select('name').lean();

  // Re-tag existing manual entries that carried the old free-text party so their
  // aging group + ledger filter follow the new name. Case-insensitive exact match
  // on the stored text; never touch vendor-linked entries.
  let retagged = 0;
  if (existing.nameLower !== nameLower) {
    const escaped = existing.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await JournalEntry.updateMany(
      { partyVendor: null, party: { $regex: `^${escaped}$`, $options: 'i' } },
      { $set: { party: name } },
    );
    retagged = result.modifiedCount ?? result.nModified ?? 0;
  }

  req.auditBefore = { name: existing.name };
  req.auditAfter  = { name, retaggedEntries: retagged };
  return res.json({ success: true, data: { ...updated, retagged } });
};

export const createJournalEntry = async (req, res) => {
  const entry = await postManual(req.body, req.user.id);

  await recordCustomParty(req.body.party, req.body.partyVendor, req.user.id);

  await entry.populate([
    { path: 'lines.account', select: 'code name type normalBalance' },
    { path: 'createdBy',     select: 'name email' },
  ]);

  return res.status(201).json({ success: true, data: entry });
};

// ─── updateJournalEntry ───────────────────────────────────────────────────────
// PUT /api/accounting/journal-entries/:id  (owner-only, manual entries only)

export const updateJournalEntry = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }

  // Snapshot the pre-edit state for the audit trail.
  const before = await JournalEntry.findById(id).lean();
  if (!before) {
    return res.status(404).json({ success: false, message: 'Journal entry not found.' });
  }

  const entry = await updateManualEntry(id, req.body, req.user.id);

  await recordCustomParty(req.body.party, req.body.partyVendor, req.user.id);

  await entry.populate([
    { path: 'lines.account', select: 'code name type normalBalance' },
    { path: 'createdBy',     select: 'name email' },
  ]);

  // Hand before/after snapshots to the audit middleware (logged on res finish).
  req.auditBefore = before;
  req.auditAfter  = entry.toObject();

  return res.json({
    success: true,
    message: `Journal entry ${entry.entryNumber} updated.`,
    data: entry,
  });
};

// ─── reverseEntry ─────────────────────────────────────────────────────────────
// POST /api/accounting/journal-entries/:id/reverse

export const reverseEntry = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }

  const entry = await JournalEntry.findById(id).select('salaryAdvance').lean();
  if (entry?.salaryAdvance) {
    return res.status(409).json({ success: false, message: 'This order is linked to payroll. Cancel or refund the POS order so its salary charge is also reversed.' });
  }
  const reversal = await reverseJournalEntry(id, req.user.id);

  await reversal.populate([
    { path: 'lines.account', select: 'code name type normalBalance' },
    { path: 'createdBy',     select: 'name email' },
  ]);

  return res.status(201).json({
    success: true,
    message: `Reversal entry ${reversal.entryNumber} created.`,
    data: reversal,
  });
};

// ─── deleteJournalEntry ───────────────────────────────────────────────────────
// DELETE /api/accounting/journal-entries/:id — manual entries only (guards live
// in deleteManualEntry). Needs accounting.deleteJournalEntry (off by default).

export const deleteJournalEntry = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }

  const deleted = await deleteManualEntry(id, req.user.id);

  // Snapshot the deleted entry for the audit trail (logged on res finish).
  req.auditBefore   = deleted.toObject();
  req.auditRecordId = deleted._id;

  return res.json({
    success: true,
    message: `Journal entry ${deleted.entryNumber} deleted.`,
    data: { _id: deleted._id, entryNumber: deleted.entryNumber },
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// Ledger & Reports
// ═══════════════════════════════════════════════════════════════════════════════

// ─── getLedger ────────────────────────────────────────────────────────────────
// GET /api/accounting/ledger/:accountId?from=&to=

export const getLedger = async (req, res) => {
  const { accountId } = req.params;
  const { from, to, party, partyName, scope } = req.query;

  // `accountId === 'all'` is the party-statement sentinel: no single account,
  // aggregate the party's lines across the requested AP/AR scope. It requires
  // a party.
  const isAll = accountId === 'all';
  if (!isAll && !mongoose.isValidObjectId(accountId)) {
    return res.status(400).json({ success: false, message: 'Invalid account ID.' });
  }
  if (isAll && !party) {
    return res.status(400).json({ success: false, message: 'A party is required for an all-accounts ledger.' });
  }
  if (scope && !['ap', 'ar'].includes(scope)) {
    return res.status(400).json({ success: false, message: 'Invalid ledger scope; expected ap or ar.' });
  }

  if (from && !isValidDateStr(from)) return badDate(res, 'from');
  if (to   && !isValidDateStr(to))   return badDate(res, 'to');

  // Resolve the yyyy-MM-dd bounds to UTC instants in the tenant-default outlet
  // tz, so the ledger window tracks local business days rather than the server
  // clock. Stored entry dates stay UTC; only the bound interpretation changes.
  const tz = await resolveTimezone();
  const fromUtc = from ? startOfLocalDayUtc(from, tz) : null;
  const toUtc   = to   ? endOfLocalDayUtc(to, tz)     : null;

  const result = await getAccountLedger(
    isAll ? null : accountId,
    fromUtc,
    toUtc,
    party || null,
    partyName || null,
    scope || 'ap',
  );
  return res.json({ success: true, data: result });
};

// ─── getTrialBalanceHandler ───────────────────────────────────────────────────
// GET /api/accounting/trial-balance?from=&to=

export const getTrialBalanceHandler = async (req, res) => {
  const { from, to } = req.query;
  if (from && !isValidDateStr(from)) return badDate(res, 'from');
  if (to   && !isValidDateStr(to))   return badDate(res, 'to');
  // Interpret the yyyy-MM-dd bounds in the tenant-default outlet tz.
  const tz = await resolveTimezone();
  const fromUtc = from ? startOfLocalDayUtc(from, tz) : null;
  const toUtc   = to   ? endOfLocalDayUtc(to, tz)     : null;
  const result = await getTrialBalance(fromUtc, toUtc);
  return res.json({ success: true, data: result });
};

// ─── getProfitAndLossHandler ──────────────────────────────────────────────────
// GET /api/accounting/profit-and-loss?from=&to=

export const getProfitAndLossHandler = async (req, res) => {
  const { from, to } = req.query;
  if (from && !isValidDateStr(from)) return badDate(res, 'from');
  if (to   && !isValidDateStr(to))   return badDate(res, 'to');
  // Interpret the yyyy-MM-dd bounds in the tenant-default outlet tz.
  const tz = await resolveTimezone();
  const fromUtc = from ? startOfLocalDayUtc(from, tz) : null;
  const toUtc   = to   ? endOfLocalDayUtc(to, tz)     : null;
  const result = await getProfitAndLoss(fromUtc, toUtc);
  return res.json({ success: true, data: result });
};

// ─── getBalanceSheetHandler ───────────────────────────────────────────────────
// GET /api/accounting/balance-sheet?asOf=

export const getBalanceSheetHandler = async (req, res) => {
  const { asOf } = req.query;
  if (asOf && !isValidDateStr(asOf)) return badDate(res, 'asOf');
  // The "as of" cut-off is a local end-of-day boundary; interpret it in the
  // tenant-default outlet tz. Default to local TODAY in tz when omitted.
  const tz = await resolveTimezone();
  const asOfUtc = endOfLocalDayUtc(asOf || localDateStr(new Date(), tz), tz);
  const result = await getBalanceSheet(asOfUtc);
  return res.json({ success: true, data: result });
};

// ─── getPayablesAgingHandler ──────────────────────────────────────────────────
// GET /api/accounting/ap-aging?asOf=

export const getPayablesAgingHandler = async (req, res) => {
  const { asOf } = req.query;
  if (asOf && !isValidDateStr(asOf)) return badDate(res, 'asOf');
  const tz = await resolveTimezone();
  const asOfUtc = endOfLocalDayUtc(asOf || localDateStr(new Date(), tz), tz);
  const result = await getPayablesAging(asOfUtc);
  return res.json({ success: true, data: result });
};

// ─── getReceivablesAgingHandler ──────────────────────────────────────────────
// GET /api/accounting/ar-aging?asOf=

export const getReceivablesAgingHandler = async (req, res) => {
  const { asOf } = req.query;
  if (asOf && !isValidDateStr(asOf)) return badDate(res, 'asOf');
  const tz = await resolveTimezone();
  const asOfUtc = endOfLocalDayUtc(asOf || localDateStr(new Date(), tz), tz);
  const result = await getReceivablesAging(asOfUtc);
  return res.json({ success: true, data: result });
};
