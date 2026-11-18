import mongoose from 'mongoose';
import ChartOfAccounts from '../models/ChartOfAccounts.js';
import JournalEntry    from '../models/JournalEntry.js';
import { buildPartyResolver, derivePartyName } from './partyResolver.js';
import { resolveApAccounts, resolveArAccounts } from './financialReports.js';

const r2 = (n) => parseFloat((n ?? 0).toFixed(2));

/**
 * getAccountLedger(accountId, from, to, party, partyName)
 *
 * Aggregates all posted JournalEntry lines for a single account in the given
 * date range and computes a running balance.
 *
 * Running balance direction:
 *   debit-normal  (assets, expenses): balance += debit - credit
 *   credit-normal (liabilities, equity, revenue): balance += credit - debit
 *
 * PARTY FILTER — when `party` (a party key: `v:<id>` | `n:<name>` | `unspecified`)
 * is given, only lines belonging to that party are shown and the balances are
 * computed over that subset. Two shapes:
 *   • accountId set  → the chosen account, filtered to the party (any account type).
 *   • accountId null → a cross-account "party statement": every line for the
 *     party across the requested AP/AR account scope. Its closing balance
 *     reconciles with the corresponding aging report for the same date.
 *
 * @param {string|ObjectId|null} accountId — null means all accounts in the selected scope
 * @param {Date|string|null} from  — inclusive start; null = all history
 * @param {Date|string|null} to    — inclusive end;   null = today
 * @param {string|null} party      — party key to filter by (optional)
 * @param {string|null} partyName  — display name fallback for the party (optional)
 * @returns {{ account, openingBalance, lines, closingBalance, period, party? }}
 */
const getAccountLedger = async (accountId, from, to, party = null, partyName = null, scope = 'ap') => {
  const fromDate = from ? new Date(from) : null;
  // The controller passes a pre-resolved end-of-day UTC instant (outlet tz).
  // Honor a Date as-is; only apply server-local end-of-day for legacy strings
  // or the no-arg "up to now" default.
  let toDate;
  if (to instanceof Date) {
    toDate = to;
  } else if (to) {
    toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
  } else {
    toDate = new Date();
  }

  if (party) {
    return getPartyLedger({ accountId, party, partyName, fromDate, toDate, scope });
  }

  const accountOid = new mongoose.Types.ObjectId(accountId);

  const account = await ChartOfAccounts.findById(accountOid).lean();
  if (!account) throw new Error(`Account ${accountId} not found.`);

  const isDebitNormal = account.normalBalance === 'debit';

  // ── Opening balance: all posted entries BEFORE fromDate ──────────────────

  let openingBalance = 0;

  if (fromDate) {
    const openingAgg = await JournalEntry.aggregate([
      { $match: { status: 'posted', date: { $lt: fromDate } } },
      { $unwind: '$lines' },
      { $match: { 'lines.account': accountOid } },
      {
        $group: {
          _id:          null,
          totalDebit:   { $sum: '$lines.debit' },
          totalCredit:  { $sum: '$lines.credit' },
        },
      },
    ]);

    if (openingAgg.length > 0) {
      const { totalDebit, totalCredit } = openingAgg[0];
      openingBalance = isDebitNormal
        ? r2(totalDebit - totalCredit)
        : r2(totalCredit - totalDebit);
    }
  }

  // ── In-range lines ────────────────────────────────────────────────────────

  const dateMatch = { status: 'posted' };
  if (fromDate || toDate) {
    dateMatch.date = {};
    if (fromDate) dateMatch.date.$gte = fromDate;
    if (toDate)   dateMatch.date.$lte = toDate;
  }

  const rawLines = await JournalEntry.aggregate([
    { $match: dateMatch },
    { $unwind: '$lines' },
    { $match: { 'lines.account': accountOid } },
    { $sort: { date: 1, entryNumber: 1, _id: 1 } },
    {
      $project: {
        _id:         0,
        date:        1,
        entryNumber: 1,
        description: 1,
        debit:       '$lines.debit',
        credit:      '$lines.credit',
        notes:       '$lines.notes',
        sourceModule:'$sourceModule',
        sourceId:    '$sourceId',
        sourcePath:  '$sourcePath',
        sourceNumber:'$sourceNumber',
      },
    },
  ]);

  // ── Compute running balance ────────────────────────────────────────────────

  let runningBalance = openingBalance;

  const lines = rawLines.map((line) => {
    const delta = isDebitNormal
      ? r2(line.debit - line.credit)
      : r2(line.credit - line.debit);
    runningBalance = r2(runningBalance + delta);

    return { ...line, runningBalance };
  });

  return {
    account,
    openingBalance,
    lines,
    closingBalance: runningBalance,
    period: {
      from: fromDate ?? null,
      to:   toDate,
    },
  };
};

/**
 * Party-filtered ledger. Pulls every posted line for the target account(s) up to
 * `toDate` (pre-`from` rows are needed to seed the party's opening balance),
 * resolves each line's party with the shared resolver, keeps only the requested
 * party, then computes a running balance over that subset.
 */
const getPartyLedger = async ({ accountId, party, partyName, fromDate, toDate, scope = 'ap' }) => {
  let account = null;   // real ChartOfAccounts doc when an account is chosen
  let targetOids;       // account _ids to include
  let isDebitNormal;
  let synthetic = false;
  let syntheticCode = scope === 'ar' ? 'AR' : 'AP';

  if (accountId) {
    account = await ChartOfAccounts.findById(new mongoose.Types.ObjectId(accountId)).lean();
    if (!account) throw new Error(`Account ${accountId} not found.`);
    targetOids   = [account._id];
    isDebitNormal = account.normalBalance === 'debit';
  } else {
    // Cross-account party statement for either payable or receivable heads.
    const scopedAccounts = scope === 'ar' ? await resolveArAccounts() : await resolveApAccounts();
    if (scopedAccounts.length === 0) {
      const name = partyName || derivePartyName(party);
      return {
        account: {
          _id: null,
          code: syntheticCode,
          name,
          type: scope === 'ar' ? 'asset' : 'liability',
          normalBalance: scope === 'ar' ? 'debit' : 'credit',
        },
        openingBalance: 0,
        lines: [],
        closingBalance: 0,
        period: { from: fromDate ?? null, to: toDate },
        party: { key: party, name },
      };
    }
    targetOids    = scopedAccounts.map((a) => a._id);
    isDebitNormal = scope === 'ar';
    synthetic     = true;
    syntheticCode = scopedAccounts.length === 1 ? (scopedAccounts[0].code ?? syntheticCode) : syntheticCode;
  }

  // Every posted line on the target account(s) up to `toDate`, oldest first.
  const rawRows = await JournalEntry.aggregate([
    { $match: { status: 'posted', date: { $lte: toDate } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: targetOids } } },
    { $sort: { date: 1, entryNumber: 1, _id: 1 } },
    {
      $project: {
        _id:          0,
        date:         1,
        entryNumber:  1,
        description:  1,
        debit:        '$lines.debit',
        credit:       '$lines.credit',
        notes:        '$lines.notes',
        sourceModule: 1,
        sourceId:     1,
        party:        1,
        partyVendor:  1,
        sourcePath:   1,
        sourceNumber: 1,
      },
    },
  ]);

  const partyOf = await buildPartyResolver(rawRows);
  const matched = rawRows.filter((row) => partyOf(row).key === party);

  // Prefer the resolver's exact-case name from a matched row; fall back to the
  // caller-supplied name, then a name derived from the key (empty-result case).
  const displayName = (matched.length ? partyOf(matched[0]).name : null)
    || partyName || derivePartyName(party);

  // Opening balance = net of matched rows strictly before `from`; the rest are the
  // in-range movements.
  let openingBalance = 0;
  const inRange = [];
  for (const row of matched) {
    const delta = isDebitNormal ? r2(row.debit - row.credit) : r2(row.credit - row.debit);
    if (fromDate && new Date(row.date) < fromDate) {
      openingBalance = r2(openingBalance + delta);
    } else {
      inRange.push({ row, delta });
    }
  }

  let runningBalance = openingBalance;
  const lines = inRange.map(({ row, delta }) => {
    runningBalance = r2(runningBalance + delta);
    return {
      date:         row.date,
      entryNumber:  row.entryNumber,
      description:  row.description,
      debit:        row.debit,
      credit:       row.credit,
      notes:        row.notes,
      sourceModule: row.sourceModule,
      sourceId:     row.sourceId,
      sourcePath:   row.sourcePath,
      sourceNumber: row.sourceNumber,
      runningBalance,
    };
  });

  const resultAccount = synthetic
    ? {
        _id: null,
        code: syntheticCode,
        name: displayName,
        type: scope === 'ar' ? 'asset' : 'liability',
        normalBalance: scope === 'ar' ? 'debit' : 'credit',
      }
    : account;

  return {
    account:        resultAccount,
    openingBalance,
    lines,
    closingBalance: runningBalance,
    period:         { from: fromDate ?? null, to: toDate },
    party:          { key: party, name: displayName },
  };
};

export default getAccountLedger;
