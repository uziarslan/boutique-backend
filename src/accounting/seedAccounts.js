import ChartOfAccounts from '../models/ChartOfAccounts.js';
import logger from '../utils/logger.js';

/**
 * Default Chart of Accounts per plan.md.
 * All seeded accounts are isSystemAccount: true and cannot be modified or
 * deleted through the API.
 */
const DEFAULT_ACCOUNTS = [
  { code: '1001', name: 'Cash and Bank', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '1111', name: 'Shopify Clearing', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '1200', name: 'Inventory', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '2001', name: 'Accounts Payable', type: 'liability', subType: 'accountsPayable', normalBalance: 'credit' },
  { code: '2100', name: 'Accrued Expenses', type: 'liability', subType: 'currentLiability', normalBalance: 'credit' },
  { code: '2300', name: 'Sales Tax Payable', type: 'liability', subType: 'currentLiability', normalBalance: 'credit' },
  { code: '3001', name: 'Owner Equity', type: 'equity', subType: 'ownersEquity', normalBalance: 'credit' },
  { code: '3002', name: 'Retained Earnings', type: 'equity', subType: 'retainedEarnings', normalBalance: 'credit' },
  { code: '4001', name: 'Sales Revenue', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  // A POS sale is broken out into these heads (see postSale in journalEngine.js).
  // Delivery Charges & Service Charge are income; Discounts is a contra-revenue
  // account (debited, so it nets down revenue in the P&L).
  { code: '4004', name: 'Delivery Charges', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4005', name: 'Service Charge', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4006', name: 'Charge to Salary', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4007', name: 'Discounts', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '4008', name: 'Sales Returns and Allowances', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '2201', name: 'Boutique Store Credit Liability', type: 'liability', subType: 'currentLiability', normalBalance: 'credit' },
  { code: '5001', name: 'Cost of Goods Sold', type: 'expense', subType: 'costOfGoodsSold', normalBalance: 'debit' },
  { code: '5002', name: 'Purchase Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '5003', name: 'Waste and Spoilage', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '5004', name: 'Staff Allowance Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '1101', name: 'Staff Allowance Receivable', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '1110', name: 'Food Panda Receivable', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  { code: '5007', name: 'Food Panda Commission Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '6001', name: 'Rent Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '6002', name: 'Utilities Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '6003', name: 'Payroll Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
  { code: '1102', name: 'Salary Advance Receivable', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  // Advance Income Tax withheld by vendors/distributors (§236G/H) — a claimable
  // asset adjustable against income tax, NOT a purchase cost.
  { code: '1103', name: 'Advance Income Tax', type: 'asset', subType: 'currentAsset', normalBalance: 'debit' },
  // Membership / Rewards programme
  { code: '2200', name: 'Membership Rewards Liability', type: 'liability', subType: 'currentLiability', normalBalance: 'credit' },
  { code: '4003', name: 'Membership Rewards Breakage', type: 'revenue', subType: 'operatingRevenue', normalBalance: 'credit' },
  { code: '5005', name: 'Membership Rewards Expense', type: 'expense', subType: 'operatingExpense', normalBalance: 'debit' },
];

/**
 * Upserts all default accounts so new system accounts added in later releases
 * are always present, even on existing databases.
 * Called once after MongoDB connects during server startup.
 */
const seedAccounts = async () => {
  try {
    const ops = DEFAULT_ACCOUNTS.map((a) => {
      const desired = { ...a, isSystemAccount: true, isActive: true };
      return {
        updateOne: {
          filter: { code: a.code },
          // 4006 existed as a user-created "CTS Sales" head in the original
          // tenant. It is now a first-class system account, so normalize that
          // one code as well as creating it for new tenants. Other historical
          // accounts retain the seed's usual insert-only behavior.
          update: a.code === '4006'
            ? { $set: desired }
            : { $setOnInsert: desired },
          upsert: true,
        },
      };
    });

    const result = await ChartOfAccounts.bulkWrite(ops, { ordered: false });
    const inserted = result.upsertedCount ?? 0;

    if (inserted > 0) {
      logger.info(`Chart of Accounts: ${inserted} new system account(s) inserted.`);
    } else {
      logger.info('Chart of Accounts already up to date. No new system accounts needed.');
    }
  } catch (err) {
    logger.error(`Failed to seed Chart of Accounts: ${err.message}`);
    throw err;
  }
};

export default seedAccounts;
