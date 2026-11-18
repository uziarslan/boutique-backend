export const getAdvanceDeletionBlockReason = (advance, hasSalaryRecovery = false) => {
  if (!advance) return 'Advance not found.';
  if (advance.voidedAt || advance.status === 'voided') {
    return 'A voided advance cannot be permanently deleted because it already has reversal history.';
  }
  if (Number(advance.recoveredAmount || 0) > 0 || hasSalaryRecovery) {
    return 'This advance has salary recovery activity. Void the related salary payment before deleting it.';
  }
  if ((advance.repayments || []).length > 0) {
    return 'This advance has repayment history and cannot be permanently deleted.';
  }
  return null;
};
