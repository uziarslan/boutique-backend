import { Router } from 'express';
import {
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  hardDeleteAccount,
  listJournalEntries,
  getJournalEntryById,
  createJournalEntry,
  updateJournalEntry,
  reverseEntry,
  deleteJournalEntry,
  listCustomParties,
  deleteCustomParty,
  updateCustomParty,
  getLedger,
  getTrialBalanceHandler,
  getProfitAndLossHandler,
  getBalanceSheetHandler,
  getPayablesAgingHandler,
  getReceivablesAgingHandler,
} from '../controllers/accounting.controller.js';
import protect from '../middleware/auth.middleware.js';
import requirePermission from '../middleware/permission.middleware.js';
import auditLog from '../middleware/audit.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import { getOrderSalaryChargeContext, getOrderSalaryCreditSummary, chargeJournalOrderToSalary } from '../controllers/orderSalaryCharge.controller.js';
import {
  validate,
  createAccountSchema,
  updateAccountSchema,
  createJournalEntrySchema,
  updateJournalEntrySchema,
  orderSalaryChargeSchema,
} from '../validators/accounting.validator.js';

const router = Router();

router.use(protect);

// Accounting endpoints are guarded by fine-grained permissions so per-user
// overrides can grant access without requiring a role change.

// ─── Chart of Accounts ────────────────────────────────────────────────────────

router.get('/chart-of-accounts', requirePermission('accounting.coa'), listAccounts);

router.post(
  '/chart-of-accounts',
  requirePermission('accounting.coa'),
  validate(createAccountSchema),
  auditLog('ChartOfAccounts', 'CREATE'),
  createAccount
);

// Editing an account needs accounting.editAccount (off by default; owner grants
// it per user in Role Settings). Create/deactivate remain on accounting.coa.
router.put(
  '/chart-of-accounts/:id',
  requirePermission('accounting.editAccount'),
  validate(updateAccountSchema),
  auditLog('ChartOfAccounts', 'UPDATE'),
  updateAccount
);

// Soft delete (deactivate) — accounting.coa.
router.delete(
  '/chart-of-accounts/:id',
  requirePermission('accounting.coa'),
  auditLog('ChartOfAccounts', 'DELETE'),
  deleteAccount
);

// Permanent delete — accounting.deleteAccount (off by default; owner grants it).
router.delete(
  '/chart-of-accounts/:id/permanent',
  requirePermission('accounting.deleteAccount'),
  auditLog('ChartOfAccounts', 'HARD_DELETE'),
  hardDeleteAccount
);

// ─── Journal Entries ──────────────────────────────────────────────────────────

// Reusable custom-party list for the manual-entry party picker.
router.get('/custom-parties', requirePermission('accounting.journalEntries'), listCustomParties);
router.put(
  '/custom-parties/:id',
  requirePermission('accounting.journalEntries'),
  auditLog('CustomParty', 'UPDATE'),
  updateCustomParty,
);
router.delete(
  '/custom-parties/:id',
  requirePermission('accounting.journalEntries'),
  auditLog('CustomParty', 'DELETE'),
  deleteCustomParty,
);

router.get('/journal-entries', requirePermission('accounting.journalEntries'), listJournalEntries);
router.get('/journal-entries/:id', requirePermission('accounting.journalEntries'), getJournalEntryById);

const salaryChargeAccess = [requireFeature('payroll'), requirePermission('accounting.editJournalEntry'), requirePermission('salaries.manage')];
router.get('/journal-entries/:id/charge-to-salary', ...salaryChargeAccess, getOrderSalaryChargeContext);
router.get('/salary-charge/employees/:employeeId/credit-summary', ...salaryChargeAccess, getOrderSalaryCreditSummary);
router.post('/journal-entries/:id/charge-to-salary', ...salaryChargeAccess, validate(orderSalaryChargeSchema), chargeJournalOrderToSalary);

router.post(
  '/journal-entries',
  requirePermission('accounting.journals'),
  validate(createJournalEntrySchema),
  auditLog('JournalEntry', 'CREATE'),
  createJournalEntry
);

// Editing a posted entry needs accounting.editJournalEntry. Manual entries keep
// full editing except invoice/payment entries, which remain source-value locked.
router.put(
  '/journal-entries/:id',
  requirePermission('accounting.editJournalEntry'),
  validate(updateJournalEntrySchema),
  auditLog('JournalEntry', 'UPDATE'),
  updateJournalEntry
);

router.post(
  '/journal-entries/:id/reverse',
  requirePermission('accounting.journals'),
  auditLog('JournalEntry', 'REVERSE'),
  reverseEntry
);

// Hard-delete a MANUAL entry (guards in deleteManualEntry). Off by default;
// owner grants accounting.deleteJournalEntry per user in Role Settings.
router.delete(
  '/journal-entries/:id',
  requirePermission('accounting.deleteJournalEntry'),
  auditLog('JournalEntry', 'DELETE'),
  deleteJournalEntry
);

// ─── Reports ──────────────────────────────────────────────────────────────────

router.get('/ledger/:accountId', requirePermission('accounting.ledger'), getLedger);
router.get('/trial-balance', requirePermission('accounting.reports'), getTrialBalanceHandler);
router.get('/profit-and-loss', requirePermission('accounting.reports'), getProfitAndLossHandler);
router.get('/balance-sheet', requirePermission('accounting.reports'), getBalanceSheetHandler);
router.get('/ap-aging', requirePermission('accounting.apAging'), getPayablesAgingHandler);
router.get('/ar-aging', requirePermission('accounting.arAging'), getReceivablesAgingHandler);

export default router;
