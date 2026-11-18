import ChartOfAccounts from '../models/ChartOfAccounts.js';
import JournalEntry    from '../models/JournalEntry.js';
import Payment         from '../models/Payment.js';
import { buildPartyResolver } from './partyResolver.js';

const r2 = (n) => parseFloat((n ?? 0).toFixed(2));
const EPS = 0.01; // tolerance for balance-sheet isBalanced check
const DAY = 24 * 60 * 60 * 1000;

const emptyAgingBuckets = () => ({ current: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0 });
const agingBucketOf = (ageDays) => {
  if (ageDays <= 30) return 'current';
  if (ageDays <= 60) return 'd31_60';
  if (ageDays <= 90) return 'd61_90';
  return 'd90_plus';
};

// ─── Internal: aggregate debits+credits per account in a date window ─────────

const aggregateByAccount = async (dateMatch, typeFilter = null) => {
  // Include INACTIVE accounts too: a deactivated account (e.g. the retired
  // Beverage Sales Revenue) may still carry historical postings, and dropping it
  // here would leave its debits/credits unmatched — unbalancing the Trial Balance
  // and understating past P&L. Rows are driven by posted JournalEntry lines below,
  // so inactive accounts with no activity never appear.
  const accountMatch = typeFilter
    ? await ChartOfAccounts.find({ type: { $in: typeFilter } }).lean()
    : await ChartOfAccounts.find({}).lean();

  const accountIds = accountMatch.map((a) => a._id);
  const byId       = Object.fromEntries(accountMatch.map((a) => [a._id.toString(), a]));

  const rows = await JournalEntry.aggregate([
    { $match: { status: 'posted', ...dateMatch } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: accountIds } } },
    {
      $group: {
        _id:         '$lines.account',
        totalDebit:  { $sum: '$lines.debit'  },
        totalCredit: { $sum: '$lines.credit' },
      },
    },
  ]);

  return rows.map((row) => {
    const acct = byId[row._id.toString()];
    return {
      accountId:    row._id,
      code:         acct?.code,
      name:         acct?.name,
      type:         acct?.type,
      normalBalance:acct?.normalBalance,
      totalDebit:   r2(row.totalDebit),
      totalCredit:  r2(row.totalCredit),
    };
  });
};

// ─── getTrialBalance ──────────────────────────────────────────────────────────
// Returns all accounts with net activity in the period.
// balance column uses the account's normalBalance direction.

export const getTrialBalance = async (from, to) => {
  const dateMatch = buildDateMatch(from, to);
  const rows      = await aggregateByAccount(dateMatch);

  let totalDebit = 0, totalCredit = 0;

  const accounts = rows
    .map((row) => {
      const balance = row.normalBalance === 'debit'
        ? r2(row.totalDebit - row.totalCredit)
        : r2(row.totalCredit - row.totalDebit);

      totalDebit  = r2(totalDebit  + row.totalDebit);
      totalCredit = r2(totalCredit + row.totalCredit);

      return { ...row, balance };
    })
    .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));

  return {
    accounts,
    totals: {
      totalDebit,
      totalCredit,
      isBalanced: Math.abs(totalDebit - totalCredit) < EPS,
    },
    period: { from: from ?? null, to: to ?? null },
  };
};

// ─── getProfitAndLoss ─────────────────────────────────────────────────────────

export const getProfitAndLoss = async (from, to) => {
  const dateMatch = buildDateMatch(from, to);
  const rows      = await aggregateByAccount(dateMatch, ['revenue', 'expense']);

  const revenue  = [];
  const expenses = [];

  for (const row of rows) {
    if (row.type === 'revenue') {
      // credit-normal: positive amount = revenue earned
      revenue.push({
        accountId: row.accountId,
        code:   row.code,
        name:   row.name,
        amount: r2(row.totalCredit - row.totalDebit),
      });
    } else {
      // debit-normal: positive amount = expense incurred
      expenses.push({
        accountId: row.accountId,
        code:   row.code,
        name:   row.name,
        amount: r2(row.totalDebit - row.totalCredit),
      });
    }
  }

  revenue.sort( (a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  expenses.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));

  const totalRevenue  = r2(revenue.reduce( (s, r) => s + r.amount, 0));
  const totalExpenses = r2(expenses.reduce((s, e) => s + e.amount, 0));

  return {
    revenue,
    totalRevenue,
    expenses,
    totalExpenses,
    netProfit: r2(totalRevenue - totalExpenses),
    period:    { from: from ?? null, to: to ?? null },
  };
};

// ─── getBalanceSheet ──────────────────────────────────────────────────────────
// Sums ALL posted entries up to asOf date (no from filter).

export const getBalanceSheet = async (asOf) => {
  const asOfDate = asOf ? new Date(asOf) : new Date();
  asOfDate.setHours(23, 59, 59, 999);

  const dateMatch = { date: { $lte: asOfDate } };
  const rows      = await aggregateByAccount(dateMatch, ['asset', 'liability', 'equity']);

  const assets      = [];
  const liabilities = [];
  const equity      = [];

  for (const row of rows) {
    const amount = row.normalBalance === 'debit'
      ? r2(row.totalDebit  - row.totalCredit)
      : r2(row.totalCredit - row.totalDebit);

    const entry = { accountId: row.accountId, code: row.code, name: row.name, amount };

    if (row.type === 'asset')     assets.push(entry);
    else if (row.type === 'liability') liabilities.push(entry);
    else                          equity.push(entry);
  }

  const sort = (arr) => arr.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  sort(assets); sort(liabilities); sort(equity);

  const totalAssets      = r2(assets.reduce(     (s, a) => s + a.amount, 0));
  const totalLiabilities = r2(liabilities.reduce((s, a) => s + a.amount, 0));
  const totalEquity      = r2(equity.reduce(     (s, a) => s + a.amount, 0));

  return {
    assets,
    totalAssets,
    liabilities,
    totalLiabilities,
    equity,
    totalEquity,
    isBalanced: Math.abs(totalAssets - r2(totalLiabilities + totalEquity)) < EPS,
    asOf:       asOfDate,
  };
};

// ─── getPayablesAging ─────────────────────────────────────────────────────────
// Accounts-Payable aging from the posted ledger. Payable accounts are the active
// liability accounts that are themselves a payable (name matches /payable/i or
// subType === 'accountsPayable') or a child of one. The ledger has no due dates
// or bill↔payment links, so outstanding amounts are derived by FIFO open-item:
// within each account every CREDIT is a bill and every DEBIT (payment/write-off)
// is applied to the OLDEST open bill first. Whatever credit is still open is aged
// by its own date (asOf − entry date) into a bucket. Mirror of getReceivablesAging
// but credit-normal (bills are credits, payments are debits).

// Resolve the set of payable accounts. Vendor payables are identified by the
// 'accountsPayable' subType (the seeded 2001 Accounts Payable, plus any
// user-created AP account that sets it), together with any liability sub-account
// whose parent is such an AP account. We deliberately do NOT use a /payable/i name
// heuristic — that would sweep in statutory/payroll liabilities like "Sales Tax
// Payable" or "Salaries Payable" and inflate the aging. Inactive accounts are
// still resolved so open bills under a soft-deleted AP account (or a deactivated
// parent) continue to age. Shared with the party-filtered Ledger.
export const resolveApAccounts = async () => {
  const liabilities = await ChartOfAccounts.find({ type: 'liability' }).lean();
  const isPrimary   = (a) => a.subType === 'accountsPayable';
  const primaryIds  = new Set(liabilities.filter(isPrimary).map((a) => a._id.toString()));
  return liabilities.filter(
    (a) => isPrimary(a) || (a.parentAccount && primaryIds.has(a.parentAccount.toString())),
  );
};

// Receivable accounts are debit-normal assets whose subtype explicitly marks
// them as AR, whose name identifies them as a receivable (covering the seeded
// customer, staff, salary-advance, and delivery-platform heads), or whose parent
// is one of those accounts. Inactive heads remain included so historical open
// balances do not disappear from the report.
export const resolveArAccounts = async () => {
  const assets = await ChartOfAccounts.find({ type: 'asset' }).lean();
  const isPrimary = (a) => a.subType === 'accountsReceivable' || /receivable/i.test(a.name ?? '');
  const primaryIds = new Set(assets.filter(isPrimary).map((a) => a._id.toString()));
  return assets.filter(
    (a) => isPrimary(a) || (a.parentAccount && primaryIds.has(a.parentAccount.toString())),
  );
};

export const getPayablesAging = async (asOf) => {
  const asOfDate = asOf instanceof Date ? asOf : (asOf ? new Date(asOf) : new Date());

  // 1. Resolve the set of payable accounts.
  const apAccounts = await resolveApAccounts();

  if (apAccounts.length === 0) {
    return { asOf: asOfDate, accounts: [], parties: [], items: [], buckets: emptyAgingBuckets(), totalOutstanding: 0 };
  }

  const apIds = apAccounts.map((a) => a._id);
  const byId  = Object.fromEntries(apAccounts.map((a) => [a._id.toString(), a]));

  // 2. Pull every posted AP line up to asOf, oldest first.
  const rows = await JournalEntry.aggregate([
    { $match: { status: 'posted', date: { $lte: asOfDate } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: apIds } } },
    { $sort: { date: 1, entryNumber: 1, _id: 1 } },
    {
      $project: {
        _id:         0,
        account:     '$lines.account',
        date:        1,
        entryNumber: 1,
        description: 1,
        notes:       '$lines.notes',
        debit:       '$lines.debit',
        credit:      '$lines.credit',
        sourceModule: 1,
        sourceId:     1,
        party:        1,
        partyVendor:  1,
      },
    },
  ]);

  // 3a. Resolve a PARTY (vendor) for every AP line. The vendor comes from the
  //     SOURCE document (purchase/payment documents carry a vendor ref); manual
  //     entries with no vendor link fall back to the tag/notes, else 'Unspecified'.
  //     Shared with the party-filtered Ledger so the two views group identically.
  const partyOf = await buildPartyResolver(rows);

  // 3a-ii. Map each payment → the purchase it was recorded against, so a payment
  //     settles THAT specific bill (below) instead of blindly the oldest one.
  //     Every Payment carries a required purchase ref; the purchase's AP credit
  //     and payment debit can therefore be matched directly.
  const paymentSrcIds = [...new Set(
    rows.filter((r) => r.sourceModule === 'payment' && r.sourceId).map((r) => r.sourceId.toString()),
  )];
  const paymentDocs = paymentSrcIds.length
    ? await Payment.find({ _id: { $in: paymentSrcIds } }).select('purchase').lean()
    : [];
  const paymentPurchase = new Map(); // paymentId(str) → purchaseId(str)
  for (const p of paymentDocs) if (p.purchase) paymentPurchase.set(p._id.toString(), p.purchase.toString());

  // 3b. Open-item matching, per (account + PARTY) — so one vendor's payment can't
  //     settle another vendor's bill. A payment first settles the specific purchase
  //     it was recorded against; any remainder (and every unlinked debit/write-off)
  //     then falls back to oldest-first FIFO. Rows keep the global date-asc order
  //     from the aggregation, so each group is chronological.
  const perGroup = new Map();
  for (const row of rows) {
    const party = partyOf(row);
    const gkey = `${row.account.toString()}::${party.key}`;
    if (!perGroup.has(gkey)) perGroup.set(gkey, { accountId: row.account.toString(), party, rows: [] });
    perGroup.get(gkey).rows.push(row);
  }

  const items = [];
  for (const grp of perGroup.values()) {
    const accRows = grp.rows;
    const acctId  = grp.accountId;
    const party   = grp.party;
    const open  = []; // FIFO queue of unsettled bills (credits)
    let prepaid = 0;  // unapplied debit carried forward (vendor prepayment / overpayment)

    for (const row of accRows) {
      if ((row.credit ?? 0) > 0) {
        // A prior prepayment (net debit balance) settles this new bill first,
        // before any remainder can age.
        let remaining = r2(row.credit);
        if (prepaid > EPS) {
          const applied = Math.min(prepaid, remaining);
          remaining = r2(remaining - applied);
          prepaid   = r2(prepaid - applied);
        }
        if (remaining > EPS) {
          open.push({
            date:        row.date,
            entryNumber: row.entryNumber,
            description: row.description,
            notes:       row.notes,
            original:    r2(row.credit),
            remaining,
            // The purchase this bill represents (for targeted payment settlement).
            purchaseId:  (row.sourceModule === 'purchase' && row.sourceId) ? row.sourceId.toString() : null,
          });
        }
      }

      let debit = r2(row.debit ?? 0);

      // Targeted settlement clears that purchase's open bill first, regardless
      // of age, so only genuinely unpaid purchases keep aging.
      const targetPurchaseId = (row.sourceModule === 'payment' && row.sourceId)
        ? paymentPurchase.get(row.sourceId.toString())
        : null;
      if (targetPurchaseId && debit > 0) {
        const idx = open.findIndex((o) => o.purchaseId === targetPurchaseId);
        if (idx !== -1) {
          const bill    = open[idx];
          const applied = Math.min(bill.remaining, debit);
          bill.remaining = r2(bill.remaining - applied);
          debit          = r2(debit - applied);
          if (bill.remaining <= EPS) open.splice(idx, 1);
        }
      }

      // Any remaining debit (a manual payment/write-off, an overpayment, or a
      // payment whose purchase bill isn't open here) applies to the oldest open
      // bills first. Guard on `> 0` (not `> EPS`) so a legit one-cent payment lands.
      while (debit > 0 && open.length > 0) {
        const head = open[0];
        if (head.remaining <= debit + EPS) {
          debit = r2(debit - head.remaining);
          open.shift();
        } else {
          head.remaining = r2(head.remaining - debit);
          debit = 0;
        }
      }
      // Payment left over after clearing every open bill carries forward to
      // offset future bills (and, if still unspent, surfaces below).
      if (debit > 0) prepaid = r2(prepaid + debit);
    }

    const acct = byId[acctId];
    for (const o of open) {
      if (o.remaining <= EPS) continue;
      const ageDays = Math.max(0, Math.floor((asOfDate - new Date(o.date)) / DAY));
      const bucket  = agingBucketOf(ageDays);
      items.push({
        accountId:      acctId,
        accountCode:    acct?.code,
        accountName:    acct?.name,
        partyKey:       party.key,
        party:          party.name,
        date:           o.date,
        entryNumber:    o.entryNumber,
        description:    o.description,
        notes:          o.notes,
        originalAmount: o.original,
        openAmount:     o.remaining,
        ageDays,
        bucket,
      });
    }

    // A residual prepayment means this AP account carries a net DEBIT balance
    // (paid more than billed — a vendor advance). Surface it as a negative
    // "current" item so the buckets and total reconcile with the account's GL
    // balance on the Balance Sheet / Trial Balance instead of silently vanishing.
    if (prepaid > EPS) {
      items.push({
        accountId:      acctId,
        accountCode:    acct?.code,
        accountName:    acct?.name,
        partyKey:       party.key,
        party:          party.name,
        date:           null,
        entryNumber:    null,
        description:    'Vendor prepayment (net debit balance)',
        notes:          null,
        originalAmount: r2(-prepaid),
        openAmount:     r2(-prepaid),
        ageDays:        0,
        bucket:         'current',
      });
    }
  }

  // 4. Roll up: per-account matrix + per-PARTY matrix + bucket totals.
  const buckets     = emptyAgingBuckets();
  const accountsMap = new Map();
  const partiesMap  = new Map();

  for (const it of items) {
    buckets[it.bucket] = r2(buckets[it.bucket] + it.openAmount);
    buckets.total      = r2(buckets.total + it.openAmount);

    if (!partiesMap.has(it.partyKey)) {
      partiesMap.set(it.partyKey, { partyKey: it.partyKey, party: it.party, ...emptyAgingBuckets() });
    }
    const p = partiesMap.get(it.partyKey);
    p[it.bucket] = r2(p[it.bucket] + it.openAmount);
    p.total      = r2(p.total + it.openAmount);

    if (!accountsMap.has(it.accountId)) {
      accountsMap.set(it.accountId, {
        accountId: it.accountId,
        code:      it.accountCode,
        name:      it.accountName,
        ...emptyAgingBuckets(),
      });
    }
    const a = accountsMap.get(it.accountId);
    a[it.bucket] = r2(a[it.bucket] + it.openAmount);
    a.total      = r2(a.total + it.openAmount);
  }

  items.sort((a, b) => b.ageDays - a.ageDays); // oldest debts first
  const accounts = [...accountsMap.values()].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  // Parties sorted by most-owed first (biggest outstanding balance at the top).
  const parties = [...partiesMap.values()].sort((a, b) => b.total - a.total);

  return { asOf: asOfDate, accounts, parties, items, buckets, totalOutstanding: buckets.total };
};

// ─── getReceivablesAging ─────────────────────────────────────────────────────
// Debit-normal mirror of AP aging. Each debit opens a receivable and subsequent
// credits (cash receipts, payroll recovery, settlement, or write-off) clear the
// oldest open item for the same account + party. A credit left after all items
// are cleared is shown as a negative current customer credit so the report keeps
// reconciling to the general ledger.
export const getReceivablesAging = async (asOf) => {
  const asOfDate = asOf instanceof Date ? asOf : (asOf ? new Date(asOf) : new Date());
  const arAccounts = await resolveArAccounts();

  if (arAccounts.length === 0) {
    return { asOf: asOfDate, accounts: [], parties: [], items: [], buckets: emptyAgingBuckets(), totalOutstanding: 0 };
  }

  const arIds = arAccounts.map((a) => a._id);
  const byId = Object.fromEntries(arAccounts.map((a) => [a._id.toString(), a]));
  const rows = await JournalEntry.aggregate([
    { $match: { status: 'posted', date: { $lte: asOfDate } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: arIds } } },
    { $sort: { date: 1, entryNumber: 1, _id: 1 } },
    {
      $project: {
        _id: 0,
        account: '$lines.account',
        date: 1,
        entryNumber: 1,
        description: 1,
        notes: '$lines.notes',
        debit: '$lines.debit',
        credit: '$lines.credit',
        sourceModule: 1,
        sourceId: 1,
        party: 1,
        partyVendor: 1,
      },
    },
  ]);

  const partyOf = await buildPartyResolver(rows);
  const perGroup = new Map();
  for (const row of rows) {
    const party = partyOf(row);
    const gkey = `${row.account.toString()}::${party.key}`;
    if (!perGroup.has(gkey)) perGroup.set(gkey, { accountId: row.account.toString(), party, rows: [] });
    perGroup.get(gkey).rows.push(row);
  }

  const items = [];
  for (const grp of perGroup.values()) {
    const open = [];
    let customerCredit = 0;

    for (const row of grp.rows) {
      if ((row.debit ?? 0) > 0) {
        let remaining = r2(row.debit);
        if (customerCredit > EPS) {
          const applied = Math.min(customerCredit, remaining);
          remaining = r2(remaining - applied);
          customerCredit = r2(customerCredit - applied);
        }
        if (remaining > EPS) {
          open.push({
            date: row.date,
            entryNumber: row.entryNumber,
            description: row.description,
            notes: row.notes,
            original: r2(row.debit),
            remaining,
          });
        }
      }

      let credit = r2(row.credit ?? 0);
      while (credit > 0 && open.length > 0) {
        const head = open[0];
        if (head.remaining <= credit + EPS) {
          credit = r2(credit - head.remaining);
          open.shift();
        } else {
          head.remaining = r2(head.remaining - credit);
          credit = 0;
        }
      }
      if (credit > 0) customerCredit = r2(customerCredit + credit);
    }

    const acct = byId[grp.accountId];
    for (const o of open) {
      if (o.remaining <= EPS) continue;
      const ageDays = Math.max(0, Math.floor((asOfDate - new Date(o.date)) / DAY));
      items.push({
        accountId: grp.accountId,
        accountCode: acct?.code,
        accountName: acct?.name,
        partyKey: grp.party.key,
        party: grp.party.name,
        date: o.date,
        entryNumber: o.entryNumber,
        description: o.description,
        notes: o.notes,
        originalAmount: o.original,
        openAmount: o.remaining,
        ageDays,
        bucket: agingBucketOf(ageDays),
      });
    }

    if (customerCredit > EPS) {
      items.push({
        accountId: grp.accountId,
        accountCode: acct?.code,
        accountName: acct?.name,
        partyKey: grp.party.key,
        party: grp.party.name,
        date: null,
        entryNumber: null,
        description: 'Customer credit (net credit balance)',
        notes: null,
        originalAmount: r2(-customerCredit),
        openAmount: r2(-customerCredit),
        ageDays: 0,
        bucket: 'current',
      });
    }
  }

  const buckets = emptyAgingBuckets();
  const accountsMap = new Map();
  const partiesMap = new Map();
  for (const it of items) {
    buckets[it.bucket] = r2(buckets[it.bucket] + it.openAmount);
    buckets.total = r2(buckets.total + it.openAmount);

    if (!partiesMap.has(it.partyKey)) {
      partiesMap.set(it.partyKey, { partyKey: it.partyKey, party: it.party, ...emptyAgingBuckets() });
    }
    const p = partiesMap.get(it.partyKey);
    p[it.bucket] = r2(p[it.bucket] + it.openAmount);
    p.total = r2(p.total + it.openAmount);

    if (!accountsMap.has(it.accountId)) {
      accountsMap.set(it.accountId, {
        accountId: it.accountId,
        code: it.accountCode,
        name: it.accountName,
        ...emptyAgingBuckets(),
      });
    }
    const a = accountsMap.get(it.accountId);
    a[it.bucket] = r2(a[it.bucket] + it.openAmount);
    a.total = r2(a.total + it.openAmount);
  }

  items.sort((a, b) => b.ageDays - a.ageDays);
  const accounts = [...accountsMap.values()].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''));
  const parties = [...partiesMap.values()].sort((a, b) => b.total - a.total);
  return { asOf: asOfDate, accounts, parties, items, buckets, totalOutstanding: buckets.total };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDateMatch(from, to) {
  // The controller now passes pre-resolved UTC Date instants (outlet-tz day
  // bounds). Honor those exactly. Only fall back to server-local start/end-of-day
  // for legacy string callers.
  const match = {};
  if (from || to) {
    match.date = {};
    if (from) {
      if (from instanceof Date) {
        match.date.$gte = from;
      } else {
        const f = new Date(from);
        f.setHours(0, 0, 0, 0);
        match.date.$gte = f;
      }
    }
    if (to) {
      if (to instanceof Date) {
        match.date.$lte = to;
      } else {
        const t = new Date(to);
        t.setHours(23, 59, 59, 999);
        match.date.$lte = t;
      }
    }
  }
  return match;
}
