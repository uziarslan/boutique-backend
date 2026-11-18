import ChartOfAccounts from '../models/ChartOfAccounts.js';
import CustomParty from '../models/CustomParty.js';
import JournalEntry from '../models/JournalEntry.js';

export const SYSTEM_PARTIES = {
  foodPandaSales: { name: 'Food Panda Sales', nameLower: 'food panda sales' },
  salaryAdvance: { name: 'Salary Advance', nameLower: 'salary advance' },
};

// Persist the protected defaults and repair historical source-controlled
// journals that predate party tagging. All writes are idempotent.
export const ensureSystemParties = async () => {
  const defaults = Object.values(SYSTEM_PARTIES);
  await CustomParty.bulkWrite(defaults.map((party) => ({
    updateOne: {
      filter: { nameLower: party.nameLower },
      update: {
        $set: { ...party, isSystem: true },
        $setOnInsert: { createdBy: null },
      },
      upsert: true,
    },
  })));

  const accounts = await ChartOfAccounts.find({
    code: { $in: ['1110', '1102'] },
  }).select('_id code').lean();
  const byCode = Object.fromEntries(accounts.map((account) => [account.code, account._id]));
  const updates = [];

  if (byCode['1110']) {
    updates.push(JournalEntry.updateMany(
      {
        sourceModule: 'pos',
        'lines.account': byCode['1110'],
        party: { $ne: SYSTEM_PARTIES.foodPandaSales.name },
      },
      { $set: { party: SYSTEM_PARTIES.foodPandaSales.name } },
    ));
  }

  // Cash advances, CTS sales, repayments, voids, and their reversals all retain
  // sourceModule=salaryAdvance, so one source-safe update covers the full trail.
  updates.push(JournalEntry.updateMany(
    {
      sourceModule: 'salaryAdvance',
      party: { $ne: SYSTEM_PARTIES.salaryAdvance.name },
    },
    { $set: { party: SYSTEM_PARTIES.salaryAdvance.name } },
  ));

  // Payroll settlement/recovery journals use sourceModule=salary. Tag only
  // entries that actually credit the Salary Advance Receivable account.
  if (byCode['1102']) {
    updates.push(JournalEntry.updateMany(
      {
        sourceModule: 'salary',
        lines: {
          $elemMatch: {
            account: byCode['1102'],
            credit: { $gt: 0 },
          },
        },
        party: { $ne: SYSTEM_PARTIES.salaryAdvance.name },
      },
      { $set: { party: SYSTEM_PARTIES.salaryAdvance.name } },
    ));
  }

  const results = await Promise.all(updates);
  return {
    parties: defaults.length,
    journalsUpdated: results.reduce(
      (sum, result) => sum + (result.modifiedCount ?? result.nModified ?? 0),
      0,
    ),
  };
};

export default ensureSystemParties;
